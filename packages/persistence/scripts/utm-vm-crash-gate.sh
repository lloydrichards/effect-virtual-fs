#!/usr/bin/env bash
# Mac-hosted OS-crash gate. Requires a dedicated ARM64 Linux UTM VM with the
# QEMU guest agent. UTM retains the guest disk across each crash or hard stop.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
vm="${GATE_VM_NAME:-Crash Test}"
iterations="${GATE_ITERATIONS:-3}"
stop_mode="${GATE_STOP_MODE:-force}"
output_dir="${GATE_OUTPUT_DIR:-$(mktemp -d -t effect-vfs-vm-gate-XXXXXX)}"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
guest_dir="/root/effect-vfs-vm-gate/$run_id"
bun_version=1.2.21
guest_bun=/root/bun-linux-aarch64/bun
vm_config="$HOME/Library/Containers/com.utmapp.UTM/Data/Documents/$vm.utm/config.plist"

[[ "$(uname -s)" == Darwin ]] || { echo "Run this gate on a Mac UTM host" >&2; exit 2; }
[[ "$iterations" =~ ^[1-9][0-9]*$ ]] || { echo "GATE_ITERATIONS must be a positive integer" >&2; exit 2; }
[[ "$stop_mode" == force || "$stop_mode" == kill || "$stop_mode" == panic ]] ||
  { echo "GATE_STOP_MODE must be force, kill, or panic" >&2; exit 2; }
command -v utmctl >/dev/null
command -v bun >/dev/null
command -v curl >/dev/null
mkdir -p "$output_dir"

guest_exec() {
  utmctl exec "$vm" --cmd "$@"
}

if ! guest_exec uname -s 2>/dev/null | grep -qx Linux; then
  utmctl start "$vm"
  for _ in {1..30}; do
    if guest_exec uname -s 2>/dev/null | grep -qx Linux; then break; fi
    sleep 2
  done
fi
guest_exec uname -s | grep -qx Linux || { echo "Guest agent is unavailable in $vm" >&2; exit 1; }
[[ "$(guest_exec uname -m)" == aarch64 ]] || { echo "This gate expects an ARM64 Linux guest" >&2; exit 2; }

if [[ "$(guest_exec "$guest_bun" --version 2>/dev/null || true)" != "$bun_version" ]]; then
  archive="$output_dir/bun-linux-aarch64-v$bun_version.zip"
  curl -fsSL --retry 2 -o "$archive" \
    "https://github.com/oven-sh/bun/releases/download/bun-v$bun_version/bun-linux-aarch64.zip"
  utmctl file push "$vm" "/root/bun-linux-aarch64-v$bun_version.zip" < "$archive"
  guest_exec unzip -o "/root/bun-linux-aarch64-v$bun_version.zip" -d /root
  for _ in {1..30}; do
    [[ "$(guest_exec "$guest_bun" --version 2>/dev/null || true)" == "$bun_version" ]] && break
    sleep 1
  done
fi
[[ "$(guest_exec "$guest_bun" --version)" == "$bun_version" ]] || { echo "Guest Bun install failed" >&2; exit 1; }
guest_exec sync
[[ "$(guest_exec "$guest_bun" --version)" == "$bun_version" ]] || { echo "Guest Bun did not survive setup sync" >&2; exit 1; }

bun build "$repo_root/packages/persistence/test/fixtures/live-restart.ts" \
  --target=bun --outfile="$output_dir/live-restart-bundle.js"
utmctl file push "$vm" /root/effect-vfs-live-restart-bundle.js < "$output_dir/live-restart-bundle.js"
utmctl file push "$vm" /root/effect-vfs-vm-gate.sh < "$repo_root/packages/persistence/scripts/utm-guest-crash-case.sh"
guest_exec sync

{
  printf 'gate=utm-guest-os-hard-stop\n'
  printf 'vm=%s\n' "$vm"
  printf 'run_id=%s\n' "$run_id"
  printf 'stop_mode=%s\n' "$stop_mode"
  printf 'host=%s\n' "$(sw_vers -productName) $(sw_vers -productVersion)"
  printf 'host_bun=%s\n' "$(bun --version)"
  printf 'guest_kernel=%s\n' "$(guest_exec uname -srm)"
  printf 'guest_os=%s\n' "$(guest_exec cat /etc/os-release | sed -n 's/^PRETTY_NAME=//p' | tr -d '"')"
  printf 'guest_bun=%s\n' "$(guest_exec "$guest_bun" --version)"
  printf 'driver=%s\n' "$(cd "$repo_root" && bun -e 'import p from "./node_modules/@effect/sql-sqlite-bun/package.json"; console.log(p.version)')"
  printf 'guest_mount=%s\n' "$(guest_exec cat /proc/mounts | awk '$2 == "/" { print $1, $3, $4 }')"
  printf 'guest_block_devices=%s\n' "$(guest_exec lsblk | tr '\n' ';')"
  if [[ -f "$vm_config" ]]; then
    printf 'vm_backend=%s\n' "$(plutil -extract Backend raw -o - "$vm_config")"
    for disk_index in 0 1 2 3; do
      if [[ "$(plutil -extract "Drive.$disk_index.ImageType" raw -o - "$vm_config" 2>/dev/null || true)" == Disk ]]; then
        printf 'vm_disk_interface=%s\n' "$(plutil -extract "Drive.$disk_index.Interface" raw -o - "$vm_config")"
        printf 'vm_disk_image=%s\n' "$(plutil -extract "Drive.$disk_index.ImageName" raw -o - "$vm_config")"
        break
      fi
    done
  fi
  printf 'iterations=%s\n' "$iterations"
} > "$output_dir/environment.txt"

for iteration in $(seq 1 "$iterations"); do
  for phase in pause-after-update pause-before-commit pause-after-commit acknowledged; do
    case_name="$iteration-$phase"
    case_dir="$output_dir/$case_name"
    guest_case_dir="$guest_dir/$case_name"
    mkdir -p "$case_dir"
    guest_exec /bin/bash /root/effect-vfs-vm-gate.sh prepare "$phase" "$iteration" "$guest_dir"
    prepared=""
    for _ in {1..30}; do
      prepared="$(guest_exec cat "$guest_case_dir/prepare.status" 2>/dev/null || true)"
      [[ "$prepared" == "ready=$phase" ]] && break
      sleep 1
    done
    [[ "$prepared" == "ready=$phase" ]] || { echo "Prepare failed: $case_name" >&2; exit 1; }
    utmctl file pull "$vm" "$guest_case_dir/commit-connection-pragmas.txt" > "$case_dir/commit-connection-pragmas.txt"
    [[ -s "$case_dir/commit-connection-pragmas.txt" ]] || { echo "Missing PRAGMA evidence: $case_name" >&2; exit 1; }
    utmctl file pull "$vm" "$guest_case_dir/writer.log" > "$case_dir/writer.log"
    grep -q '^directory_sync=ok ' "$case_dir/writer.log" ||
      { echo "Writer did not sync the database directory: $case_name" >&2; exit 1; }
    if [[ "$phase" != acknowledged ]]; then
      utmctl file pull "$vm" "$guest_case_dir/baseline.log" > "$case_dir/baseline.log"
      [[ -s "$case_dir/baseline.log" ]] || { echo "Missing baseline evidence: $case_name" >&2; exit 1; }
      grep -q '^directory_sync=ok ' "$case_dir/baseline.log" ||
        { echo "Baseline did not sync the database directory: $case_name" >&2; exit 1; }
    fi
    if [[ "$stop_mode" == panic ]]; then
      boot_before="$(guest_exec cat /proc/sys/kernel/random/boot_id)"
      guest_exec /bin/bash -c 'printf "10\n" > /proc/sys/kernel/panic; printf "c\n" > /proc/sysrq-trigger' >/dev/null 2>&1 || true
    else
      utmctl stop "$vm" "--$stop_mode"
      utmctl start "$vm"
    fi
    guest_ready=false
    for _ in {1..30}; do
      if guest_exec uname -s 2>/dev/null | grep -qx Linux; then
        if [[ "$stop_mode" != panic || "$(guest_exec cat /proc/sys/kernel/random/boot_id 2>/dev/null || true)" != "$boot_before" ]]; then
          guest_ready=true
          break
        fi
      fi
      sleep 2
    done
    [[ "$guest_ready" == true ]] || { echo "Guest did not restart: $case_name" >&2; exit 1; }
    if [[ "$stop_mode" == panic ]]; then
      printf 'before=%s\nafter=%s\n' "$boot_before" "$(guest_exec cat /proc/sys/kernel/random/boot_id)" > "$case_dir/boot-ids.txt"
    fi
    guest_exec /bin/bash /root/effect-vfs-vm-gate.sh verify "$phase" "$iteration" "$guest_dir"
    verified=""
    for _ in {1..30}; do
      verified="$(guest_exec cat "$guest_case_dir/verify.status" 2>/dev/null || true)"
      [[ "$verified" == "passed=$phase" ]] && break
      sleep 1
    done
    [[ "$verified" == "passed=$phase" ]] || { echo "Verification failed: $case_name" >&2; exit 1; }
    utmctl file pull "$vm" "$guest_case_dir/reopen.log" > "$case_dir/reopen.log"
    grep -q '^directory_sync=ok ' "$case_dir/reopen.log" ||
      { echo "Reopen did not sync the database directory: $case_name" >&2; exit 1; }
    utmctl file pull "$vm" "$guest_case_dir/integrity.json" > "$case_dir/integrity.json"
    [[ -s "$case_dir/integrity.json" ]] ||
      { echo "Missing recovery evidence: $case_name" >&2; exit 1; }
    printf 'PASS iteration=%s phase=%s\n' "$iteration" "$phase"
  done
done

printf 'Evidence: %s\n' "$output_dir"
