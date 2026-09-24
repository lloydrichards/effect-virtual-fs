#!/usr/bin/env bash
# Pinned pynfs NFSv4.1 run compared against the classified known-failures file (issue #51).
#
# Usage: bash scripts/pynfs-gate.sh
#
# Checks out pynfs at the commit pinned in conformance/known-failures.json, installs its pinned
# Python dependencies in a virtual environment, starts the conformance fixture on loopback
# 2049, runs the read-side selection, and fails on any difference from the known-failures
# file: a changed selection, an outcome other than PASS or a classified FAILURE, or a listed
# test that now passes.
#
# pynfs speaks raw RPC, so nothing here mounts or escalates. Set PYNFS_DIR to reuse an
# existing checkout: it must have no tracked changes, it is detached at the pinned commit,
# and its gitignored generated XDR modules are deleted and rebuilt. PYNFS_DIR must be
# absolute, because bun run --filter changes into the app directory before this script
# starts. The workspace packages must already be built, because the fixture imports them by
# their published entry points.
#
# Requires: bun, git, python3, and a free TCP port 2049.

set -uo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(dirname -- "$script_dir")"
known_failures="$app_dir/conformance/known-failures.json"

port=2049
pynfs_timeout_seconds=300
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/nfs-pynfs.XXXXXX")"
pynfs_dir="${PYNFS_DIR:-$work_dir/pynfs}"
server_log="$work_dir/fixture.log"
pynfs_log="$work_dir/pynfs.log"
server_pid=""
watchdog_pid=""

log() { printf '\n== %s\n' "$1"; }

die() {
  printf 'FAIL  %s\n' "$1" >&2
  exit 1
}

cleanup() {
  local status=$?
  trap - EXIT
  [ -n "$watchdog_pid" ] && kill -TERM "$watchdog_pid" 2>/dev/null
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill -TERM "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
    printf 'stopped the conformance fixture\n'
  fi
  if [ "$status" -ne 0 ] && [ -s "$server_log" ]; then
    log "fixture log"
    cat "$server_log" || true
  fi
  rm -rf "$work_dir"
  exit "$status"
}

# EXIT alone runs cleanup; the signal traps only choose the status it reports.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

case "$pynfs_dir" in
  /*) ;;
  *) die "PYNFS_DIR must be an absolute path; bun run --filter starts this script in $app_dir" ;;
esac

for tool in bun git python3; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found"
done

# The known-failures file is the single source for the pin, so the gate and the recorded
# baseline cannot name different suite revisions.
{ read -r commit; read -r repository; read -r interpreter; read -r requirements; read -r arguments; } < <(
  python3 - "$known_failures" <<'EOF'
import json, sys
suite = json.load(open(sys.argv[1]))["suite"]
print(suite["commit"])
print(suite["repository"])
print(suite["interpreter"])
print(" ".join(f"{name}=={version}" for name, version in suite["python"].items()))
print(" ".join(suite["arguments"]))
EOF
)
[ -n "${arguments:-}" ] || die "could not read the suite pin from $known_failures"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || die "the pinned commit must be a full 40-character SHA, not ${commit}"

log "pinned suite"
if [ ! -d "$pynfs_dir/.git" ]; then
  git clone --quiet "$repository" "$pynfs_dir" || die "could not clone $repository"
fi
[ -z "$(git -C "$pynfs_dir" status --porcelain --untracked-files=no)" ] ||
  die "$pynfs_dir has tracked changes; the gate only runs an unmodified pinned suite"
git -C "$pynfs_dir" cat-file -e "${commit}^{commit}" 2>/dev/null ||
  git -C "$pynfs_dir" fetch --quiet origin "$commit" ||
  die "could not fetch pynfs $commit"
git -C "$pynfs_dir" checkout --quiet --detach "$commit" || die "could not check out pynfs $commit"
[ "$(git -C "$pynfs_dir" rev-parse HEAD)" = "$commit" ] || die "pynfs HEAD is not the pinned $commit"

python3 -m venv "$work_dir/venv" || die "could not create a Python virtual environment"
# pynfs's generators call os.system("python3 ..."), so the virtual environment must come
# first on PATH or generation runs without ply.
export PATH="$work_dir/venv/bin:$PATH"
# shellcheck disable=SC2086 # requirements is a space-separated list of pinned specifiers.
pip install --quiet --disable-pip-version-check $requirements || die "could not install $requirements"

actual_interpreter="$(python -c 'import platform; print(platform.python_version())')"
if [ "$actual_interpreter" != "$interpreter" ]; then
  printf 'WARN  Python %s differs from the pinned %s; a new difference may come from the interpreter\n' \
    "$actual_interpreter" "$interpreter"
fi

# The top-level setup.py ignores each subdirectory's exit status, so build them here. Removing
# the gitignored generated modules first stops a failed build from reusing an earlier one.
git -C "$pynfs_dir" clean --quiet -fdX -- xdr rpc nfs4.1 || die "could not remove generated pynfs modules"
for dir in xdr rpc nfs4.1; do
  (cd "$pynfs_dir/$dir" && python setup.py build) >>"$work_dir/build.log" 2>&1 ||
    { cat "$work_dir/build.log"; die "pynfs build failed in $dir"; }
done
for generated in rpc/rpc_pack.py nfs4.1/xdrdef/nfs4_pack.py; do
  [ -f "$pynfs_dir/$generated" ] || { cat "$work_dir/build.log"; die "the pynfs build did not generate $generated"; }
done

printf 'pynfs          %s\n' "$commit"
printf 'python         %s\n' "$actual_interpreter"
printf 'dependencies   %s\n' "$requirements"
printf 'platform       %s\n' "$(uname -srm)"

if (exec 3<>/dev/tcp/127.0.0.1/"$port") 2>/dev/null; then
  die "TCP port ${port} is already in use; stop the process bound to it and retry"
fi

log "starting the conformance fixture"
bun "$app_dir/src/conformance.ts" >"$server_log" 2>&1 &
server_pid=$!

# Wait for the fixture's own listening line, so another process that takes the port cannot
# stand in for it.
for _ in $(seq 1 60); do
  grep -qF "NFS conformance fixture listening at 127.0.0.1:${port}" "$server_log" && break
  kill -0 "$server_pid" 2>/dev/null || die "the conformance fixture exited before it listened"
  sleep 0.5
done
grep -qF "NFS conformance fixture listening at 127.0.0.1:${port}" "$server_log" ||
  die "the conformance fixture did not listen on 127.0.0.1:${port} within 30 seconds"
printf 'listening on 127.0.0.1:%s\n' "$port"

log "pynfs ${arguments}"
# shellcheck disable=SC2086 # arguments is the pinned, space-separated pynfs command line.
(cd "$pynfs_dir/nfs4.1" && exec python testserver.py "127.0.0.1:${port}/" $arguments) >"$pynfs_log" 2>&1 &
pynfs_pid=$!
# A portable watchdog: macOS has no timeout(1). It records that it fired before stopping pynfs.
(
  trap 'kill "$sleeper" 2>/dev/null; exit 0' TERM
  sleep "$pynfs_timeout_seconds" &
  sleeper=$!
  wait "$sleeper"
  : >"$work_dir/timed-out"
  kill -TERM "$pynfs_pid" 2>/dev/null
) &
watchdog_pid=$!
wait "$pynfs_pid"
pynfs_status=$?
kill -TERM "$watchdog_pid" 2>/dev/null
wait "$watchdog_pid" 2>/dev/null
watchdog_pid=""

[ -e "$work_dir/timed-out" ] && die "pynfs did not finish within ${pynfs_timeout_seconds} seconds"
tail -n 3 "$pynfs_log"
# testserver.py exits 0 when tests fail, so a non-zero status means the suite itself broke.
[ "$pynfs_status" -eq 0 ] || { cat "$pynfs_log"; die "pynfs exited with status ${pynfs_status}"; }
kill -0 "$server_pid" 2>/dev/null || die "the conformance fixture exited during the run"

log "comparison with conformance/known-failures.json"
python3 "$script_dir/check-pynfs-results.py" "$known_failures" "$pynfs_log" ||
  die "the run differs from the known-failures file; classify each difference in conformance/known-failures.json"

printf '\npynfs gate passed.\n'
