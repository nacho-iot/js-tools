/**
 * @license
 * Copyright 2022-2026 Greg Lauckhart <greg@lauckhart.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { posixPath } from "../util/file.js";
import { Package } from "../util/package.js";
import { Graph } from "./graph.js";

const TEMPLATE_DIR = "tsc";
const TEMPLATES = ["tsconfig.base.json", "tsconfig.lib.json", "tsconfig.app.json", "tsconfig.test.json"];

const MANAGED_HEADER =
    "// Managed by nacho-build.  Nacho will update references automatically but otherwise preserves your edits.\n" +
    "// Use `nacho-build configure` to overwrite with defaults.\n";

/**
 * Ensure base tsconfig templates exist in the workspace root.  Copies from the tools package if missing.  Pass
 * {@link force} to overwrite existing files (for the `configure` command).
 */
export async function ensureTsconfigTemplates(workspace: Package, force = false) {
    const srcDir = Package.tools.resolve(TEMPLATE_DIR);
    const destDir = workspace.resolve(TEMPLATE_DIR);

    await mkdir(destDir, { recursive: true });

    for (const name of TEMPLATES) {
        const dest = resolve(destDir, name);
        if (force || !workspace.hasFile(dest)) {
            await copyFile(resolve(srcDir, name), dest);
        }
    }
}

/**
 * Unfortunately typescript's "project references" are redundant with package.json dependencies.  We don't use them for
 * build but there are still some advantages to maintaining them so we just ensure they're in sync during workspace
 * builds.
 *
 * One discussion on the topic: https://github.com/microsoft/TypeScript/issues/25376
 *
 * Pass {@link force} (via `nacho-build configure`) to also rewrite the `extends` field of each subproject tsconfig;
 * otherwise `extends` is preserved so users can customize it.
 */
export async function syncAllTsconfigs(graph: Graph, force = false) {
    const workspace = graph.nodes[0].pkg.workspace;
    const rootTsconfig = await workspace.readJson("tsconfig.json");

    const originalReferences = rootTsconfig.references;
    rootTsconfig.references = [];

    for (const node of graph.nodes) {
        await syncPackageTsconfigs(graph, node, force);
        rootTsconfig.references.push({
            path: posixPath(workspace.relative(node.pkg.path)),
        });
    }

    if (referencesChanged(originalReferences, rootTsconfig.references)) {
        await workspace.writeJson("tsconfig.json", rootTsconfig);
    }
}

function referencesChanged(originalReferences: unknown, newReferences: unknown) {
    return JSON.stringify(originalReferences) !== JSON.stringify(newReferences);
}

export async function syncPackageTsconfigs(_graph: Graph, node: Graph.Node, force = false) {
    const workspace = node.pkg.workspace;
    // Libraries must emit type declarations for consumers.  Packages with tests must also emit because the test
    // subproject references src via tsconfig project references.
    const srcEmitsDeclarations = node.pkg.isLibrary || node.pkg.hasTests;
    await syncSubproject(
        workspace,
        node,
        "src",
        srcEmitsDeclarations ? "tsconfig.lib.json" : "tsconfig.app.json",
        force,
    );
    await syncSubproject(
        workspace,
        node,
        "test",
        "tsconfig.test.json",
        force,
        node.pkg.resolve("src"),
    );
}

async function syncSubproject(
    workspace: Package,
    node: Graph.Node,
    path: string,
    baseConfig: string,
    force: boolean,
    ...extraRefs: string[]
) {
    path = node.pkg.resolve(path);

    const tsconfigPath = resolve(path, "tsconfig.json");
    if (!node.pkg.hasFile(tsconfigPath)) {
        return;
    }

    const tsconfig = await node.pkg.readJson(tsconfigPath);

    // Only rewrite extends when forced (configure command); otherwise preserve user edits
    if (force) {
        tsconfig.extends = posixPath(relative(path, workspace.resolve(TEMPLATE_DIR, baseConfig)));
    }

    const deps = node.dependencies.filter(dep => dep.pkg.isLibrary).map(dep => dep.pkg.resolve("src"));

    const desired = [...new Set([...deps, ...extraRefs])];

    const newReferences = desired
        .map(ref => ({ path: posixPath(relative(path, ref)) }))
        .sort((ref1, ref2) => ref1.path.localeCompare(ref2.path));

    tsconfig.references = newReferences;

    await writeTsconfig(tsconfigPath, tsconfig);
}

/**
 * Write a subproject tsconfig with a managed-file header.  Skips the write when the resulting content matches what's
 * already on disk.
 */
async function writeTsconfig(path: string, value: unknown) {
    const content = MANAGED_HEADER + JSON.stringify(value, undefined, 4) + "\n";
    try {
        if ((await readFile(path, "utf-8")) === content) {
            return;
        }
    } catch {
        // fall through to write
    }
    await writeFile(path, content);
}
