#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
mountpoint="${2:-}"
name="${3:-}"

if [[ "$mode" != create && "$mode" != verify ]] || [[ -z "$mountpoint" ]]; then
  printf 'Usage: verify-mount.sh create|verify MOUNTPOINT [TEST_DIRECTORY]\n' >&2
  exit 2
fi

mountpoint="${mountpoint%/}"
if ! mount | grep -Fq -- " on ${mountpoint} "; then
  printf 'No mount found at %s\n' "$mountpoint" >&2
  exit 2
fi

if [[ "$mode" == create ]]; then
  name="smoke-$(date +%s)-$$"
else
  if [[ ! "$name" =~ ^smoke-[0-9]+-[0-9]+$ ]]; then
    printf 'Expected the test directory printed by the create step\n' >&2
    exit 2
  fi
fi

directory="$mountpoint/$name"
file="$directory/renamed.txt"

if [[ "$mode" == create ]]; then
  mkdir "$directory"
  python3 - "$directory/created.txt" <<'PY'
import os
import sys

with open(sys.argv[1], "wb") as output:
    output.write(b"hello from the first mount\n")
    output.flush()
    os.fsync(output.fileno())
PY
  mv "$directory/created.txt" "$file"
  [[ "$(cat "$file")" == "hello from the first mount" ]]
  printf 'PASS write, fsync, rename, and read through NFS\n'
  printf 'TEST_DIRECTORY=%s\n' "$name"
  printf 'Unmount, stop the app, restart it, remount, then run verify with this directory.\n'
else
  [[ "$(cat "$file")" == "hello from the first mount" ]]
  printf 'PASS reopened file after server restart and remount\n'
  rm "$file"
  rmdir "$directory"
  printf 'PASS removed the test file and directory\n'
fi
