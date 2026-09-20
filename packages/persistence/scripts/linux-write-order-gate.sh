#!/usr/bin/env bash
# Model a storage device that reports successful writes and syncs but loses or reorders selected writes.
set -euo pipefail

[[ "$(uname -s)" == Linux ]] || { echo "Linux only: Bun's macOS SQLite build cannot load the VFS extension" >&2; exit 2; }

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
worker="${GATE_WORKER:-$repo_root/packages/persistence/test/fixtures/live-restart.ts}"
source_file="${GATE_SOURCE:-$repo_root/packages/persistence/test/fixtures/faultvfs.c}"
bun_bin="${GATE_BUN:-bun}"
output_dir="${GATE_OUTPUT_DIR:-$(mktemp -d -t effect-vfs-write-order-XXXXXX)}"
iterations="${GATE_ORDER_ITERATIONS:-2}"
writer_pid=""
[[ "$iterations" =~ ^[1-9][0-9]*$ ]] || { echo "GATE_ORDER_ITERATIONS must be positive" >&2; exit 2; }
mkdir -p "$output_dir"
cc -std=c11 -Wall -Wextra -Werror -fPIC -shared -o "$output_dir/faultvfs.so" "$source_file"

cleanup() {
  if [[ -n "$writer_pid" ]] && kill -0 "$writer_pid" 2>/dev/null; then
    kill -KILL "$writer_pid" 2>/dev/null || true
    wait "$writer_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

{
  printf 'model=SQLite VFS main-file write omission or next-write reordering; xSync returns underlying result\n'
  printf 'kernel=%s\n' "$(uname -srm)"
  printf 'os=%s\n' "$(. /etc/os-release && printf '%s' "$PRETTY_NAME")"
  printf 'filesystem=%s\n' "$(stat -f -c '%T' "$output_dir")"
  printf 'mount=%s\n' "$(findmnt -T "$output_dir" -n -o SOURCE,FSTYPE,OPTIONS)"
  printf 'bun=%s\n' "$("$bun_bin" --version)"
  printf 'driver=%s\n' "${GATE_DRIVER_VERSION:-$(cd "$repo_root" && bun -e 'import p from "./node_modules/@effect/sql-sqlite-bun/package.json"; console.log(p.version)')}"
  printf 'sqlite=%s\n' "$("$bun_bin" -e 'import { Database } from "bun:sqlite"; console.log(new Database(":memory:").query("SELECT sqlite_version() AS version").get().version)')"
  printf 'iterations=%s\n' "$iterations"
} > "$output_dir/environment.txt"

failures=0
for iteration in $(seq 1 "$iterations"); do
  for operation in lost-write reorder-write; do
    for after in 1 2 3; do
      case_dir="$output_dir/$iteration-$operation-$after"
      mkdir -p "$case_dir"
      database="$case_dir/live.sqlite"
      LIVE_STORE_MODE=write LIVE_STORE_FILE="$database" \
        LIVE_STORE_EVIDENCE_FILE="$case_dir/commit-connection-pragmas.txt" \
        "$bun_bin" "$worker" > "$case_dir/baseline.log"

      EFFECT_VFS_FAULT_OPERATION="$operation" EFFECT_VFS_FAULT_TARGET=main \
        EFFECT_VFS_FAULT_AFTER="$after" EFFECT_VFS_FAULT_LOG="$case_dir/hits.log" \
        LIVE_STORE_MODE=fault-write LIVE_STORE_FILE="$database" \
        LIVE_STORE_FAULT_VFS="$output_dir/faultvfs.so" \
        "$bun_bin" "$worker" > "$case_dir/writer.log" 2>&1 || true

      if ! grep -q "^$operation target=main" "$case_dir/hits.log" 2>/dev/null ||
        ! grep -q '^sync-ok target=main' "$case_dir/hits.log" 2>/dev/null ||
        { [[ "$operation" == reorder-write ]] &&
          ! grep -q '^reorder-applied target=main' "$case_dir/hits.log" 2>/dev/null; }; then
        printf 'UNREACHED iteration=%s operation=%s after=%s\n' "$iteration" "$operation" "$after"
        failures=$((failures + 1))
        continue
      fi

      outcome="$(grep -E '^(committed|StorageRejected|OutcomeUnknown)$' "$case_dir/writer.log" | head -1 || true)"
      if [[ -z "$outcome" ]]; then
        printf 'NO_OUTCOME iteration=%s operation=%s after=%s\n' "$iteration" "$operation" "$after"
        failures=$((failures + 1))
        continue
      fi

      LIVE_STORE_MODE=verify-fault LIVE_STORE_FILE="$database" "$bun_bin" "$worker" \
        > "$case_dir/reopen.log" 2>&1 || true
      recovered="$(grep -E '^recovered=(old|new)$' "$case_dir/reopen.log" | head -1 || true)"
      "$bun_bin" -e '
        import { Database } from "bun:sqlite"
        const db = new Database(process.argv[1])
        const check = db.query("PRAGMA integrity_check").get()
        if (check.integrity_check !== "ok") throw new Error(JSON.stringify(check))
        console.log("integrity_check=ok")
      ' "$database" > "$case_dir/integrity.txt" 2>&1 || true

      if [[ ! -s "$case_dir/integrity.txt" ]] || ! grep -q '^integrity_check=ok$' "$case_dir/integrity.txt" ||
        [[ -z "$recovered" ]] ||
        { [[ "$outcome" == committed && "$recovered" != recovered=new ]]; } ||
        { [[ "$outcome" == StorageRejected && "$recovered" != recovered=old ]]; }; then
        printf 'BREACH iteration=%s operation=%s after=%s outcome=%s recovered=%s\n' \
          "$iteration" "$operation" "$after" "$outcome" "${recovered:-reopen-failed}"
        failures=$((failures + 1))
      else
        printf 'PASS iteration=%s operation=%s after=%s outcome=%s %s\n' \
          "$iteration" "$operation" "$after" "$outcome" "$recovered"
      fi
    done

    for phase in pause-after-update pause-before-commit pause-after-commit; do
      case_dir="$output_dir/$iteration-$operation-$phase"
      mkdir -p "$case_dir"
      database="$case_dir/live.sqlite"
      LIVE_STORE_MODE=write LIVE_STORE_FILE="$database" \
        LIVE_STORE_EVIDENCE_FILE="$case_dir/commit-connection-pragmas.txt" \
        "$bun_bin" "$worker" > "$case_dir/baseline.log"

      EFFECT_VFS_FAULT_OPERATION="$operation" EFFECT_VFS_FAULT_TARGET=main \
        EFFECT_VFS_FAULT_AFTER=1 EFFECT_VFS_FAULT_LOG="$case_dir/hits.log" \
        LIVE_STORE_MODE="$phase" LIVE_STORE_FILE="$database" \
        LIVE_STORE_FAULT_VFS="$output_dir/faultvfs.so" \
        "$bun_bin" "$worker" > "$case_dir/writer.log" 2>&1 &
      writer_pid=$!
      marker="$database.$phase"
      [[ "$phase" == pause-before-commit ]] && marker="$database.before-commit"
      ready=false
      for _ in $(seq 1 200); do
        if [[ -s "$marker" ]]; then ready=true; break; fi
        if ! kill -0 "$writer_pid" 2>/dev/null; then break; fi
        sleep 0.05
      done
      kill -KILL "$writer_pid" 2>/dev/null || true
      wait "$writer_pid" 2>/dev/null || true
      writer_pid=""

      if [[ "$ready" != true ]]; then
        printf 'NO_PAUSE iteration=%s operation=%s phase=%s\n' "$iteration" "$operation" "$phase"
        failures=$((failures + 1))
        continue
      fi
      if [[ "$phase" == pause-after-commit ]] &&
        { ! grep -q "^$operation target=main" "$case_dir/hits.log" 2>/dev/null ||
          ! grep -q '^sync-ok target=main' "$case_dir/hits.log" 2>/dev/null ||
          { [[ "$operation" == reorder-write ]] &&
            ! grep -q '^reorder-applied target=main' "$case_dir/hits.log" 2>/dev/null; }; }; then
        printf 'UNREACHED iteration=%s operation=%s phase=%s\n' "$iteration" "$operation" "$phase"
        failures=$((failures + 1))
        continue
      fi

      recovered=""
      for mode in verify verify-pending; do
        if LIVE_STORE_MODE="$mode" LIVE_STORE_FILE="$database" "$bun_bin" "$worker" \
          > "$case_dir/$mode.log" 2>&1; then
          recovered="$mode"
          break
        fi
      done
      "$bun_bin" -e '
        import { Database } from "bun:sqlite"
        const check = new Database(process.argv[1]).query("PRAGMA integrity_check").get()
        if (check.integrity_check !== "ok") throw new Error(JSON.stringify(check))
        console.log("integrity_check=ok")
      ' "$database" > "$case_dir/integrity.txt" 2>&1 || true

      if [[ -z "$recovered" ]] || ! grep -q '^integrity_check=ok$' "$case_dir/integrity.txt" ||
        { [[ "$phase" != pause-after-commit && "$recovered" != verify ]]; }; then
        printf 'BREACH iteration=%s operation=%s phase=%s recovered=%s\n' \
          "$iteration" "$operation" "$phase" "${recovered:-reopen-failed}"
        failures=$((failures + 1))
      else
        printf 'PASS iteration=%s operation=%s phase=%s recovered=%s\n' \
          "$iteration" "$operation" "$phase" "$recovered"
      fi
    done
  done
done

printf 'Evidence: %s\n' "$output_dir"
printf 'Invariant breaches or unreachable injections: %s\n' "$failures"
[[ "$failures" == 0 ]]
