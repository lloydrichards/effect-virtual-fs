#!/usr/bin/env bash
# Verifies a native NFS client mount of the preview fixture without using sudo.
#
# Usage: bash scripts/verify-mount.sh [MOUNTPOINT]
#
# Mount first, as described in README.md, WITHOUT the client-side `ro` option, so that rejected
# writes are the server's NFS4ERR_ROFS rather than the local kernel's EROFS. Then run this script.
# It understands the `mount` output of macOS ("... on /path (nfs, ...)") and Linux
# ("... on /path type nfs4 (rw,...)") and the GNU and BSD spellings of `stat`.
# Every check maps to an acceptance item of issue #39 and the native-client item of issue #43.
# The script never mounts, unmounts, or escalates privileges; the final unmount stays manual.

set -u

mountpoint="${1:-/Volumes/effect-vfs-nfs-preview}"
failures=0
passes=0

pass() {
  passes=$((passes + 1))
  printf 'PASS  %s\n' "$1"
}

fail() {
  failures=$((failures + 1))
  printf 'FAIL  %s\n' "$1"
}

check() {
  local description="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    pass "$description"
  else
    fail "$description"
  fi
}

mountpoint="${mountpoint%/}"
[ -z "$mountpoint" ] && mountpoint=/

mount_line="$(mount | grep -F -- " on ${mountpoint} " | head -n 1)"

if [ -z "$mount_line" ]; then
  printf 'No mount found at %s. Mount it first (see README.md).\n' "$mountpoint" >&2
  exit 2
fi

# macOS: "server:/ on /path (nfs, nodev, ...)"; Linux: "server:/ on /path type nfs4 (rw,...)".
mount_type="${mount_line#* on "${mountpoint}" }"
case "$mount_type" in
  "(nfs"* | "type nfs"*) pass "mountpoint is an NFS mount: ${mount_line#* on }" ;;
  *) fail "mountpoint is not an NFS mount: $mount_line" ;;
esac
case "$mount_type" in
  *read-only* | *"(ro)"* | *"(ro,"* | *",ro,"* | *",ro)"*)
    fail "mount is read-only on the client; mount without ro so the server's rejection is what is tested"
    ;;
  *) pass "mount is writable on the client, so rejected writes come from the server" ;;
esac

# GNU stat takes -c; BSD stat takes -f. GNU `stat -f` is a file-system stat and must not be tried first.
inode_of() {
  stat -c '%i' "$1" 2>/dev/null || stat -f '%i' "$1" 2>/dev/null
}

# Directory listing.
listing="$(ls -1 "$mountpoint" 2>/dev/null)"
for name in hello.txt hello-alias.txt notes latest; do
  if printf '%s\n' "$listing" | grep -qx "$name"; then
    pass "listing shows $name"
  else
    fail "listing shows $name"
  fi
done

# Regular file read. Errors are shown so a failing read reports its errno.
read_error="$(cat "$mountpoint/hello.txt" 2>&1 >/dev/null)"
if [ "$(cat "$mountpoint/hello.txt" 2>/dev/null)" = "hello from Effect VFS" ]; then
  pass "reads hello.txt"
else
  fail "reads hello.txt${read_error:+ ($read_error)}"
fi

# Symbolic link traversal.
if [ "$(readlink "$mountpoint/latest" 2>/dev/null)" = "notes/live.txt" ]; then
  pass "readlink latest -> notes/live.txt"
else
  fail "readlink latest -> notes/live.txt"
fi
link_error="$(cat "$mountpoint/latest" 2>&1 >/dev/null)"
if [ -n "$(cat "$mountpoint/latest" 2>/dev/null)" ]; then
  pass "reads through the symlink"
else
  fail "reads through the symlink${link_error:+ ($link_error)}"
fi

# Hard-link identity.
inode_a="$(inode_of "$mountpoint/hello.txt")"
inode_b="$(inode_of "$mountpoint/hello-alias.txt")"
if [ -n "$inode_a" ] && [ "$inode_a" = "$inode_b" ]; then
  pass "hello.txt and hello-alias.txt share inode $inode_a"
else
  fail "hello.txt and hello-alias.txt share an inode (got '$inode_a' and '$inode_b')"
fi

# Live VFS mutation visible after the attribute-cache window, then reopen.
# The app rewrites live.txt every two seconds and the mount asks for a one-second attribute
# cache, but clients honor actimeo with their own cadence, so poll rather than sleeping once.
live_error="$(cat "$mountpoint/notes/live.txt" 2>&1 >/dev/null)"
first="$(cat "$mountpoint/notes/live.txt" 2>/dev/null)"
second="$first"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  second="$(cat "$mountpoint/notes/live.txt" 2>/dev/null)"
  [ -n "$second" ] && [ "$second" != "$first" ] && break
done
if [ -n "$first" ] && [ -n "$second" ] && [ "$first" != "$second" ]; then
  pass "live.txt changed after the cache window ($first -> $second)"
else
  fail "live.txt changed after the cache window (got '$first' then '$second')${live_error:+ ($live_error)}"
fi
check "reopens live.txt after the change" test -n "$(cat "$mountpoint/notes/live.txt" 2>/dev/null)"

# Mutations must fail as read-only.
if touch "$mountpoint/should-not-exist" 2>/dev/null; then
  fail "touch is rejected"
  rm -f "$mountpoint/should-not-exist" 2>/dev/null
else
  pass "touch is rejected"
fi
if mkdir "$mountpoint/should-not-exist-dir" 2>/dev/null; then
  fail "mkdir is rejected"
  rmdir "$mountpoint/should-not-exist-dir" 2>/dev/null
else
  pass "mkdir is rejected"
fi
if sh -c 'printf x >> "$1"' verify "$mountpoint/hello.txt" 2>/dev/null; then
  fail "append to hello.txt is rejected"
else
  pass "append to hello.txt is rejected"
fi
if [ "$(cat "$mountpoint/hello.txt" 2>/dev/null)" = "hello from Effect VFS" ]; then
  pass "hello.txt is unchanged after rejected writes"
else
  fail "hello.txt is unchanged after rejected writes"
fi

printf '\n%s passed, %s failed on %s (%s)\n' "$passes" "$failures" "$(sw_vers -productName 2>/dev/null || uname -s)" \
  "$(sw_vers -productVersion 2>/dev/null || uname -r)"
printf 'Unmount manually to finish the check: sudo umount %s\n' "$mountpoint"

[ "$failures" -eq 0 ]
