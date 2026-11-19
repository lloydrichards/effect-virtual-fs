#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../../.."
root=$PWD
mkdir -p "$root/.cache"
stage=$(mktemp -d "$root/.cache/codemode-handoff.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT

archive="$root/.cache/core-overlay-merge-candidate.tgz"
(cd packages/core && bun pm pack --filename "$archive" --quiet)
mkdir -p "$stage/node_modules/@effect-vfs/core"
tar -xf "$archive" -C "$stage/node_modules/@effect-vfs/core" --strip-components=1
cp -R apps/demo-agent-tools/src apps/demo-agent-tools/test apps/demo-agent-tools/tsconfig.json "$stage/"
cd "$stage"
bun -e 'if (!import.meta.resolve("@effect-vfs/core").startsWith("file://" + process.cwd() + "/node_modules/")) process.exit(1)'
bun run tsc --noEmit
bun --bun run vitest run --root "$stage" --pool=threads test/mcp.test.ts -t 'packed Code Mode release handoff'
