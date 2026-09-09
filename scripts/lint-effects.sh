#!/usr/bin/env bash
set -eu

# Oxlint does not apply the language-service function preference in this TSGo pin.
effect_options='{"diagnostics":true,"effectFn":["untraced"],"diagnosticSeverity":{"effectFnOpportunity":"error","lazyEffect":"error","allOfMapToForEach":"error"}}'
for project in packages/core packages/memory packages/persistence apps/virtual-build apps/scratchpad; do
  bun run effect-tsgo diagnostics --project "$project/tsconfig.json" --lspconfig "$effect_options"
done
