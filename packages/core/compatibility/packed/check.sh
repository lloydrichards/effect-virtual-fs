#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
consumer=$(mktemp -d)
trap 'rm -rf -- "$consumer"' EXIT
bun pm pack --filename "$consumer/core.tgz" --quiet
cp compatibility/packed/consumer.mts "$consumer/"

effect_version=$(node -p 'require("./package.json").devDependencies.effect')
platform_version=$(node -p 'require("./package.json").devDependencies["@effect/platform-node-shared"]')
typescript_version=$(node -p 'require("../../package.json").devDependencies.typescript')
node_types_version=$(node -p 'require("./package.json").devDependencies["@types/node"]')

cd "$consumer"
unset NODE_PATH
echo '{"name":"packed-core-consumer","private":true,"type":"module"}' > package.json
npm install --ignore-scripts --no-audit --no-fund --save-exact ./core.tgz \
  "effect@$effect_version" "@effect/platform-node-shared@$platform_version" \
  "typescript@$typescript_version" "@types/node@$node_types_version"
./node_modules/.bin/tsc --strict --types node --skipLibCheck false --target ESNext --module NodeNext --outDir out consumer.mts
node out/consumer.mjs
echo 'Packed core passed strict NodeNext type checking, ESM imports and the file round-trip.'
