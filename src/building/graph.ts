/**
 * @license
 * Copyright 2022-2026 Greg Lauckhart <greg@lauckhart.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import colors from "ansi-colors";
import { JsonNotFoundError, Package } from "../util/package.js";
import { Progress } from "../util/progress.js";
import { InternalBuildError } from "./error.js";
import { ProjectBuilder, Target } from "./project-builder.js";
import { BUILD_INFO_LOCATION, BuildInformation, Project } from "./project.js";
import { TsgoResult, tsgoSolutionBuild } from "./typescript/tsgo.js";

/**
 * Graph of dependencies for workspace packages.
 *
 * We use this information to determine which packages are "dirty" and need rebuild.  In the future we can also use for
 * parallel build, only tricky part there is showing status.
 */
export class Graph {
    readonly root: Package;

    protected constructor(
        root: Package,
        readonly nodes: Graph.Node[],
    ) {
        this.root = root;
    }

    get(name: string) {
        const node = this.nodes.find(node => node.pkg.name === name);
        if (node === undefined) {
            throw new Error(`Cannot locate package "${name}"`);
        }
        return node;
    }

    static async load(pkg = Package.workspace) {
        const workspace = pkg.workspace;
        const nodeMap = await this.#loadNodes(workspace);
        return await this.#createGraph(workspace, Object.values(nodeMap));
    }

    static async forProject(path: string): Promise<Graph | undefined> {
        let workspace;
        try {
            workspace = Package.workspaceFor(path);
        } catch (e) {
            if (e instanceof JsonNotFoundError) {
                // Project is not in a workspace
                return;
            }
            throw e;
        }

        const nodeMap = await this.#loadNodes(workspace);

        const rootPkg = new Package({ path: path });
        const rootNode = nodeMap[rootPkg.name];
        if (!rootNode) {
            // Project resides under a workspace but is not part of the workspace
            return;
        }

        const nodes = new Set<Graph.Node>();
        function addNode(node: Graph.Node) {
            if (nodes.has(node)) {
                return;
            }
            nodes.add(node);
            for (const dependency of node.dependencies) {
                addNode(dependency);
            }
        }

        addNode(rootNode);

        return await this.#createGraph(rootPkg, [...nodes]);
    }

    async build(builder: ProjectBuilder) {
        if (!builder.hasTarget(Target.types) && !builder.hasTarget(Target.esm) && !builder.hasTarget(Target.cjs)) {
            // Clean-only (or no real build targets)
            using progress = new Progress();
            progress.startup("Building", this.root);
            await this.#prebuild(builder, progress);
            return;
        }

        await this.#buildWithTsgo(builder);
    }

    async #prebuild(builder: ProjectBuilder, progress?: Progress) {
        const wantsClean = builder.hasClean || builder.hasTarget(Target.clean);
        const needsConfig = this.nodes.find(node => node.pkg.hasConfig);
        if (!wantsClean && !needsConfig) {
            return;
        }

        try {
            if (wantsClean) {
                builder.clearClean();

                const doClean = async () => {
                    for (const node of this.nodes) {
                        await node.project.clean();
                        node.info = {};
                    }
                };

                if (progress) {
                    await progress.run("Clean", doClean);
                } else {
                    await doClean();
                }
            }

            for (const node of this.nodes) {
                if (!node.pkg.hasConfig) {
                    continue;
                }
                await builder.configure(node.project);
            }
        } catch (e) {
            console.error("Terminating due to prebuild error:", e);
            process.exit(1);
        }
    }

    async #buildWithTsgo(builder: ProjectBuilder) {
        const dirtyNodes = this.nodes.filter(node => node.isDirty || builder.unconditional);

        if (!dirtyNodes.length && !builder.hasClean) {
            using progress = new Progress();
            progress.startup("Building", this.root);
            progress.success("Up to date");
            return;
        }

        const workspace = this.root.isWorkspace ? this.root : this.root.workspace;
        const tsconfigPath = this.root.resolve("tsconfig.json");

        using progress = new Progress();
        progress.startup("Building", this.root);

        // Clean + configure under the same progress header
        await this.#prebuild(builder, progress);

        // Phase 1 — Batched type check via tsgo -b
        progress.update("Type check");
        let result: TsgoResult;
        try {
            result = await tsgoSolutionBuild(workspace, tsconfigPath);
        } catch (e) {
            progress.failure("Type check");
            throw e;
        }

        if (result.ok) {
            progress.success("Type check");
        } else {
            progress.failure("Type check");

            if (result.errorsByPackage.size > 0) {
                for (const errors of result.errorsByPackage.values()) {
                    process.stderr.write(`${errors}\n`);
                }
            } else if (result.rawOutput) {
                process.stderr.write(result.rawOutput);
            }
        }

        if (result.outputsSkipped) {
            // Exit code 2 — outputs were skipped.  Map errors to packages, propagate to dependents, and remove from
            // the dirty set so they aren't transpiled.
            const failed = new Set<Graph.Node>();

            for (const node of this.nodes) {
                if (result.errorsByPackage.has(node.pkg.path)) {
                    failed.add(node);
                }
            }

            function propagateFailure(failedNode: Graph.Node, nodes: Graph.Node[]) {
                for (const node of nodes) {
                    if (failed.has(node)) {
                        continue;
                    }
                    if (node.dependencies.includes(failedNode)) {
                        failed.add(node);
                        propagateFailure(node, nodes);
                    }
                }
            }
            for (const node of failed) {
                propagateFailure(node, this.nodes);
            }

            for (const node of failed) {
                const idx = dirtyNodes.indexOf(node);
                if (idx !== -1) {
                    dirtyNodes.splice(idx, 1);
                }
            }
        }

        // Phase 2 — Parallel transpilation + CJS .d.ts copy + API SHA + build info
        //
        // Each builder.build() enqueues work items (esbuild, CJS copy, API SHA).  flushWork() drains them all with a
        // concurrency limit.
        builder.typesPrebuilt = true;

        for (const node of dirtyNodes) {
            await builder.build(node.project, progress);
            node.info.timestamp = new Date().toISOString();
        }

        await progress.run("Transpile", () => builder.flushWork());

        if (!result.ok) {
            // Partial transpile output for clean packages is preserved; failure must still surface to CI
            process.exit(1);
        }
    }

    display() {
        for (const node of this.nodes) {
            const progress = node.pkg.start("Node");
            progress.info("path", node.pkg.path);
            progress.info("modified", formatTime(node.modifyTime));
            progress.info("built", formatTime(node.info.timestamp ?? 0));
            progress.info("dirty", node.isDirty ? colors.dim.red("yes") : colors.dim.green("no"));
            progress.info("dependencies", node.dependencies.map(formatDep).join(", "));
            progress.close();
        }
    }

    static async #createGraph(root: Package, nodes: Graph.Node[]) {
        const graph = new Graph(root, nodes);

        await Promise.all(
            graph.nodes.map(async node => {
                if (node.pkg.hasFile(BUILD_INFO_LOCATION)) {
                    node.info = await node.pkg.readJson(BUILD_INFO_LOCATION);
                }

                node.modifyTime = await node.pkg.lastModified("package.json", "src", "test");

                return node;
            }),
        );

        const stack = Array<Graph.Node>();
        function findCircular(node: Graph.Node) {
            if (stack.indexOf(node) !== -1) {
                stack.push(node);
                throw new InternalBuildError(`Circular dependency: ${stack.map(formatDep).join(" ▸ ")}`);
            }
            stack.push(node);
            for (const dep of node.dependencies) {
                findCircular(dep);
            }
            stack.pop();
        }
        for (const node of graph.nodes) {
            findCircular(node);
        }

        return graph;
    }

    static async #loadNodes(workspace: Package) {
        const workspaces = workspace.json.workspaces;
        // Single-package mode: when no workspaces are declared, treat the workspace package itself as the sole node
        const paths = workspaces === undefined || workspaces.length === 0 ? ["."] : [...workspaces];

        const nodeMap = {} as Record<string, Graph.Node>;
        const allDeps = {} as Record<string, string[]>;
        for (const path of paths) {
            const pkg = new Package({ path: workspace.resolve(path) });
            allDeps[pkg.name] = pkg.dependencies;
            nodeMap[pkg.name] = {
                pkg,
                project: new Project(pkg),
                dependencies: [],
                info: {},
                modifyTime: 0,

                get buildTime() {
                    return this.info.timestamp ? new Date(this.info.timestamp).getTime() : 0;
                },

                get isDirty() {
                    return this.modifyTime > this.buildTime || this.dependencies.some(dep => dep.isDirty);
                },
            };
        }

        for (const name in allDeps) {
            for (const dep of allDeps[name]) {
                const depNode = nodeMap[dep];

                // Note -- allow nodes to reference themselves, seems to be necessary on tools for use of tsc
                if (depNode && depNode !== nodeMap[name]) {
                    nodeMap[name].dependencies.push(depNode);
                }
            }
        }

        return nodeMap;
    }
}

export namespace Graph {
    export interface Node {
        pkg: Package;
        project: Project;
        dependencies: Node[];
        buildTime: number;
        info: BuildInformation;
        modifyTime: number;
        isDirty: boolean;
    }
}

function formatTime(time: number | string) {
    if (!time) {
        return colors.dim.red("never");
    }
    if (typeof time === "string") {
        time = new Date(time).getTime();
    }
    return new Date(time - new Date().getTimezoneOffset()).toISOString().split(".")[0].replace("T", " ");
}

function formatDep(node: Graph.Node) {
    return node.pkg.name.replace(/^@[^/]+\//, "");
}
