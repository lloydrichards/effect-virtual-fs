#!/usr/bin/env bash
# Run one live-image recovery case across a real machine power cut.
# This script never cuts power and never removes an existing database.
set -euo pipefail

[[ "$(uname -s)" == Linux ]] || { echo "Linux only" >&2; exit 2; }

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
worker="$repo_root/packages/persistence/test/fixtures/live-restart.ts"
bun_bin="${GATE_BUN:-bun}"
action="${1:-}"
phase="${2:-}"
case_dir="${3:-}"

usage() {
  echo "Usage: GATE_DISPOSABLE=1 $0 prepare|verify phase /absolute/path/on/disposable/mount/case" >&2
  exit 2
}

[[ "$action" == prepare || "$action" == verify ]] || usage
case "$phase" in
  pause-after-update|pause-before-commit|pause-after-commit|acknowledged) ;;
  *) usage ;;
esac
[[ "$case_dir" == /* && "$case_dir" != / && "$case_dir" != "$HOME" ]] || usage
[[ "${GATE_DISPOSABLE:-}" == 1 ]] || { echo "Set GATE_DISPOSABLE=1 for a disposable storage mount" >&2; exit 2; }
command -v "$bun_bin" >/dev/null
command -v findmnt >/dev/null

if [[ "$action" == prepare ]]; then
  [[ ! -e "$case_dir" ]] || { echo "Case directory already exists: $case_dir" >&2; exit 2; }
  [[ -d "$(dirname "$case_dir")" ]] || { echo "Case parent directory does not exist" >&2; exit 2; }
  parent_mount="$(findmnt -T "$(dirname "$case_dir")" -n -o TARGET)"
  [[ "$parent_mount" != / && -n "$parent_mount" || "${GATE_REHEARSAL:-}" == 1 ]] || {
    echo "Use a dedicated disposable mount, not the machine's root filesystem" >&2
    exit 2
  }
  mkdir "$case_dir"
fi

[[ -d "$case_dir" ]] || { echo "Case directory does not exist: $case_dir" >&2; exit 2; }
mount_target="$(findmnt -T "$case_dir" -n -o TARGET)"
[[ "$mount_target" != / && -n "$mount_target" || "${GATE_REHEARSAL:-}" == 1 ]] || {
  echo "Use a dedicated disposable mount, not the machine's root filesystem" >&2
  exit 2
}

database="$case_dir/live.sqlite"
export LIVE_STORE_SYNC_DIRECTORY=1

if [[ "$action" == prepare ]]; then
  printf '%s\n' "$phase" > "$case_dir/phase.txt"
  {
    printf 'commit=%s\n' "$(git -C "$repo_root" rev-parse HEAD)"
    printf 'kernel=%s\n' "$(uname -srm)"
    printf 'os=%s\n' "$(. /etc/os-release && printf '%s' "$PRETTY_NAME")"
    printf 'bun=%s\n' "$("$bun_bin" --version)"
    printf 'sqlite=%s\n' "$("$bun_bin" -e 'import { Database } from "bun:sqlite"; console.log(new Database(":memory:").query("SELECT sqlite_version() AS version").get().version)')"
    printf 'driver=%s\n' "$(cd "$repo_root" && "$bun_bin" -e 'import p from "./node_modules/@effect/sql-sqlite-bun/package.json"; console.log(p.version)')"
    printf 'mount=%s\n' "$(findmnt -T "$case_dir" -n -o SOURCE,FSTYPE,OPTIONS)"
    printf 'block_devices=%s\n' "$(lsblk -dn -o NAME,TRAN,TYPE,SIZE | tr '\n' ';')"
  } > "$case_dir/environment.txt"
  cat /proc/sys/kernel/random/boot_id > "$case_dir/boot-id-before.txt"

  if [[ "$phase" != acknowledged ]]; then
    LIVE_STORE_MODE=write LIVE_STORE_FILE="$database" "$bun_bin" "$worker" > "$case_dir/baseline.log" 2>&1
    grep -q '^directory_sync=ok ' "$case_dir/baseline.log"
  fi

  # Make the fixture and case setup durable before starting the operation under test.
  sync

  if [[ "$phase" == acknowledged ]]; then
    mode=write-hold
    marker="$case_dir/writer.log"
  else
    mode="$phase"
    marker="$database.$phase"
    [[ "$phase" == pause-before-commit ]] && marker="$database.before-commit"
  fi

  nohup env LIVE_STORE_SYNC_DIRECTORY=1 LIVE_STORE_MODE="$mode" LIVE_STORE_FILE="$database" \
    LIVE_STORE_EVIDENCE_FILE="$case_dir/commit-connection-pragmas.txt" \
    "$bun_bin" "$worker" > "$case_dir/writer.log" 2>&1 < /dev/null &
  writer_pid=$!
  printf '%s\n' "$writer_pid" > "$case_dir/writer.pid"

  ready=false
  for _ in $(seq 1 300); do
    if [[ "$phase" == acknowledged ]]; then
      if grep -Eq '^[0-9a-f]{32}$' "$marker" 2>/dev/null; then ready=true; break; fi
    elif [[ -s "$marker" ]]; then
      ready=true
      break
    fi
    if ! kill -0 "$writer_pid" 2>/dev/null; then break; fi
    sleep 0.1
  done
  if [[ "$ready" != true || ! -s "$case_dir/commit-connection-pragmas.txt" ]]; then
    cat "$case_dir/writer.log" >&2
    echo "Writer did not reach $phase with PRAGMA evidence" >&2
    exit 1
  fi
  grep -q '^directory_sync=ok ' "$case_dir/writer.log"
  printf 'READY phase=%s case=%s boot_id=%s\n' "$phase" "$case_dir" "$(cat "$case_dir/boot-id-before.txt")"
  exit 0
fi

[[ "$(cat "$case_dir/phase.txt")" == "$phase" ]] || { echo "Case phase differs from requested phase" >&2; exit 2; }
case_commit="$(sed -n 's/^commit=//p' "$case_dir/environment.txt")"
[[ "$case_commit" == "$(git -C "$repo_root" rev-parse HEAD)" ]] || {
  echo "Checkout differs from the one that prepared this case" >&2
  exit 2
}
before="$(cat "$case_dir/boot-id-before.txt")"
after="$(cat /proc/sys/kernel/random/boot_id)"
[[ "$before" != "$after" || "${GATE_REHEARSAL:-}" == 1 ]] || {
  echo "Boot ID did not change; no machine restart was observed" >&2
  exit 1
}
printf '%s\n' "$after" > "$case_dir/boot-id-after.txt"

if [[ "$phase" == pause-after-commit ]]; then
  mode=verify-pending
  expected_generation=2
else
  mode=verify
  expected_generation=1
fi

LIVE_STORE_MODE="$mode" LIVE_STORE_FILE="$database" \
  LIVE_STORE_EVIDENCE_FILE="$case_dir/reopen-pragmas.txt" \
  "$bun_bin" "$worker" > "$case_dir/reopen.log" 2>&1
grep -q '^directory_sync=ok ' "$case_dir/reopen.log"

"$bun_bin" -e '
  import { Database } from "bun:sqlite"
  import { createHash } from "node:crypto"
  const db = new Database(process.argv[1])
  const check = db.query("PRAGMA integrity_check").get()
  if (check.integrity_check !== "ok") throw new Error(JSON.stringify(check))
  const row = db.query("SELECT generation, image, digest FROM effect_vfs_live_image WHERE id = 1").get()
  const expected = Number(process.argv[2])
  if (!row || row.generation < expected || row.generation > expected + 1) {
    throw new Error(JSON.stringify({ generation: row?.generation, expected }))
  }
  const digest = createHash("sha256").update(row.image).digest("hex")
  if (digest !== row.digest) throw new Error("digest mismatch")
  console.log(JSON.stringify({ integrity: check.integrity_check, generation: row.generation, digest }))
' "$database" "$expected_generation" > "$case_dir/integrity.json"

if [[ "${GATE_REHEARSAL:-}" == 1 ]]; then
  printf 'REHEARSAL phase=%s case=%s (no reboot or power cut)\n' "$phase" "$case_dir"
else
  printf 'PASS phase=%s case=%s boot_before=%s boot_after=%s\n' "$phase" "$case_dir" "$before" "$after"
fi
