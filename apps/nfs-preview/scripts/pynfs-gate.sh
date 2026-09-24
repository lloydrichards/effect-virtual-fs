#!/usr/bin/env bash
# Pinned pynfs NFSv4.1 run compared against the classified known-failures file (issue #51).
#
# Usage: bash scripts/pynfs-gate.sh
#
# Checks out pynfs at the commit pinned in conformance/known-failures.json, installs its pinned
# Python dependencies in a virtual environment, starts the conformance fixture on loopback
# 2049, runs the read-side selection, and fails on any difference from the known-failures
# file: an unclassified failure, a listed test that now passes, or a changed selection.
#
# pynfs speaks raw RPC, so nothing here mounts or escalates. Set PYNFS_DIR to reuse an
# existing checkout; it is moved to the pinned commit. The workspace packages must already
# be built, because the fixture imports them by their published entry points.
#
# Requires: bun, git, python3, and a free TCP port 2049.

set -uo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(dirname -- "$script_dir")"
known_failures="$app_dir/conformance/known-failures.json"

port=2049
work_dir="$(mktemp -d -t nfs-pynfs-XXXXXX)"
pynfs_dir="${PYNFS_DIR:-$work_dir/pynfs}"
server_log="$work_dir/fixture.log"
results="$work_dir/results.json"
server_pid=""

log() { printf '\n== %s\n' "$1"; }

cleanup() {
  local status=$?
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill -TERM "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
    printf 'stopped the conformance fixture\n'
  fi
  if [ "$status" -ne 0 ] && [ -f "$server_log" ]; then
    log "fixture log"
    cat "$server_log" || true
  fi
  rm -rf "$work_dir"
  exit "$status"
}

die() {
  printf 'FAIL  %s\n' "$1" >&2
  exit 1
}

trap cleanup EXIT INT TERM

for tool in bun git python3; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found"
done

# The known-failures file is the single source for the pin, so the gate and the recorded
# baseline cannot name different suite revisions.
{ read -r commit; read -r repository; read -r requirements; read -r arguments; } < <(
  python3 - "$known_failures" <<'EOF'
import json, sys
suite = json.load(open(sys.argv[1]))["suite"]
print(suite["commit"])
print(suite["repository"])
print(" ".join(f"{name}=={version}" for name, version in suite["python"].items()))
print(" ".join(suite["arguments"]))
EOF
)
[ -n "${arguments:-}" ] || die "could not read the suite pin from $known_failures"

log "pinned suite"
if [ ! -d "$pynfs_dir/.git" ]; then
  git clone --quiet "$repository" "$pynfs_dir" || die "could not clone $repository"
fi
git -C "$pynfs_dir" fetch --quiet origin "$commit" 2>/dev/null || true
git -C "$pynfs_dir" checkout --quiet --detach "$commit" || die "could not check out pynfs $commit"
python3 -m venv "$work_dir/venv" || die "could not create a Python virtual environment"
# pynfs's setup.py generates its XDR modules through os.system("python3 ..."), so the
# virtual environment must come first on PATH or generation silently runs without ply.
export PATH="$work_dir/venv/bin:$PATH"
# shellcheck disable=SC2086 # requirements is a space-separated list of pinned specifiers.
"$work_dir/venv/bin/pip" install --quiet --disable-pip-version-check $requirements || die "could not install $requirements"
(cd "$pynfs_dir" && "$work_dir/venv/bin/python" setup.py build >"$work_dir/build.log" 2>&1) ||
  { cat "$work_dir/build.log"; die "pynfs build failed"; }
printf 'pynfs          %s\n' "$(git -C "$pynfs_dir" rev-parse HEAD)"
printf 'python         %s\n' "$("$work_dir/venv/bin/python" --version 2>&1)"
printf 'dependencies   %s\n' "$requirements"
printf 'platform       %s\n' "$(uname -srm)"

if (exec 3<>/dev/tcp/127.0.0.1/"$port") 2>/dev/null; then
  die "TCP port ${port} is already in use; stop the process bound to it and retry"
fi

log "starting the conformance fixture"
bun "$app_dir/src/conformance.ts" >"$server_log" 2>&1 &
server_pid=$!

for _ in $(seq 1 60); do
  if (exec 3<>/dev/tcp/127.0.0.1/"$port") 2>/dev/null; then
    break
  fi
  kill -0 "$server_pid" 2>/dev/null || die "the conformance fixture exited before it listened"
  sleep 0.5
done
(exec 3<>/dev/tcp/127.0.0.1/"$port") 2>/dev/null ||
  die "the conformance fixture did not listen on 127.0.0.1:${port} within 30 seconds"
printf 'listening on 127.0.0.1:%s\n' "$port"

log "pynfs ${arguments}"
# testserver.py exits 0 with failures, so the comparison below is the only verdict.
# shellcheck disable=SC2086 # arguments is the pinned, space-separated pynfs command line.
(cd "$pynfs_dir/nfs4.1" && "$work_dir/venv/bin/python" testserver.py "127.0.0.1:${port}/" \
  $arguments --jsonout "$results" >"$work_dir/pynfs.log" 2>&1)
tail -n 3 "$work_dir/pynfs.log"
[ -f "$results" ] || { cat "$work_dir/pynfs.log"; die "pynfs wrote no results"; }
kill -0 "$server_pid" 2>/dev/null || die "the conformance fixture exited during the run"

log "comparison with conformance/known-failures.json"
python3 "$script_dir/check-pynfs-results.py" "$known_failures" "$results" ||
  die "the run differs from the known-failures file; classify each difference in conformance/known-failures.json"

printf '\npynfs gate passed.\n'
