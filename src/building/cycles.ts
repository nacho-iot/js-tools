/**
 * @license
 * Copyright 2022-2026 Greg Lauckhart <greg@lauckhart.com>
 * SPDX-License-Identifier: Apache-2.0
 */

const MAX_CYCLES = 1000;

import { Package } from "../util/package.js";
import { Progress } from "../util/progress.js";

import { dirname, relative, resolve } from "node:path";
import {
    ExportDeclaration,
    Expression,
    ImportDeclaration,
    isExportDeclaration,
    isExternalModuleReference,
    isImportDeclaration,
    isImportEqualsDeclaration,
    isNamedExports,
    isNamedImports,
    isStringLiteral,
    Node,
    SourceFile,
} from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";
import { std } from "../ansi-text/std.js";
import { ansi } from "../ansi-text/text-builder.js";
import { BuildError } from "./error.js";

export async function reportCycles(pkg: Package, progress: Progress, api: API) {
    const cycles = await progress.run(pkg.name, () => identifyCycles(pkg, progress, api));
    if (cycles) {
        printCycles(pkg, cycles);
    }
}

async function identifyCycles(pkg: Package, progress: Progress, api: API) {
    const files = await pkg.glob("{src,test}/**/*.ts");

    const deps = {} as Record<string, string[]>;
    {
        using snapshot = api.updateSnapshot({ openFiles: files });
        for (const filename of files) {
            progress.refresh();
            const source = snapshot.getDefaultProjectForFile(filename)?.program.getSourceFile(filename);
            if (source === undefined) {
                throw new BuildError(`Cannot parse ${filename} for cycle analysis`);
            }
            deps[filename] = resolveDeps(pkg, filename, importsOf(source));
        }
    }

    // Opens are ref-counted server-side; without this the shared server accumulates every package's program for the
    // life of the run
    api.updateSnapshot({ closeFiles: files }).dispose();

    const cycles = [] as string[][];
    for (const filename in deps) {
        visit(filename, []);
        if (cycles.length === MAX_CYCLES) {
            break;
        }
    }

    function visit(filename: string, breadcrumb: string[]) {
        progress.refresh();
        const fileDeps = deps[filename] ?? deps[filename.replace(/\.js$/, ".ts")];
        if (fileDeps === undefined) {
            return;
        }

        const previousIndex = breadcrumb.indexOf(filename);
        if (previousIndex !== -1) {
            const newCycle = breadcrumb.slice(previousIndex);
            for (const cycle of cycles) {
                const filenameOffset = cycle.indexOf(filename);
                if (cycle.length !== newCycle.length) {
                    continue;
                }
                if (filenameOffset === -1) {
                    continue;
                }

                let i = 0;
                for (i = 0; i < newCycle.length; i++) {
                    if (newCycle[i] !== cycle[(filenameOffset + i) % newCycle.length]) {
                        break;
                    }
                }

                if (i === newCycle.length) {
                    return;
                }
            }
            cycles.push(newCycle);
            return;
        }

        breadcrumb = [...breadcrumb, filename];
        for (const dep of fileDeps) {
            visit(dep, breadcrumb);
            if (cycles.length > MAX_CYCLES) {
                break;
            }
        }
    }

    return cycles.length ? cycles : undefined;
}

function printCycles(pkg: Package, cycles: string[][]) {
    std.out(ansi.red("Cycles detected:"), "\n");
    const src = pkg.resolve("src");
    for (const cycle of cycles) {
        std.out("  ", cycle.map(name => ansi.bright.blue(relative(src, name))).join(" → "), " ↩\n");
    }
    if (cycles.length >= MAX_CYCLES) {
        std.out(`\n${ansi.red(`Stopping search after max ${MAX_CYCLES} cycles`)}\n`);
    }
}

/**
 * Extract the module specifiers a file depends on at load time.  Type-only, deferred, dynamic and fully-elided
 * imports are excluded because none of them creates a load-time edge, so none can form a cycle.
 */
function importsOf(source: SourceFile) {
    const specifiers = Array<string>();

    function addSpecifier(node?: Expression) {
        if (node !== undefined && isStringLiteral(node)) {
            specifiers.push(node.text);
        }
    }

    function visit(node: Node) {
        if (isImportDeclaration(node)) {
            if (importsAtLoadTime(node)) {
                addSpecifier(node.moduleSpecifier);
            }
        } else if (isExportDeclaration(node)) {
            if (exportsAtLoadTime(node)) {
                addSpecifier(node.moduleSpecifier);
            }
        } else if (
            isImportEqualsDeclaration(node) &&
            !node.isTypeOnly &&
            isExternalModuleReference(node.moduleReference)
        ) {
            addSpecifier(node.moduleReference.expression);
        }

        node.forEachChild(visit);
    }

    source.forEachChild(visit);

    return specifiers;
}

function importsAtLoadTime(node: ImportDeclaration) {
    const clause = node.importClause;
    if (clause === undefined) {
        // Bare `import "x"` exists only for its side effects
        return true;
    }

    // `import type` is erased and `import defer` evaluates lazily like `import()`
    if (clause.phaseModifier !== undefined) {
        return false;
    }

    if (clause.name !== undefined) {
        return true;
    }

    const bindings = clause.namedBindings;
    if (bindings === undefined || !isNamedImports(bindings)) {
        return true;
    }

    // esbuild erases empty and all-type binding lists alike, so neither is a load-time edge
    return !bindings.elements.every(element => element.isTypeOnly);
}

function exportsAtLoadTime(node: ExportDeclaration) {
    if (node.isTypeOnly) {
        return false;
    }

    const clause = node.exportClause;
    if (clause === undefined || !isNamedExports(clause)) {
        return true;
    }

    return !clause.elements.every(element => element.isTypeOnly);
}

function resolveDeps(pkg: Package, sourceFilename: string, deps: string[]) {
    const dir = dirname(sourceFilename);
    const aliases = pkg.importAliases;
    const resolved = Array<string>();

    for (let dep of deps) {
        let base = dir;
        if (dep.startsWith("#")) {
            dep = aliases.rewrite(dep);
            base = pkg.path;
        }
        if (dep.startsWith("./")) {
            resolved.push(resolve(base, dep));
        }
    }

    return resolved;
}
