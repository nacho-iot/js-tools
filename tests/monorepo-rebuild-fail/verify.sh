#!/usr/bin/env bash
set -euo pipefail

# `version --apply` must fail when the workspace `prepare` rebuild fails, and must not strip dev-types.

cd "$(dirname "$0")"

grep -q '"dev-types"' packages/a/package.json || {
    echo "expected packages/a/package.json to contain dev-types pre-apply" >&2
    exit 1
}

# Arm the prepare script so the rebuild inside apply exits non-zero.
touch FAIL_REBUILD

echo "1.2.3" > version.txt

if nacho-build version --apply; then
    echo "ERROR: nacho-build version --apply succeeded despite the rebuild failing" >&2
    exit 1
fi

grep -q '"dev-types"' packages/a/package.json || {
    echo "ERROR: dev-types was stripped from packages/a/package.json despite rebuild failure" >&2
    cat packages/a/package.json >&2
    exit 1
}

rm -f FAIL_REBUILD
