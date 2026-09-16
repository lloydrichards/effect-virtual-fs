#!/usr/bin/env bash
# Repeatable privileged Linux NFSv4.1 mount gate for issue #39.
#
# Usage: bash scripts/linux-mount-gate.sh
#
# Runs the whole cycle under one trap: start the preview server, wait for loopback 2049,
# mount with an explicit vers=4.1, run the unprivileged read-side checks of verify-mount.sh,
# mount a second time with no vers= to confirm the client ladders 4.2 -> 4.1, then unmount
# both and stop the server. A failure at any point still unmounts and stops the server.
#
# This script is the only place that escalates. `@effect-vfs/nfs` never invokes sudo, and
# verify-mount.sh stays unprivileged so the same checks run against a hand-made macOS mount.
#
# Requires: Linux, nfs-common (mount.nfs4), passwordless sudo, and a free TCP port 2049.

set -uo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(dirname -- "$script_dir")"
repo_root="$(cd -- "$app_dir/../.." && pwd)"

port=2049
mountpoint=/mnt/effect-vfs-nfs-preview
ladder_mountpoint=/mnt/effect-vfs-nfs-ladder
server_log="$(mktemp -t nfs-preview-XXXXXX.log)"
server_pid=""

log() { printf '\n== %s\n' "$1"; }

cleanup() {
  local status=$?
  log "cleanup"
  for target in "$ladder_mountpoint" "$mountpoint"; do
    if mount | grep -qF -- " on ${target} "; then
      sudo umount "$target" 2>/dev/null || sudo umount -l "$target" 2>/dev/null || true
      printf 'unmounted %s\n' "$target"
    fi
    sudo rmdir "$target" 2>/dev/null || true
  done
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill -TERM "-$server_pid" 2>/dev/null || kill -TERM "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
    printf 'stopped the preview server\n'
  fi
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

trap cleanup EXIT INT TERM

log "starting the preview server"
# setsid gives the server its own process group so cleanup kills any child it spawned.
setsid bun "$app_dir/src/main.ts" >"$server_log" 2>&1 &
server_pid=$!

for _ in $(seq 1 60); do
  if (exec 3<>/dev/tcp/127.0.0.1/"$port") 2>/dev/null; then
    break
  fi
  kill -0 "$server_pid" 2>/dev/null || die "the preview server exited before it listened"
  sleep 0.5
done
(exec 3<>/dev/tcp/127.0.0.1/"$port") 2>/dev/null ||
  die "the preview server did not listen on 127.0.0.1:${port} within 30 seconds"
printf 'listening on 127.0.0.1:%s\n' "$port"

# The mount stays writable on the client so rejected writes are the server's NFS4ERR_ROFS
# rather than the local kernel's read-only flag. `noowners` is macOS-only and has no Linux
# equivalent here; the preview's numeric owners are harmless with the default id mapping.
log "mounting with an explicit vers=4.1"
sudo mkdir -p "$mountpoint"
sudo mount -t nfs -o nfsvers=4.1,tcp,sec=sys,port="$port",actimeo=1 \
  127.0.0.1:/ "$mountpoint" || die "mount with nfsvers=4.1 failed"
printf '%s\n' "$(mount | grep -F -- " on ${mountpoint} ")"

log "read-side checks"
bash "$script_dir/verify-mount.sh" "$mountpoint" || die "read-side checks failed"

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

printf '\nLinux NFSv4.1 mount gate passed.\n'
