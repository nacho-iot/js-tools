#!/usr/bin/env bash
set -euo pipefail

# A consumer pins its own typescript for editors and lint tooling.  js-tools type checks with the typescript@7 it
# carries internally, so both TS6 and TS7 consumers must build — see ../consumer-ts6 for the other half.
expected=7
actual=$(node -p "require('typescript/package.json').version")
case "$actual" in
    $expected.*) ;;
    *)
        echo "ERROR: fixture must exercise root typescript $expected.x but resolved $actual" >&2
        exit 1
        ;;
esac

nacho-build --clean

for f in \
    dist/esm/index.js \
    dist/esm/index.d.ts \
    dist/cjs/index.js \
    dist/cjs/index.d.ts
do
    test -f "$f" || { echo "missing $f" >&2; exit 1; }
done

# A transitive package that binds to the consumer's typescript crashes when its module loads, which happens for every
# command regardless of what the command does.  Exercise the ones that pull in third-party TypeScript consumers.
nacho-build cycles >/dev/null
nacho-build docs >/dev/null
