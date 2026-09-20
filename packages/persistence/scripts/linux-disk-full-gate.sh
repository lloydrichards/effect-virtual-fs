#!/usr/bin/env bash
# Exercise the real Bun SQLite provider when its journal or image cannot grow.
# Mount and fill only a disposable tmpfs; never fill the runner's root disk.
set -euo pipefail

[[ "$(uname -s)" == Linux ]] || { echo "Linux only" >&2; exit 2; }

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
worker="${GATE_WORKER:-$repo_root/packages/persistence/test/fixtures/live-restart.ts}"
source_file="${GATE_SOURCE:-$repo_root/packages/persistence/test/fixtures/faultvfs.c}"
bun_bin="${GATE_BUN:-bun}"
output_dir="${GATE_OUTPUT_DIR:-$(mktemp -d -t effect-vfs-disk-full-XXXXXX)}"
mountpoint="$(mktemp -d -t effect-vfs-disk-full-mount-XXXXXX)"
writer_pid=""
mounted=false
mkdir -p "$output_dir"
cc -std=c11 -Wall -Wextra -Werror -fPIC -shared -o "$output_dir/faultvfs.so" "$source_file"

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

LIVE_STORE_MODE=write LIVE_STORE_FILE="$database" "$bun_bin" "$worker" > "$output_dir/baseline.log"
LIVE_STORE_MODE=pause-before-commit LIVE_STORE_FILE="$database" \
  LIVE_STORE_EVIDENCE_FILE="$output_dir/commit-connection-pragmas.txt" \
  LIVE_STORE_FAULT_VFS="$output_dir/faultvfs.so" \
  EFFECT_VFS_FAULT_OPERATION=observe EFFECT_VFS_FAULT_TARGET=journal \
  EFFECT_VFS_FAULT_LOG="$output_dir/journal-writes.txt" \
  "$bun_bin" "$worker" > "$output_dir/journal-writer.log" 2>&1 &
writer_pid=$!
for _ in $(seq 1 200); do
  if [[ -s "$database.before-commit" ]]; then break; fi
  if ! kill -0 "$writer_pid" 2>/dev/null; then
    cat "$output_dir/journal-writer.log" >&2
    echo "Writer exited before the journal measurement" >&2
    exit 1
  fi
  sleep 0.05
done
[[ -s "$database.before-commit" ]] || { echo "Writer did not reach the journal measurement" >&2; exit 1; }
find "$mountpoint" -maxdepth 1 -type f -printf '%f %s bytes\n' > "$output_dir/files-during-transaction.txt"
[[ -f "$database-journal" ]] || { echo "Missing rollback journal at transaction pause" >&2; exit 1; }
stat -c '%s' "$database-journal" > "$output_dir/journal-bytes-at-pause.txt"
kill -KILL "$writer_pid" 2>/dev/null || true
wait "$writer_pid" 2>/dev/null || true
writer_pid=""
LIVE_STORE_MODE=verify LIVE_STORE_FILE="$database" "$bun_bin" "$worker" > "$output_dir/recovered-before-limit.log"

page_size="$(grep '^page_size=' "$output_dir/commit-connection-pragmas.txt" | cut -d= -f2)"
[[ "$page_size" =~ ^[0-9]+$ ]] && (( page_size > 0 )) || { echo "Invalid page size: $page_size" >&2; exit 1; }
database_cap=2000000 # live-restart.ts uses ByteSize.megabytes(2).
sector_allowance=65536
provision="$((database_cap + sector_allowance + (database_cap / page_size) * (page_size + 8)))"
available="$(df -B1 --output=avail "$mountpoint" | tail -n 1 | tr -d ' ')"
[[ "$available" =~ ^[0-9]+$ ]] && (( available > provision + 4096 )) || {
  echo "Not enough space for near-budget case: $available" >&2
  exit 1
}
fallocate -l "$((available - provision - 4096))" "$mountpoint/filler"
df -B1 "$mountpoint" > "$output_dir/space-near-budget.txt"
near_available="$(df -B1 --output=avail "$mountpoint" | tail -n 1 | tr -d ' ')"
(( near_available >= provision && near_available <= provision + 8192 )) || {
  echo "Near-budget free space missed the provision: $near_available" >&2
  exit 1
}
printf 'database_cap=%s\npage_size=%s\nsector_allowance=%s\nprovision=%s\n' \
  "$database_cap" "$page_size" "$sector_allowance" "$provision" > "$output_dir/space-policy.txt"
LIVE_STORE_MODE=fault-write LIVE_STORE_FILE="$database" \
  LIVE_STORE_FAULT_VFS="$output_dir/faultvfs.so" \
  EFFECT_VFS_FAULT_OPERATION=observe EFFECT_VFS_FAULT_TARGET=journal \
  EFFECT_VFS_FAULT_LOG="$output_dir/journal-writes-near-budget.txt" \
  "$bun_bin" "$worker" > "$output_dir/near-budget-writer.log"
grep -q '^committed$' "$output_dir/near-budget-writer.log"
rm "$mountpoint/filler"
LIVE_STORE_MODE=verify-fault LIVE_STORE_FILE="$database" "$bun_bin" "$worker" \
  > "$output_dir/near-budget-reopen.log"
grep -q '^recovered=new$' "$output_dir/near-budget-reopen.log"

LIVE_STORE_MODE=disk-full LIVE_STORE_FILE="$database" \
  LIVE_STORE_FAULT_VFS="$output_dir/faultvfs.so" \
  EFFECT_VFS_FAULT_OPERATION=observe EFFECT_VFS_FAULT_TARGET=journal \
  EFFECT_VFS_FAULT_LOG="$output_dir/journal-writes-at-limit.txt" \
  "$bun_bin" "$worker" > "$output_dir/writer.log" 2>&1 &
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

awk -F '[= ]' '/^write-end bytes=/{ if ($3 > maximum) maximum=$3 } END { print maximum + 0 }' \
  "$output_dir/journal-writes.txt" "$output_dir/journal-writes-near-budget.txt" \
  "$output_dir/journal-writes-at-limit.txt" \
  > "$output_dir/maximum-journal-write-end.txt"

outcome="$(grep -E '^(StorageRejected|OutcomeUnknown)$' "$output_dir/writer.log" | head -1 || true)"
if [[ -z "$outcome" ]]; then
  cat "$output_dir/writer.log" >&2
  echo "No classified disk-full outcome" >&2
  exit 1
fi

rm "$mountpoint/filler"
LIVE_STORE_MODE=verify-disk-full LIVE_STORE_FILE="$database" "$bun_bin" "$worker" > "$output_dir/reopen.log"
recovered="$(grep -E '^recovered=(old|new)$' "$output_dir/reopen.log" | head -1 || true)"
[[ -n "$recovered" ]] || { cat "$output_dir/reopen.log" >&2; exit 1; }
if [[ "$outcome" == StorageRejected && "$recovered" != recovered=old ]]; then
  echo "Inconsistent disk-full recovery: $outcome, $recovered" >&2
  exit 1
fi

"$bun_bin" -e '
  import { Database } from "bun:sqlite"
  const db = new Database(process.argv[1])
  const check = db.query("PRAGMA integrity_check").get()
  if (check.integrity_check !== "ok") throw new Error(JSON.stringify(check))
  console.log("integrity_check=ok")
' "$database" > "$output_dir/integrity.txt"

printf 'PASS disk-full outcome=%s %s\n' "$outcome" "$recovered"
printf 'journal_bytes_at_pause=%s\n' "$(cat "$output_dir/journal-bytes-at-pause.txt")"
printf 'maximum_journal_write_end=%s\n' "$(cat "$output_dir/maximum-journal-write-end.txt")"
printf 'Evidence: %s\n' "$output_dir"
