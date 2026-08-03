/**
 * @license
 * Copyright 2022-2026 Greg Lauckhart <greg@lauckhart.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from "node:child_process";
import { cp } from "node:fs/promises";
import { join, resolve } from "path";
import { isDirectory } from "../../util/file.js";
import { Package } from "../../util/package.js";
import { BuildError } from "../error.js";
import { TypescriptContext } from "./context.js";

// The native compiler ships as typescript@7, aliased to "typescript7" because node_modules/typescript must remain
// typescript@6 — typedoc and our own JS-API code require the classic API that 7.x dropped
function tsgoBin(_workspace: Package) {
    return Package.tools.findPackage("typescript7").resolve("lib/tsc.js");
}

export function createTsgoContext(workspace: Package): TypescriptContext {
    const bin = tsgoBin(workspace);
    return {
        async build(pkg, path, _refreshCallback, _emit) {
            const args = [bin, "--project", pkg.resolve(join(path, "tsconfig.json"))];

            await new Promise<void>((resolve, reject) => {
                const tsgo = spawn(process.execPath, args, { stdio: "inherit" });

                tsgo.on("exit", (code, signal) => {
                    switch (code) {
                        case 0:
                            resolve();
                            break;

                        case 1: // Diagnostics present, outputs generated
                        case 2: // Diagnostics present, outputs skipped
                        case 3: // Project invalid
                        case 4: // Reference cycle
                        case 5: // Not implemented
                            // TS will have printed an error already
                            reject(new BuildError());
                            break;

                        case null:
                            reject(new BuildError(`tsgo exited with signal ${signal}`));
                            break;

                        default:
                            reject(new BuildError(`tsgo exited with code ${code}`));
                            break;
                    }
                });
            });

            if (path !== "test") {
                await copyDeclarationsToCjs(pkg);
            }
        },
    };
}

/**
 * Copy .d.ts and .d.ts.map from dist/esm/ to dist/cjs/.
 */
export async function copyDeclarationsToCjs(pkg: Package) {
    await cp(pkg.resolve("dist/esm"), pkg.resolve("dist/cjs"), {
        recursive: true,
        filter(src) {
            if (isDirectory(src)) {
                return true;
            }

            return src.endsWith(".d.ts") || src.endsWith(".d.ts.map");
        },
    });
}

export interface TsgoResult {
    ok: boolean;

    /**
     * True when outputs were skipped (exit code 2) — affected packages should not be transpiled.  When false, outputs
     * were generated despite diagnostics (exit code 1) and transpilation can proceed.
     */
    outputsSkipped: boolean;

    errorsByPackage: Map<string, string>;

    /**
     * Raw captured stdout — used to surface diagnostics that don't match the (line,col) parser (TS5xxx config errors,
     * TS6xxx command-line errors).
     */
    rawOutput: string;
}

/**
 * Run tsgo in solution build mode (-b) for the entire workspace or a scoped set of packages.
 *
 * Captures diagnostics and maps them to packages by file path. Does not throw on type errors — the caller decides how
 * to handle failures.
 */
export async function tsgoSolutionBuild(workspace: Package, tsconfigPath: string): Promise<TsgoResult> {
    const bin = tsgoBin(workspace);
    const args = [bin, "-b", tsconfigPath];
    const workspacePath = workspace.path;

    // tsgo sends diagnostics to stdout
    const { code, stdout } = await new Promise<{ code: number; stdout: string }>((resolve, reject) => {
        const chunks = Array<Buffer>();
        const tsgo = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });

        tsgo.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

        tsgo.on("error", reject);

        tsgo.on("exit", (code, signal) => {
            if (code === null) {
                reject(new BuildError(`tsgo exited with signal ${signal}`));
                return;
            }
            resolve({ code, stdout: Buffer.concat(chunks).toString("utf-8") });
        });
    });

    if (code >= 3) {
        // 3 = project invalid, 4 = reference cycle, 5 = not implemented
        throw new BuildError(stdout || `tsgo -b exited with code ${code}`);
    }

    const errorsByPackage = new Map<string, string>();

    if (code !== 0 && stdout) {
        // Parse diagnostic lines to map errors to packages.  tsgo diagnostics look like:
        //   /absolute/path/to/file.ts(line,col): error TS1234: message
        for (const line of stdout.split("\n")) {
            const match = line.match(/^(.+?)\(\d+,\d+\):/);
            if (!match) {
                continue;
            }

            const filePath = resolve(match[1]);
            const relative = filePath.startsWith(workspacePath + "/")
                ? filePath.slice(workspacePath.length + 1)
                : undefined;

            if (relative === undefined) {
                continue;
            }

            // Extract the package directory — e.g. "packages/protocol/src/foo.ts" → "packages/protocol"
            const parts = relative.split("/");
            if (parts.length < 3) {
                continue;
            }
            const pkgDir = `${parts[0]}/${parts[1]}`;
            const pkgPath = join(workspacePath, pkgDir);

            const existing = errorsByPackage.get(pkgPath);
            errorsByPackage.set(pkgPath, existing ? `${existing}\n${line}` : line);
        }
    }

    return { ok: code === 0, outputsSkipped: code === 2, errorsByPackage, rawOutput: stdout };
}
