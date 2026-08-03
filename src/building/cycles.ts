/**
 * @license
 * Copyright 2022-2026 Greg Lauckhart <greg@lauckhart.com>
 * SPDX-License-Identifier: Apache-2.0
 */

const MAX_CYCLES = 1000;

import { readFile } from "node:fs/promises";
import { Package } from "../util/package.js";
import { Progress } from "../util/progress.js";

import { dirname, relative, resolve } from "node:path";
import {
    createSourceFile,
    ExportDeclaration,
    Expression,
    forEachChild,
    ImportDeclaration,
    isExportDeclaration,
    isExternalModuleReference,
    isImportDeclaration,
    isImportEqualsDeclaration,
    isNamedExports,
    isNamedImports,
    isStringLiteral,
    Node,
    ScriptKind,
    ScriptTarget,
    SyntaxKind,
} from "typescript";
import { std } from "../ansi-text/std.js";
import { ansi } from "../ansi-text/text-builder.js";

export async function reportCycles(pkg: Package, progress: Progress) {
    const cycles = await progress.run(pkg.name, () => identifyCycles(pkg, progress));
    if (cycles) {
        printCycles(pkg, cycles);
    }
}

async function identifyCycles(pkg: Package, progress: Progress) {
    const deps = {} as Record<string, string[]>;
    for (const filename of await pkg.glob("{src,test}/**/*.ts")) {
        const contents = await readFile(filename, "utf-8");
        deps[filename] = resolveDeps(pkg, filename, importsOf(filename, contents));
    }

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
 * Extract the module specifiers a file depends on at runtime.  Type-only and dynamic imports are excluded because
 * neither creates a load-time edge, so neither can form a cycle.
 */
function importsOf(filename: string, contents: string) {
    const source = createSourceFile(filename, contents, ScriptTarget.Latest, false, ScriptKind.TS);
    const specifiers = Array<string>();

    function addSpecifier(node?: Expression) {
        if (node !== undefined && isStringLiteral(node)) {
            specifiers.push(node.text);
        }
    }

    function visit(node: Node) {
        if (isImportDeclaration(node)) {
            if (!isTypeOnlyImport(node)) {
                addSpecifier(node.moduleSpecifier);
            }
        } else if (isExportDeclaration(node)) {
            if (!isTypeOnlyExport(node)) {
                addSpecifier(node.moduleSpecifier);
            }
        } else if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference)) {
            addSpecifier(node.moduleReference.expression);
        }

        forEachChild(node, visit);
    }

    forEachChild(source, visit);

    return specifiers;
}

function isTypeOnlyImport(node: ImportDeclaration) {
    const clause = node.importClause;
    if (clause === undefined) {
        return false;
    }
    if (clause.phaseModifier === SyntaxKind.TypeKeyword) {
        return true;
    }
    if (clause.name !== undefined) {
        return false;
    }

    const bindings = clause.namedBindings;
    if (bindings === undefined || !isNamedImports(bindings)) {
        return false;
    }

    // An empty binding list still loads the module, and `every` is vacuously true for it
    return bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly);
}

function isTypeOnlyExport(node: ExportDeclaration) {
    if (node.isTypeOnly) {
        return true;
    }

    const clause = node.exportClause;
    if (clause === undefined || !isNamedExports(clause)) {
        return false;
    }

    return clause.elements.length > 0 && clause.elements.every(element => element.isTypeOnly);
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
