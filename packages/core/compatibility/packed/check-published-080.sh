#!/usr/bin/env bash
set -euo pipefail

fixtures=$(cd "$(dirname "$0")" && pwd)
consumer=$(mktemp -d)
trap 'rm -rf -- "$consumer"' EXIT
cp "$fixtures"/{published-080,manifest-workload}.mts "$consumer/"

cd "$consumer"
unset NODE_PATH
echo '{"name":"published-core-memory-080-consumer","private":true,"type":"module"}' > package.json
node --version
npm --version
npm install --registry https://registry.npmjs.org --ignore-scripts --no-audit --no-fund --package-lock --save-exact \
  @effect-vfs/core@0.8.0 @effect-vfs/memory@0.8.0 effect@4.0.0 @effect/platform-node-shared@4.0.0 \
  typescript@7.0.2 @types/node@26.6.3
node --input-type=commonjs <<'JS'
const assert = require("node:assert/strict")
const { createRequire } = require("node:module")
const path = require("node:path")
const { packages } = require("./package-lock.json")

for (const [name, version] of Object.entries(require("./package.json").dependencies)) {
  const installed = packages["node_modules/" + name]
  assert.equal(installed.version, version)
  assert.equal(new URL(installed.resolved).origin, "https://registry.npmjs.org")
  assert.ok(installed.integrity)
}

const core = require.resolve("@effect-vfs/core/package.json")
const memory = require.resolve("@effect-vfs/memory/package.json")
for (const manifest of [core, memory]) {
  assert.ok(manifest.startsWith(path.join(process.cwd(), "node_modules") + path.sep))
  const fromPackage = createRequire(manifest)
  assert.equal(fromPackage.resolve("effect"), require.resolve("effect"))
}
assert.equal(createRequire(memory).resolve("@effect-vfs/core/package.json"), core)
JS
./node_modules/.bin/tsc --strict --types node --skipLibCheck false --target ESNext --module NodeNext --outDir out published-080.mts
node out/published-080.mjs
echo 'Registry core and memory 0.8.0 passed strict NodeNext type checking, ESM imports and the filesystem workload.'
