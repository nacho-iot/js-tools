#!/usr/bin/env bash
set -euo pipefail

# `version --apply` must keep dev-types in package.json until after the workspace `prepare` rebuild.
# Package a exposes `.` only via `dev-types` so the clean rebuild fails with TS2307 on b's import of
# `@nacho-smoke/needs-dev-types-a` if dev-types is stripped first.

cd "$(dirname "$0")"

grep -q '"dev-types"' packages/a/package.json || {
    echo "expected packages/a/package.json to contain dev-types pre-apply" >&2
    exit 1
}

echo "1.2.3" > version.txt
nacho-build version --apply

if grep -q '"dev-types"' packages/a/package.json; then
    echo "ERROR: dev-types still in packages/a/package.json post-apply" >&2
    exit 1
fi
test -f packages/b/dist/esm/index.d.ts || {
    echo "ERROR: packages/b/dist/esm/index.d.ts missing — rebuild during apply did not run or failed" >&2
    exit 1
}
grep -q '"version": "1.2.3"' packages/a/package.json || {
    echo "ERROR: version not updated in packages/a/package.json" >&2
    exit 1
}
