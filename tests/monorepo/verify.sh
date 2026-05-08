#!/usr/bin/env bash
set -euo pipefail

nacho-build --clean

for f in \
    packages/a/dist/esm/index.js \
    packages/a/dist/esm/index.d.ts \
    packages/a/dist/esm/extras.d.ts \
    packages/a/dist/cjs/index.js \
    packages/a/dist/cjs/extras.d.ts \
    packages/b/dist/esm/index.js \
    packages/b/dist/esm/index.d.ts \
    packages/b/dist/esm/extras.d.ts \
    packages/b/dist/cjs/index.js \
    packages/b/dist/cjs/extras.d.ts
do
    test -f "$f" || { echo "missing $f" >&2; exit 1; }
done

# nacho-build syncs tsconfig project references to follow package deps.  After
# the build, b/src/tsconfig.json should reference a/src.
grep -q '"path": "../../a/src"' packages/b/src/tsconfig.json || {
    echo "expected b's tsconfig to reference packages/a/src after sync" >&2
    cat packages/b/src/tsconfig.json >&2
    exit 1
}

sleep 1
ref=$(mktemp)
nacho-build
changed=$(find packages/*/dist packages/*/build -newer "$ref" -type f 2>/dev/null || true)
if [ -n "$changed" ]; then
    echo "ERROR: second build regenerated files:" >&2
    echo "$changed" >&2
    exit 1
fi

# `version --apply` must strip dev-types AFTER the workspace `prepare` rebuild.  The prepare script writes
# DEV_TYPES_PRESENT_DURING_PREPARE iff dev-types was still in packages/a/package.json when it ran.
grep -q '"dev-types"' packages/a/package.json || {
    echo "expected packages/a/package.json to contain dev-types pre-apply" >&2
    exit 1
}
rm -f DEV_TYPES_PRESENT_DURING_PREPARE
echo "1.2.3" > version.txt
nacho-build version --apply
test -f DEV_TYPES_PRESENT_DURING_PREPARE || {
    echo "ERROR: dev-types was already stripped before the rebuild ran during nacho-build version --apply" >&2
    exit 1
}
if grep -q '"dev-types"' packages/a/package.json; then
    echo "ERROR: nacho-build version --apply did not strip dev-types from packages/a/package.json" >&2
    cat packages/a/package.json >&2
    exit 1
fi
grep -q '"version": "1.2.3"' packages/a/package.json || {
    echo "ERROR: nacho-build version --apply did not update version in packages/a/package.json" >&2
    cat packages/a/package.json >&2
    exit 1
}

# --bump derives the next version from version.txt
for case in "patch 0.5.7 0.5.8" "minor 0.5.7 0.6.0" "major 0.5.7 1.0.0"; do
    set -- $case
    kind=$1 from=$2 want=$3
    echo "$from" > version.txt
    nacho-build version --bump "$kind" --set
    got=$(cat version.txt)
    if [ "$got" != "$want" ]; then
        echo "ERROR: --bump $kind from $from: expected $want, got $got" >&2
        exit 1
    fi
done

# explicit version overrides --bump
echo "0.5.7" > version.txt
nacho-build version 9.9.9 --bump major --set
got=$(cat version.txt)
if [ "$got" != "9.9.9" ]; then
    echo "ERROR: explicit version should override --bump, got $got" >&2
    exit 1
fi
