#!/usr/bin/env bash
# Repeatable privileged Linux NFSv4.1 mount gate for issue #39.
#
# Usage: bash scripts/linux-mount-gate.sh
#
# Runs the whole cycle under one trap: start the preview server, wait for loopback 2049,
# mount with an explicit vers=4.1, run the unprivileged read-side checks of verify-mount.sh,
# mount a second time with no vers= to confirm the client ladders 4.2 -> 4.1, then unmount
# both. For issue #163, mount again, replace the server, observe the old mount, and verify
# a fresh mount can read the fixture. A failure at any point still runs cleanup.
#
# This script is the only place that escalates. `@effect-vfs/nfs` never invokes sudo, and
# verify-mount.sh stays unprivileged so the same checks run against a hand-made macOS mount.
#
# Requires: Linux, nfs-common (mount.nfs4), passwordless sudo, and a free TCP port 2049.

set -uo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(dirname -- "$script_dir")"
port=2049
mountpoint=/mnt/effect-vfs-nfs-preview
ladder_mountpoint=/mnt/effect-vfs-nfs-ladder
mount_options="nfsvers=4.1,tcp,sec=sys,port=$port"
server_log="$(mktemp -t nfs-preview-XXXXXX.log)" || exit 1
server_pid=""

log() { printf '\n== %s\n' "$1"; }

stop_server() {
  [ -n "$server_pid" ] || return 0
  local attempt
  if kill -0 "$server_pid" 2>/dev/null; then
    kill -TERM -- "-$server_pid" 2>/dev/null || kill -TERM "$server_pid" 2>/dev/null || true
    for attempt in {1..60}; do
      kill -0 "$server_pid" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$server_pid" 2>/dev/null; then
      kill -KILL -- "-$server_pid" 2>/dev/null || kill -KILL "$server_pid" 2>/dev/null || true
      wait "$server_pid" 2>/dev/null || true
      server_pid=""
      return 1
    fi
  fi
  wait "$server_pid" 2>/dev/null || true
  server_pid=""
}

cleanup() {
  local status=$?
  log "cleanup"
  for target in "$ladder_mountpoint" "$mountpoint"; do
    if mount | grep -qF -- " on ${target} "; then
      if sudo timeout --kill-after=2s 10s umount "$target" 2>/dev/null ||
        sudo timeout --kill-after=2s 10s umount -l "$target" 2>/dev/null; then
        printf 'unmounted %s\n' "$target"
      else
        printf 'Could not unmount %s\n' "$target" >&2
        status=1
      fi
    fi
    sudo rmdir "$target" 2>/dev/null || true
  done
  stop_server || status=1
  if [ "$status" -ne 0 ]; then
    log "server log"
    cat "$server_log" || true
  fi
  rm -f "$server_log"
  exit "$status"
}

die() {
  printf 'FAIL  %s\n' "$1" >&2
  exit 1
}

[ "$(uname -s)" = "Linux" ] || die "this gate is Linux-only; uname -s reported $(uname -s)"
command -v mount.nfs4 >/dev/null 2>&1 || die "mount.nfs4 not found; install nfs-common"
command -v bun >/dev/null 2>&1 || die "bun not found"

# Recorded rather than frozen: the NFSv4.1 client is the host kernel, so the gate's evidence
# names the exact client it ran against instead of pretending to pin it.
log "client environment"
printf 'runner image   %s\n' "${ImageOS:-unknown}${ImageVersion:+ (${ImageVersion})}"
printf 'kernel         %s\n' "$(uname -srm)"
printf 'distribution   %s\n' "$(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-unknown}")"
printf 'nfs-utils      %s\n' "$(mount.nfs4 -V 2>&1 | head -n 1)"

# The mount command hard-codes the port, so a collision is a hard stop rather than a retry.
if (exec 3<>/dev/tcp/127.0.0.1/"$port") 2>/dev/null; then
  die "TCP port ${port} is already in use; stop the process bound to it and retry"
fi

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

start_server() {
  # setsid gives the server its own process group so cleanup reaches any child it spawned.
  EFFECT_VFS_NFS_CAPACITY_GATE=1 setsid bun "$app_dir/src/main.ts" >>"$server_log" 2>&1 &
  server_pid=$!
  local attempt
  for attempt in {1..60}; do
    kill -0 "$server_pid" 2>/dev/null || die "the preview server exited before it listened"
    if (exec 3<>/dev/tcp/127.0.0.1/"$port") 2>/dev/null; then
      printf 'preview server %s listening on 127.0.0.1:%s\n' "$server_pid" "$port"
      return
    fi
    sleep 0.5
  done
  die "the preview server did not listen on 127.0.0.1:${port} within 30 seconds"
}

log "starting the preview server"
start_server

# The mount stays writable on the client so rejected writes are the server's NFS4ERR_ROFS
# rather than the local kernel's read-only flag. `noowners` is macOS-only and has no Linux
# equivalent here; the preview's numeric owners are harmless with the default id mapping.
log "mounting with an explicit vers=4.1"
sudo mkdir -p "$mountpoint"
sudo mount -t nfs -o "$mount_options,actimeo=1" \
  127.0.0.1:/ "$mountpoint" || die "mount with nfsvers=4.1 failed"
printf '%s\n' "$(mount | grep -F -- " on ${mountpoint} ")"

log "read-side checks"
bash "$script_dir/verify-mount.sh" "$mountpoint" || die "read-side checks failed"

log "volume capacity"
read -r total_bytes available_bytes <<<"$(df -B1 --output=size,avail "$mountpoint" | tail -n 1)"
[ "$total_bytes" = 16777216 ] || die "df reported ${total_bytes} total bytes instead of 16777216"
[[ "$available_bytes" =~ ^[0-9]+$ ]] || die "df did not report available bytes: ${available_bytes}"
[ "$available_bytes" -le 16777216 ] && [ "$available_bytes" -ge 16773120 ] ||
  die "df reported ${available_bytes} available bytes outside the fixture's 16 MiB capacity"
read -r total_entries free_entries <<<"$(stat -f -c '%c %d' "$mountpoint")"
[ "$total_entries" = 100 ] && [ "$free_entries" = 95 ] ||
  die "statfs reported ${total_entries} entries and ${free_entries} free, expected 100 and 95"
printf 'PASS  df reports %s total bytes and %s available bytes; statfs reports %s of %s entries free\n' \
  "$total_bytes" "$available_bytes" "$free_entries" "$total_entries"

# Linux tries 4.2 first and ladders down. The server answers unsupported minor versions with
# NFS4ERR_MINOR_VERS_MISMATCH, so a bare mount must still settle on 4.1.
log "version ladder: bare mount with no vers= option"
sudo mkdir -p "$ladder_mountpoint"
sudo mount -t nfs -o tcp,sec=sys,port="$port" 127.0.0.1:/ "$ladder_mountpoint" ||
  die "bare mount -t nfs failed; the client did not ladder down to a supported minor version"
ladder_options="$(awk -v mp="$ladder_mountpoint" '$2 == mp { print $4 }' /proc/mounts | head -n 1)"
case ",${ladder_options}," in
  *,vers=4.1,* | *,nfsvers=4.1,*) printf 'PASS  bare mount negotiated 4.1 (%s)\n' "$ladder_options" ;;
  *) die "bare mount negotiated something other than 4.1 (${ladder_options:-no options found})" ;;
esac

log "unmounting"
sudo umount "$ladder_mountpoint" || die "could not unmount $ladder_mountpoint"
sudo umount "$mountpoint" || die "could not unmount $mountpoint"
mount | grep -qF -- " on ${mountpoint} " && die "$mountpoint is still mounted after umount"

log "restart while mounted"
# Bound retries on this read-only probe and revalidate path lookups. The earlier
# baseline and the final recovery mount use the regular mount options.
restart_options="$mount_options,soft,timeo=10,retrans=2,actimeo=0,lookupcache=none"
printf 'restart probe mount options   %s\n' "$restart_options"
sudo timeout --kill-after=2s 20s mount -t nfs -o "$restart_options" 127.0.0.1:/ "$mountpoint" ||
  die "could not mount the restart probe"
fixture_contents="hello from Effect VFS"
[ "$(timeout --kill-after=2s 12s cat "$mountpoint/hello.txt")" = "$fixture_contents" ] ||
  die "restart probe mount could not read the fixture before replacement"

kill -0 "$server_pid" 2>/dev/null || die "the preview server exited before replacement"
stop_server || die "the original preview server did not stop within 30 seconds"
(exec 3<>/dev/tcp/127.0.0.1/"$port") 2>/dev/null && die "the original listener port stayed open"
start_server

old_read="$(timeout --kill-after=2s 12s cat "$mountpoint/hello.txt" 2>&1)"
old_status=$?
case "$old_status" in
  0)
    [ "$old_read" = "$fixture_contents" ] || die "the old mount returned unexpected fixture contents"
    printf 'OBSERVED  old mount returned the fixture after restart\n'
    ;;
  124 | 137) printf 'OBSERVED  old mount read exceeded the 12-second deadline (exit %s)\n' "$old_status" ;;
  125 | 126 | 127) die "could not execute the old mount probe (exit $old_status): $old_read" ;;
  *) printf 'OBSERVED  old mount read failed after restart (exit %s): %s\n' "$old_status" "$old_read" ;;
esac

log "remounting after restart"
sudo timeout --kill-after=2s 10s umount "$mountpoint" || die "could not unmount the restart probe"
sudo timeout --kill-after=2s 20s mount -t nfs -o "$mount_options,actimeo=1" 127.0.0.1:/ "$mountpoint" ||
  die "could not mount after restart"
[ "$(timeout --kill-after=2s 12s cat "$mountpoint/hello.txt")" = "$fixture_contents" ] ||
  die "fresh mount could not read the fixture after restart"
sudo timeout --kill-after=2s 10s umount "$mountpoint" || die "could not unmount the recovery mount"
printf 'PASS  fresh mount read the fixture after server restart\n'

printf '\nLinux NFSv4.1 mount gate passed.\n'
