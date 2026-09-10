#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "${script_dir}/../../../.." && pwd)"

cd "${repository_root}"

npx --yes okf-graph@0.2.0 validate .okf --json
npx --yes okf-graph@0.2.0 eval .okf --json

for concept_id in "$@"; do
  npx --yes okf-graph@0.2.0 graph neighbors .okf "${concept_id}" --json
done
