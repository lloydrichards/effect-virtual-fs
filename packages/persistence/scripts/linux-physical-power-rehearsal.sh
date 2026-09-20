#!/usr/bin/env bash
# Exercise the physical-power case runner without a reboot or power cut.
set -euo pipefail

[[ "$(uname -s)" == Linux ]] || { echo "Linux only" >&2; exit 2; }
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
gate="$repo_root/packages/persistence/scripts/physical-power-gate.sh"
output_dir="${GATE_OUTPUT_DIR:-$(mktemp -d -t effect-vfs-physical-rehearsal-XXXXXX)}"
mkdir -p "$output_dir"

for phase in pause-after-update pause-before-commit pause-after-commit acknowledged; do
  case_dir="$output_dir/$phase"
  GATE_DISPOSABLE=1 GATE_REHEARSAL=1 bash "$gate" prepare "$phase" "$case_dir"
  kill -KILL "$(cat "$case_dir/writer.pid")"
  GATE_DISPOSABLE=1 GATE_REHEARSAL=1 bash "$gate" verify "$phase" "$case_dir"
done

printf 'Rehearsal evidence: %s\n' "$output_dir"
