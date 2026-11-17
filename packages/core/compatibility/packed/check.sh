#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
consumer=$(mktemp -d)
trap 'rm -rf -- "$consumer"' EXIT
bun pm pack --filename "$consumer/core.tgz" --quiet
(cd ../memory && bun pm pack --filename "$consumer/memory.tgz" --quiet)
tar -xOf "$consumer/core.tgz" package/dist/LICENSE.effect-preview | cmp ../effect-preview/LICENSE -
cp compatibility/packed/consumer.mts "$consumer/"

effect_version=$(node -p 'require("./package.json").devDependencies.effect')
platform_version=$(node -p 'require("./package.json").devDependencies["@effect/platform-node-shared"]')
typescript_version=$(node -p 'require("../../package.json").devDependencies.typescript')
node_types_version=$(node -p 'require("./package.json").devDependencies["@types/node"]')

cd "$consumer"
unset NODE_PATH
echo '{"name":"packed-core-memory-consumer","private":true,"type":"module"}' > package.json
npm install --ignore-scripts --no-audit --no-fund --package-lock --save-exact ./core.tgz ./memory.tgz \
  "effect@$effect_version" "@effect/platform-node-shared@$platform_version" \
  "typescript@$typescript_version" "@types/node@$node_types_version"
node --input-type=commonjs <<'JS'
const assert = require("node:assert/strict")
const { createRequire } = require("node:module")
const { packages } = require("./package-lock.json")

assert.equal(packages["node_modules/@effect-vfs/core"].resolved, "file:core.tgz")
assert.equal(packages["node_modules/@effect-vfs/memory"].resolved, "file:memory.tgz")
const requireFromMemory = createRequire(require.resolve("@effect-vfs/memory/package.json"))
assert.equal(requireFromMemory.resolve("@effect-vfs/core/package.json"), require.resolve("@effect-vfs/core/package.json"))
JS
./node_modules/.bin/tsc --strict --types node --skipLibCheck false --target ESNext --module NodeNext --outDir out consumer.mts
node out/consumer.mjs
echo 'Packed core and memory passed strict NodeNext type checking, ESM imports and the filesystem workload.'
