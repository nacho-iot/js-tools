/**
 * @license
 * Copyright 2022-2026 Greg Lauckhart <greg@lauckhart.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { commander } from "../util/commander.js";
import { Package } from "../util/package.js";
import { reportCycles } from "./cycles.js";
import { buildDocs, mergeDocs } from "./docs.js";
import { Graph } from "./graph.js";
import { ProjectBuilder, Target } from "./project-builder.js";
import { Project } from "./project.js";
import { manageVersion, VersionArgs } from "../versioning/cli.js";
import { relock } from "./relock.js";
import { ensureTsconfigTemplates, syncAllTsconfigs } from "./tsconfig.js";

enum Mode {
    BuildProject,
    BuildProjectWithDependencies,
    BuildWorkspace,
    DisplayGraph,
    Configure,
    BuildDocs,
    Relock,
    SyncTsconfigs,
    Circular,
    Version,
}

interface Args {
    prefix: string;
    clean?: boolean;
    workspaces?: boolean;
    dependencies?: boolean;
}

export async function main(argv = process.argv) {
    const targets = Array<Target>();
    let mode = Mode.BuildProject;

    const program = commander("nacho-build", "Builds TypeScript packages and monorepos.")
        .option("-p, --prefix <path>", "specify build directory", ".")
        .option("-c, --clean", "clean before build", false)
        .option("-d, --dependencies", "build dependencies", false)
        .option("--tsc", "use tsc instead of tsgo for type checking");

    program
        .command("build")
        .description("(default) build JS and type definitions")
        .action(() => {});

    program
        .command("clean")
        .description("remove build and dist directories")
        .action(() => {
            targets.push(Target.clean);
        });

    program
        .command("types")
        .description("build type definitions")
        .action(() => {
            targets.push(Target.types);
        });

    program
        .command("esm")
        .description("build JS (ES6 modules)")
        .action(() => {
            targets.push(Target.esm);
        });

    program
        .command("cjs")
        .description("build JS (CommonJS modules)")
        .action(() => {
            targets.push(Target.cjs);
        });

    program
        .command("graph")
        .description("display the workspace graph")
        .action(() => {
            mode = Mode.DisplayGraph;
        });

    program
        .command("tsconfigs")
        .description("sync all tsconfigs with package.json")
        .action(() => {
            mode = Mode.SyncTsconfigs;
        });

    program
        .command("docs")
        .description("build workspace documentation")
        .action(() => {
            mode = Mode.BuildDocs;
        });

    program
        .command("configure")
        .description("refresh tsconfig templates and sync all tsconfigs")
        .action(() => {
            mode = Mode.Configure;
        });

    program
        .command("relock")
        .description("remove package-lock.json and all node_modules directories so npm install regenerates them")
        .action(() => {
            mode = Mode.Relock;
        });

    program
        .command("cycles")
        .description("find circular dependencies")
        .action(() => {
            mode = Mode.Circular;
        });

    let versionArgs: VersionArgs | undefined;
    program
        .command("version")
        .description("manage workspace package versions")
        .argument("[version]")
        .option("-s, --set", "set the release version")
        .option("-a, --apply", "set package versions to the release version")
        .option("-t, --tag", "add git tag for release version")
        .option("-b, --bump <kind>", "increment current version (patch, minor, or major); ignored if [version] is given")
        .action((version: string | undefined, opts: Omit<VersionArgs, "version">) => {
            mode = Mode.Version;
            versionArgs = { ...opts, version };
        });

    program.action(() => {});

    const args = program.parse(argv).opts<Args>();

    const pkg = new Package({ path: args.prefix });
    if (mode === Mode.BuildProject) {
        mode = pkg.isWorkspace ? Mode.BuildWorkspace : Mode.BuildProjectWithDependencies;
    }

    function builder(graph?: Graph) {
        const { tsc, ...rest } = args as Args & { tsc?: boolean };
        return new ProjectBuilder({ ...rest, tsgo: tsc ? false : undefined, targets: [...targets], graph });
    }

    switch (mode as Mode) {
        case Mode.BuildProjectWithDependencies:
            {
                const graph = await Graph.forProject(args.prefix);
                if (graph !== undefined) {
                    await graph.build(builder(graph));
                } else {
                    // Not in a workspace; build the single project directly
                    await builder().build(new Project(args.prefix));
                }
            }
            break;

        case Mode.BuildWorkspace:
            {
                const graph = await Graph.load();
                await ensureTsconfigTemplates(pkg);
                await syncAllTsconfigs(graph);
                await graph.build(builder(graph));
            }
            break;

        case Mode.DisplayGraph:
            (await Graph.load()).display();
            break;

        case Mode.SyncTsconfigs:
            {
                const graph = await Graph.load();
                await ensureTsconfigTemplates(pkg);
                await syncAllTsconfigs(graph);
            }
            break;

        case Mode.Configure:
            {
                await ensureTsconfigTemplates(pkg, true);
                if (pkg.isWorkspace) {
                    const graph = await Graph.load();
                    await syncAllTsconfigs(graph, true);
                }
            }
            break;

        case Mode.Relock:
            await relock();
            break;

        case Mode.Version:
            await manageVersion({
                ...versionArgs,
                prefix: versionArgs?.prefix ?? args.prefix,
            });
            break;

        case Mode.BuildDocs: {
            using progress = pkg.start("Documenting");
            if (pkg.isWorkspace) {
                const graph = await Graph.load();
                for (const node of graph.nodes) {
                    if (node.pkg.isLibrary) {
                        await progress.run(node.pkg.name, () => buildDocs(node.pkg, progress));
                    }
                }
                await mergeDocs(Package.workspace);
            } else {
                await progress.run(pkg.name, () => buildDocs(pkg, progress));
            }
            break;
        }

        case Mode.Circular: {
            using progress = pkg.start("Analyzing dependencies");
            if (pkg.isWorkspace) {
                const graph = await Graph.load();
                for (const node of graph.nodes) {
                    if (node.pkg.isLibrary) {
                        await reportCycles(node.pkg, progress);
                    }
                }
            } else {
                await reportCycles(pkg, progress);
            }
            break;
        }
    }
}
