/**
 * @license
 * Copyright 2022-2026 Greg Lauckhart <greg@lauckhart.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from "node:fs";
import { cp, writeFile } from "node:fs/promises";
import { ansi } from "../ansi-text/text-builder.js";
import { Graph } from "../building/graph.js";
import { execute } from "../running/execute.js";
import { Package } from "../util/package.js";
import { Progress } from "../util/progress.js";

const VERSION_FILE = "version.txt";

export class Versioner {
    #pkg: Package;
    #version?: string;
    #members = new Set<string>();

    get pkg() {
        return this.#pkg;
    }

    get version() {
        return this.#version;
    }

    get appliedVersion() {
        return this.#pkg.json.version;
    }

    constructor(pkg: Package, version?: string) {
        this.#pkg = pkg.workspace;

        if (version === undefined) {
            version = this.#readVersion();
        }

        if (version && !version.match(/^(?:\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?|[a-z]+)$/)) {
            throw new Error(`Version ${version} is invalid (must be semantic or single lowercase word)`);
        }

        this.#version = version;
    }

    async set() {
        await writeFile(this.#versionFile, this.#definiteVersion);
    }

    bump(kind: "patch" | "minor" | "major") {
        const current = this.#definiteVersion;
        const m = current.match(/^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/);
        if (!m) {
            throw new Error(`Cannot bump non-semver version "${current}"`);
        }
        const [, maj, min, pat] = m;
        switch (kind) {
            case "major":
                this.#version = `${+maj + 1}.0.0`;
                break;
            case "minor":
                this.#version = `${maj}.${+min + 1}.0`;
                break;
            case "patch":
                this.#version = `${maj}.${min}.${+pat + 1}`;
                break;
            default:
                throw new Error(`Invalid bump kind "${kind}" (must be patch, minor, or major)`);
        }
    }

    async apply(progress?: Progress) {
        const graph = await Graph.load(this.#pkg);
        this.#members = new Set(graph.nodes.map(node => node.pkg.name));

        for (const node of graph.nodes) {
            const what = `Apply ${ansi.bold(this.#definiteVersion)} to ${ansi.bold(node.pkg.name)}`;
            progress?.update(what);
            if (this.#applyOne(node.pkg)) {
                progress?.success(what);
                await node.pkg.save();
            } else {
                progress?.success(`${what} (no change)`);
            }
            const srcLicense = this.#pkg.resolve("LICENSE");
            const destLicense = node.pkg.resolve("LICENSE");
            if (srcLicense !== destLicense) {
                await cp(srcLicense, destLicense);
            }
        }

        // Run the workspace `prepare` rebuild (via npm install) while `dev-types` is still in package.json.
        const syncWhat = `Sync ${ansi.bold("package-lock.json")}`;
        progress?.update(syncWhat);
        const code = await execute("npm", ["install", "--package-lock-only", "--silent"], { cwd: this.#pkg.path });
        if (code !== 0) {
            progress?.failure(syncWhat);
            throw new Error(`npm install --package-lock-only exited with code ${code}`);
        }
        progress?.success(syncWhat);

        // Strip `dev-types` from exports — published packages must not advertise it (consumers with
        // `customConditions: ["dev-types"]` would resolve to `.ts` source under node_modules).
        for (const node of graph.nodes) {
            const exports = node.pkg.json.exports;
            if (exports === undefined || !stripDevTypes(exports)) {
                continue;
            }
            const what = `Strip dev-types from ${ansi.bold(node.pkg.name)}`;
            progress?.update(what);
            await node.pkg.save();
            progress?.success(what);
        }
    }

    async tag() {
        await execute("git", ["tag", "-f", `v${this.#definiteVersion}`]);
    }

    get #definiteVersion() {
        if (this.#version === undefined) {
            throw new Error(`No version supplied and ${this.#versionFile} does not exist`);
        }
        return this.#version;
    }

    get #versionFile() {
        return this.#pkg.resolve(VERSION_FILE);
    }

    #readVersion() {
        const versionFile = this.#versionFile;
        if (!existsSync(versionFile)) {
            return undefined;
        }

        const version = readFileSync(versionFile).toString().trim();
        if (version.length === 0) {
            throw new Error(`Version file ${versionFile} is empty`);
        }

        return version;
    }

    #applyOne(pkg: Package) {
        const json = pkg.json;
        let changed = false;

        if (json.version !== this.#definiteVersion) {
            json.version = this.#definiteVersion;
            changed = true;
        }

        for (const key in json) {
            if (key !== "dependencies" && !key.endsWith("Dependencies")) {
                continue;
            }

            const deps = json[key];
            if (typeof deps !== "object") {
                continue;
            }

            if (this.#applyToDeps(deps as Record<string, string>)) {
                changed = true;
            }
        }

        return changed;
    }

    #applyToDeps(deps: Record<string, string>) {
        let changed = false;
        const version = this.#definiteVersion;
        for (const key in deps) {
            if (this.#members.has(key)) {
                if (deps[key] === version) {
                    continue;
                }
                deps[key] = this.#definiteVersion;
                changed = true;
            }
        }
        return changed;
    }
}

// Recursively delete `dev-types` keys from an exports tree.
function stripDevTypes(node: unknown): boolean {
    if (Array.isArray(node)) {
        let changed = false;
        for (const item of node) {
            if (stripDevTypes(item)) {
                changed = true;
            }
        }
        return changed;
    }
    if (typeof node !== "object" || node === null) {
        return false;
    }
    const obj = node as Record<string, unknown>;
    let changed = false;
    for (const key of Object.keys(obj)) {
        if (key === "dev-types") {
            delete obj[key];
            changed = true;
            continue;
        }
        if (stripDevTypes(obj[key])) {
            changed = true;
        }
    }
    return changed;
}
