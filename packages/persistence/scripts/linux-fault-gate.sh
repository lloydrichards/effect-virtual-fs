#!/usr/bin/env bash
# Inject real SQLite VFS write and sync failures under bun:sqlite.
set -euo pipefail

[[ "$(uname -s)" == Linux ]] || { echo "Linux only" >&2; exit 2; }

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
worker="$repo_root/packages/persistence/test/fixtures/live-restart.ts"
source_file="$repo_root/packages/persistence/test/fixtures/faultvfs.c"
output_dir="${GATE_OUTPUT_DIR:-$(mktemp -d -t effect-vfs-fault-gate-XXXXXX)}"
iterations="${GATE_FAULT_ITERATIONS:-3}"
[[ "$iterations" =~ ^[1-9][0-9]*$ ]] || { echo "GATE_FAULT_ITERATIONS must be positive" >&2; exit 2; }
mkdir -p "$output_dir"

cc -std=c11 -Wall -Wextra -Werror -fPIC -shared -o "$output_dir/faultvfs.so" "$source_file"

for iteration in $(seq 1 "$iterations"); do
  for case in write-journal write-main sync-journal sync-main persistent-write-main; do
    case_dir="$output_dir/$iteration-$case"
    mkdir -p "$case_dir"
    database="$case_dir/live.sqlite"
    LIVE_STORE_MODE=write LIVE_STORE_FILE="$database" bun "$worker" > "$case_dir/baseline.log"

    persistent=""
    operation="${case%%-*}"
    target="${case#*-}"
    if [[ "$operation" == persistent ]]; then
      persistent=1
      operation=write
      target=main
    fi

    EFFECT_VFS_FAULT_OPERATION="$operation" EFFECT_VFS_FAULT_TARGET="$target" \
      EFFECT_VFS_FAULT_AFTER=1 EFFECT_VFS_FAULT_PERSISTENT="$persistent" \
      EFFECT_VFS_FAULT_LOG="$case_dir/hits.log" \
      LIVE_STORE_MODE=fault-write LIVE_STORE_FILE="$database" \
      LIVE_STORE_FAULT_VFS="$output_dir/faultvfs.so" \
      bun "$worker" > "$case_dir/writer.log" 2>&1

    [[ -s "$case_dir/hits.log" ]] || { echo "VFS fault did not fire: $case" >&2; exit 1; }
    if [[ "$persistent" == 1 && "$(wc -l < "$case_dir/hits.log")" -lt 2 ]]; then
      echo "Persistent write fault did not reach rollback: $case" >&2
      exit 1
    fi
    outcome="$(grep -E '^(committed|StorageRejected|OutcomeUnknown)$' "$case_dir/writer.log" | head -1)"
    [[ -n "$outcome" ]] || { cat "$case_dir/writer.log" >&2; exit 1; }

    LIVE_STORE_MODE=verify-fault LIVE_STORE_FILE="$database" bun "$worker" > "$case_dir/reopen.log"
    recovered="$(grep -E '^recovered=(old|new)$' "$case_dir/reopen.log" | head -1)"
    [[ -n "$recovered" ]] || { cat "$case_dir/reopen.log" >&2; exit 1; }
    if [[ "$outcome" == committed && "$recovered" != recovered=new ]] ||
      [[ "$outcome" == StorageRejected && "$recovered" != recovered=old ]]; then
      echo "Inconsistent $case: $outcome, $recovered" >&2
      exit 1
    fi

    bun -e '
      import { Database } from "bun:sqlite"
      const db = new Database(process.argv[1])
      const check = db.query("PRAGMA integrity_check").get()
      if (check.integrity_check !== "ok") throw new Error(JSON.stringify(check))
      console.log("integrity_check=ok")
    ' "$database" > "$case_dir/integrity.txt"

    printf 'PASS iteration=%s case=%s outcome=%s %s\n' "$iteration" "$case" "$outcome" "$recovered"
  done
done

printf 'Evidence: %s\n' "$output_dir"
