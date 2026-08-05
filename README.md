# @nacho-iot/js-tools

Build, run, and versioning tooling for TypeScript projects and monorepos, extracted from [matter.js](https://github.com/matter-js/matter.js).

Supports both flat single-package repos and multi-package npm workspaces.

## CLI commands

* `nacho-build` -- build TypeScript packages (type checking, ESM/CJS transpilation); includes subcommands for
  workspace maintenance (`configure`, `relock`, `version`, `cycles`, etc.)
* `nacho-run` -- run a TypeScript script with automatic transpilation and source maps

## License

Apache-2.0
