#!/usr/bin/env bash
# Exercise the real Bun SQLite provider when its journal or image cannot grow.
# Mount and fill only a disposable tmpfs; never fill the runner's root disk.
set -euo pipefail

[[ "$(uname -s)" == Linux ]] || { echo "Linux only" >&2; exit 2; }

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
worker="$repo_root/packages/persistence/test/fixtures/live-restart.ts"
output_dir="${GATE_OUTPUT_DIR:-$(mktemp -d -t effect-vfs-disk-full-XXXXXX)}"
mountpoint="$(mktemp -d -t effect-vfs-disk-full-mount-XXXXXX)"
writer_pid=""
mounted=false
mkdir -p "$output_dir"

cleanup() {
  if [[ -n "$writer_pid" ]] && kill -0 "$writer_pid" 2>/dev/null; then
    kill -KILL "$writer_pid" 2>/dev/null || true
    wait "$writer_pid" 2>/dev/null || true
  fi
  if [[ "$mounted" == true ]]; then sudo umount "$mountpoint"; fi
  rmdir "$mountpoint" 2>/dev/null || true
}
trap cleanup EXIT

sudo mount -t tmpfs -o size=4m,mode=0777 tmpfs "$mountpoint"
mounted=true
database="$mountpoint/live.sqlite"

LIVE_STORE_MODE=write LIVE_STORE_FILE="$database" bun "$worker" > "$output_dir/baseline.log"
LIVE_STORE_MODE=disk-full LIVE_STORE_FILE="$database" bun "$worker" > "$output_dir/writer.log" 2>&1 &
writer_pid=$!

for _ in $(seq 1 200); do
  if [[ -s "$database.ready" ]]; then break; fi
  if ! kill -0 "$writer_pid" 2>/dev/null; then
    cat "$output_dir/writer.log" >&2
    echo "Writer exited before the disk-full point" >&2
    exit 1
  fi
  sleep 0.05
done
[[ -s "$database.ready" ]] || { echo "Writer did not reach the disk-full point" >&2; exit 1; }

available="$(df -B1 --output=avail "$mountpoint" | tail -n 1 | tr -d ' ')"
[[ "$available" =~ ^[0-9]+$ ]] && (( available > 8192 )) || { echo "Unexpected free space: $available" >&2; exit 1; }
fallocate -l "$((available - 4096))" "$mountpoint/filler"
df -B1 "$mountpoint" > "$output_dir/space-at-write.txt"
find "$mountpoint" -maxdepth 1 -type f -printf '%f %s bytes\n' > "$output_dir/files-at-write.txt"

touch "$database.resume"
wait "$writer_pid"
writer_pid=""

outcome="$(grep -E '^(StorageRejected|OutcomeUnknown)$' "$output_dir/writer.log" | head -1 || true)"
if [[ -z "$outcome" ]]; then
  cat "$output_dir/writer.log" >&2
  echo "No classified disk-full outcome" >&2
  exit 1
fi

rm "$mountpoint/filler"
LIVE_STORE_MODE=verify-disk-full LIVE_STORE_FILE="$database" bun "$worker" > "$output_dir/reopen.log"
recovered="$(grep -E '^recovered=(old|new)$' "$output_dir/reopen.log" | head -1 || true)"
[[ -n "$recovered" ]] || { cat "$output_dir/reopen.log" >&2; exit 1; }
if [[ "$outcome" == StorageRejected && "$recovered" != recovered=old ]]; then
  echo "Inconsistent disk-full recovery: $outcome, $recovered" >&2
  exit 1
fi

bun -e '
  import { Database } from "bun:sqlite"
  const db = new Database(process.argv[1])
  const check = db.query("PRAGMA integrity_check").get()
  if (check.integrity_check !== "ok") throw new Error(JSON.stringify(check))
  console.log("integrity_check=ok")
' "$database" > "$output_dir/integrity.txt"

printf 'PASS disk-full outcome=%s %s\n' "$outcome" "$recovered"
printf 'Evidence: %s\n' "$output_dir"
