/**
 * @license
 * Copyright 2022-2026 Greg Lauckhart <greg@lauckhart.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { Progress } from "../util/progress.js";
import { BuildError } from "./error.js";
import { Graph } from "./graph.js";
import { BuildInformation, Project } from "./project.js";
import { copyDeclarationsToCjs, createTsgoContext, TypescriptContext } from "./typescript/tsgo.js";

export enum Target {
    clean = "clean",
    types = "types",
    esm = "esm",
    cjs = "cjs",
}

export interface Options {
    targets?: Target[];
    clean?: boolean;
    graph?: Graph;
}

/**
 * High-level build coordination.
 *
 * Warning: This class is intended for command line use and will process.exit if things go wrong.
 */
export class ProjectBuilder {
    unconditional: boolean;
    tsContext?: TypescriptContext;
    graph?: Graph;

    /**
     * When true, type checking has already been performed by a batched tsgo -b invocation.  {@link #doBuild} skips
     * TypescriptContext calls and instead does CJS .d.ts copy + API SHA for the pre-emitted declarations.
     */
    typesPrebuilt = false;

    /**
     * Work queue populated by {@link #doBuild} when {@link typesPrebuilt} is true.  The graph drains this via
     * {@link flushWork} with throttled parallelism.
     */
    #work = Array<() => Promise<void>>();

    /**
     * Execute all enqueued work with a concurrency limit and clear the queue.
     */
    async flushWork() {
        await parallel(this.#work);
        this.#work = [];
    }

    constructor(private options: Options = {}) {
        this.graph = options.graph;
        this.unconditional =
            options.clean || (options.targets !== undefined && options.targets?.indexOf(Target.clean) !== -1);
    }

    get hasClean() {
        return this.options.clean;
    }

    clearClean() {
        delete this.options.clean;
    }

    hasTargets() {
        return this.options.targets && this.options.targets.length > 0;
    }

    hasTarget(target: Target) {
        // No explicit targets means all build targets (not clean)
        if (!this.options.targets?.length) {
            return target !== Target.clean;
        }
        return this.options.targets.includes(target);
    }

    public async configure(project: Project) {
        if (!project.pkg.hasConfig) {
            return;
        }

        await project.configure();
    }

    public async build(project: Project, progress?: Progress) {
        const ownProgress = progress === undefined;
        progress ??= project.pkg.start("Building");

        try {
            await this.#doBuild(project, progress);
        } catch (e: any) {
            if (ownProgress) {
                progress.close();
            }
            process.stderr.write(`${e.stack ?? e.message}\n\n`);
            process.exit(1);
        }

        if (ownProgress) {
            progress.close();
        }
    }

    async #doBuild(project: Project, progress: Progress) {
        const targets = this.#selectTargets(project);

        if (targets.has(Target.clean) || this.options.clean) {
            await progress.run("Clean", () => project.clean());
        }

        if (!targets.has(Target.types) && !targets.has(Target.esm) && !targets.has(Target.cjs)) {
            return;
        }

        const info: BuildInformation = {};

        const config = await project.configure();

        await config?.before?.({ project });

        const graph = this.graph ?? (await Graph.forProject(project.pkg.path));
        let node: Graph.Node | undefined;
        if (graph) {
            node = graph.get(project.pkg.name);
        }

        if (targets.has(Target.types)) {
            if (this.typesPrebuilt) {
                // Types were already checked by batched tsgo -b.  Enqueue remaining work into the shared work queue
                // for throttled parallel execution.  API SHA is unnecessary — tsgo -b handles incremental tracking
                // internally.
                // copyDeclarationsToCjs reads dist/esm while buildSource("esm") writes hand-authored declarations there
                let esmSourceDone: Promise<void> | undefined;
                let resolveEsmSource: (() => void) | undefined;
                let rejectEsmSource: ((e: unknown) => void) | undefined;

                if (targets.has(Target.esm)) {
                    if (targets.has(Target.cjs)) {
                        esmSourceDone = new Promise<void>((resolve, reject) => {
                            resolveEsmSource = resolve;
                            rejectEsmSource = reject;
                        });
                    }
                    this.#work.push(async () => {
                        try {
                            await project.buildSource("esm");
                            resolveEsmSource?.();
                        } catch (e) {
                            rejectEsmSource?.(e);
                            throw e;
                        }
                    });
                    if (project.pkg.hasTests) {
                        this.#work.push(() => project.buildTests("esm"));
                    }
                }
                if (targets.has(Target.cjs)) {
                    // CJS .d.ts copy and CJS esbuild both create dist/cjs/ subdirectories, so they must be sequential
                    // to avoid mkdir races
                    this.#work.push(async () => {
                        if (project.pkg.isLibrary) {
                            if (esmSourceDone) {
                                await esmSourceDone;
                            }
                            await copyDeclarationsToCjs(project.pkg);
                        }
                        await project.buildSource("cjs");
                    });
                    if (project.pkg.hasTests) {
                        this.#work.push(() => project.buildTests("cjs"));
                    }
                }
            } else {
                try {
                    let context = this.tsContext;
                    if (context === undefined) {
                        context = createTsgoContext(project.pkg.workspace);
                        this.tsContext = context;
                    }

                    const refreshCallback = progress.refresh.bind(progress);

                    if (project.pkg.isLibrary) {
                        await progress.run(`Generate ${progress.emphasize("type declarations")}`, () =>
                            context.build(project.pkg, "src", refreshCallback),
                        );
                    } else {
                        await progress.run(`Validate ${progress.emphasize("types")}`, () =>
                            context.build(project.pkg, "src", refreshCallback, false),
                        );
                    }
                    if (project.pkg.hasTests) {
                        await progress.run(`Validate ${progress.emphasize("test types")}`, () =>
                            context.build(project.pkg, "test", refreshCallback),
                        );
                    }
                } catch (e) {
                    if (e instanceof BuildError) {
                        if (e.diagnostics) {
                            process.stderr.write(`${e.diagnostics}\n`);
                        }
                        progress.failure("Terminating due to type errors");
                        process.exit(1);
                    }
                    throw e;
                }

                const formats = Array<"esm" | "cjs">();
                if (targets.has(Target.esm)) {
                    formats.push("esm");
                }
                if (targets.has(Target.cjs)) {
                    formats.push("cjs");
                }

                if (formats.length) {
                    const groups = [project.pkg.isLibrary ? "library" : "app"];
                    if (project.pkg.hasTests) {
                        groups.push("tests");
                    }

                    const formatDesc = formats.map(progress.emphasize).join("+");
                    const groupDesc = groups.map(progress.emphasize).join("+");

                    await progress.run(`Transpile ${groupDesc} to ${formatDesc}`, async () => {
                        for (const format of formats) {
                            await this.#transpile(project, format);
                        }
                    });
                }
            }
        }

        await config?.after?.({ project });

        // Only update build information when there are no explicit targets so we know it's a full build
        if (!this.options.targets?.length) {
            await project.recordBuildInfo(info);
            if (node) {
                node.info = info;
            }
        }
    }

    async #transpile(project: Project, format: "esm" | "cjs") {
        await project.buildSource(format);
        if (project.pkg.hasTests) {
            await project.buildTests(format);
        }
    }

    #selectTargets(project: Project) {
        const targets = new Set<string>(this.options.targets);

        if (!targets.size) {
            targets.add(Target.types);

            if (project.pkg.supportsEsm) {
                targets.add(Target.esm);
            }

            if (project.pkg.supportsCjs) {
                targets.add(Target.cjs);
            }
        } else {
            if (!project.pkg.supportsEsm) {
                targets.delete(Target.esm);
            }

            if (!project.pkg.supportsCjs) {
                targets.delete(Target.cjs);
            }
        }

        return targets;
    }
}

const PARALLEL_LIMIT = 10;

/**
 * Run an array of async tasks with a concurrency limit.
 */
async function parallel<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
    const results = Array<T>(tasks.length);
    let next = 0;

    async function worker() {
        while (next < tasks.length) {
            const i = next++;
            results[i] = await tasks[i]();
        }
    }

    await Promise.all(Array.from({ length: Math.min(PARALLEL_LIMIT, tasks.length) }, worker));
    return results;
}
