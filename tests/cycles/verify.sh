#!/usr/bin/env bash
set -euo pipefail

nacho-build --clean

log=$(mktemp)
nacho-build cycles >"$log" 2>&1

fail() {
    echo "ERROR: $1" >&2
    cat "$log" >&2
    exit 1
}

grep -q "Cycles detected:" "$log" || fail "expected a cycle report"

# value-a ⇄ value-b via a plain import and an `export * from` re-export
# mixed-g ⇄ mixed-h via an import mixing type and value bindings
for f in value-a value-b mixed-g mixed-h; do
    grep -q "$f" "$log" || fail "expected $f in the cycle report"
done

# `import type` edges are not real dependencies, so type-c ⇄ type-d is not a cycle
# `export type ... from` is likewise erased, so texp-k ⇄ texp-l and texp-m ⇄ texp-n are not cycles
# `import()` is lazy, so lazy-e ⇄ lazy-f is not a cycle
# `import {} from` is erased by esbuild, so empty-i ⇄ empty-j is not a cycle in the emitted JS
for f in type-c type-d texp-k texp-l texp-m texp-n lazy-e lazy-f empty-i empty-j; do
    if grep -q "$f" "$log"; then
        fail "$f must not be reported as a cycle"
    fi
done
