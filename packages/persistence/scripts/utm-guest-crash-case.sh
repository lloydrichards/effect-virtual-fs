#!/usr/bin/env bash
# Runs inside a disposable Linux UTM guest. The host must hard-stop the VM
# between prepare and verify; this script never requests a graceful shutdown.
set -euo pipefail

action="${1:?action}"
phase="${2:?phase}"
iteration="${3:?iteration}"
run_dir="${4:?run directory}"
bun=/root/bun-linux-aarch64/bun
worker=/root/effect-vfs-live-restart-bundle.js
case_dir="$run_dir/$iteration-$phase"
database="$case_dir/live.sqlite"
mkdir -p "$case_dir"

case "$action" in
  prepare)
    if [[ "$phase" != acknowledged ]]; then
      LIVE_STORE_SYNC_DIRECTORY=1 LIVE_STORE_MODE=write LIVE_STORE_FILE="$database" "$bun" "$worker" > "$case_dir/baseline.log" 2>&1
    fi

    if [[ "$phase" == acknowledged ]]; then
      mode=write-hold
      marker="$case_dir/writer.log"
    else
      mode="$phase"
      marker="$database.${phase/pause-before-commit/before-commit}"
    fi

    nohup env LIVE_STORE_SYNC_DIRECTORY=1 LIVE_STORE_MODE="$mode" LIVE_STORE_FILE="$database" \
      LIVE_STORE_EVIDENCE_FILE="$case_dir/commit-connection-pragmas.txt" \
      "$bun" "$worker" > "$case_dir/writer.log" 2>&1 < /dev/null &
    echo "$!" > "$case_dir/writer.pid"

    ready=false
    for _ in {1..200}; do
      if [[ "$phase" == acknowledged ]]; then
        if grep -Eq '^[0-9a-f]{32}$' "$marker" 2>/dev/null; then ready=true; break; fi
      elif [[ -s "$marker" ]]; then
        ready=true
        break
      fi
      if ! kill -0 "$(cat "$case_dir/writer.pid")" 2>/dev/null; then break; fi
      sleep 0.05
    done
    if [[ "$ready" != true ]]; then
      cat "$case_dir/writer.log" >&2
      exit 1
    fi
    printf 'ready=%s\n' "$phase" > "$case_dir/prepare.status"
    ;;
  verify)
    if [[ "$phase" == pause-after-commit ]]; then
      mode=verify-pending
      expected=2
    else
      mode=verify
      expected=1
    fi

    LIVE_STORE_SYNC_DIRECTORY=1 LIVE_STORE_MODE="$mode" LIVE_STORE_FILE="$database" "$bun" "$worker" > "$case_dir/reopen.log" 2>&1
    "$bun" -e '
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
      const sqlite = db.query("SELECT sqlite_version() AS version").get().version
      console.log(JSON.stringify({ integrity: check.integrity_check, generation: row.generation, digest, sqlite }))
    ' "$database" "$expected" > "$case_dir/integrity.json" 2>&1
    printf 'passed=%s\n' "$phase" > "$case_dir/verify.status"
    ;;
  *)
    echo "Unknown action: $action" >&2
    exit 2
    ;;
esac
