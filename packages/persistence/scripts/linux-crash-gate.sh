#!/usr/bin/env bash
# Process-death recovery gate for the real Bun SQLite live-image provider.
# A hosted runner cannot retain its disk after its guest OS is stopped.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
worker="$repo_root/packages/persistence/test/fixtures/live-restart.ts"
iterations="${GATE_ITERATIONS:-10}"
output_dir="${GATE_OUTPUT_DIR:-$(mktemp -d -t effect-vfs-crash-gate-XXXXXX)}"
writer_pid=""

[[ "$iterations" =~ ^[1-9][0-9]*$ ]] || { echo "GATE_ITERATIONS must be a positive integer" >&2; exit 2; }
mkdir -p "$output_dir"

cleanup() {
  if [[ -n "$writer_pid" ]] && kill -0 "$writer_pid" 2>/dev/null; then
    kill -KILL "$writer_pid" 2>/dev/null || true
    wait "$writer_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

{
  printf 'gate=linux-process-death\n'
  printf 'kernel=%s\n' "$(uname -srm)"
  if [[ -f /etc/os-release ]]; then
    printf 'os=%s\n' "$(. /etc/os-release && printf '%s' "$PRETTY_NAME")"
  else
    printf 'os=%s\n' "$(sw_vers -productName) $(sw_vers -productVersion)"
  fi
  printf 'bun=%s\n' "$(bun --version)"
  if [[ "$(uname -s)" == Linux ]]; then
    printf 'filesystem=%s\n' "$(stat -f -c '%T' "$output_dir")"
    printf 'mount=%s\n' "$(findmnt -T "$output_dir" -n -o SOURCE,FSTYPE,OPTIONS)"
    printf 'block_devices=%s\n' "$(lsblk -dn -o NAME,TRAN,TYPE,SIZE | tr '\n' ';')"
  else
    printf 'filesystem=%s\n' "$(stat -f '%T' "$output_dir")"
  fi
  printf 'iterations=%s\n' "$iterations"
  printf 'runner_image=%s\n' "${ImageOS:-unknown} ${ImageVersion:-unknown}"
  printf 'driver=%s\n' "$(cd "$repo_root" && bun -e 'import p from "./node_modules/@effect/sql-sqlite-bun/package.json"; console.log(p.version)')"
  printf 'sqlite=%s\n' "$(cd "$repo_root" && bun -e 'import { Database } from "bun:sqlite"; console.log(new Database(":memory:").query("SELECT sqlite_version() AS version").get().version)')"
} > "$output_dir/environment.txt"

verify_sqlite() {
  local database="$1"
  bun -e '
    import { Database } from "bun:sqlite"
    import { createHash } from "node:crypto"
    const db = new Database(process.argv[1])
    const check = db.query("PRAGMA integrity_check").get()
    if (check.integrity_check !== "ok") throw new Error(JSON.stringify(check))
    const row = db.query("SELECT generation, image, digest FROM effect_vfs_live_image WHERE id = 1").get()
    // The provider reopens first. Its read may persist an access-time update.
    if (!row || row.generation < Number(process.argv[2]) || row.generation > Number(process.argv[2]) + 1) {
      throw new Error(JSON.stringify({ generation: row?.generation, expected: process.argv[2] }))
    }
    const digest = createHash("sha256").update(row.image).digest("hex")
    if (digest !== row.digest) throw new Error(`digest: ${digest} != ${row.digest}`)
    console.log(JSON.stringify({ integrity: check.integrity_check, generation: row.generation, digest }))
  ' "$database" "$2"
}

for iteration in $(seq 1 "$iterations"); do
  for phase in pause-after-update pause-before-commit pause-after-commit acknowledged; do
    case_dir="$output_dir/$iteration-$phase"
    mkdir -p "$case_dir"
    database="$case_dir/live.sqlite"
    if [[ "$phase" != acknowledged ]]; then
      LIVE_STORE_MODE=write LIVE_STORE_FILE="$database" \
        LIVE_STORE_EVIDENCE_FILE="$case_dir/commit-connection-pragmas.txt" \
        bun "$worker" > "$case_dir/baseline.log"
    fi

    if [[ "$phase" == acknowledged ]]; then
      LIVE_STORE_MODE=write-hold LIVE_STORE_FILE="$database" \
        LIVE_STORE_EVIDENCE_FILE="$case_dir/commit-connection-pragmas.txt" \
        bun "$worker" > "$case_dir/writer.log" 2>&1 &
      writer_pid=$!
      marker="$case_dir/writer.log"
    else
      LIVE_STORE_MODE="$phase" LIVE_STORE_FILE="$database" \
        LIVE_STORE_EVIDENCE_FILE="$case_dir/commit-connection-pragmas.txt" \
        bun "$worker" > "$case_dir/writer.log" 2>&1 &
      writer_pid=$!
      marker="$database.${phase/pause-before-commit/before-commit}"
    fi

    ready=false
    for _ in $(seq 1 200); do
      if [[ -s "$marker" ]]; then ready=true; break; fi
      if ! kill -0 "$writer_pid" 2>/dev/null; then break; fi
      sleep 0.05
    done
    if [[ "$ready" != true ]]; then
      cat "$case_dir/writer.log" >&2
      echo "Writer did not reach $phase in iteration $iteration" >&2
      exit 1
    fi

    if [[ -e "$database-journal" ]]; then
      if [[ "$(uname -s)" == Linux ]]; then
        stat -c 'journal_bytes=%s' "$database-journal" > "$case_dir/journal.txt"
      else
        stat -f 'journal_bytes=%z' "$database-journal" > "$case_dir/journal.txt"
      fi
    fi
    kill -KILL "$writer_pid"
    wait "$writer_pid" 2>/dev/null || true
    writer_pid=""

    if [[ "$phase" == pause-after-commit ]]; then
      expected_mode=verify-pending
      expected_generation=2
    else
      expected_mode=verify
      expected_generation=1
    fi
    LIVE_STORE_MODE="$expected_mode" LIVE_STORE_FILE="$database" bun "$worker" > "$case_dir/reopen.log"
    verify_sqlite "$database" "$expected_generation" > "$case_dir/integrity.json"
    printf 'PASS iteration=%s phase=%s\n' "$iteration" "$phase"
  done
done

printf 'Evidence: %s\n' "$output_dir"
