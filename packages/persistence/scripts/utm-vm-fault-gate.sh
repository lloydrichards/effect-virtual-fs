#!/usr/bin/env bash
# Run the Linux SQLite VFS fault gates in the existing UTM Crash Test guest.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
vm="${GATE_VM_NAME:-Crash Test}"
output_dir="${GATE_OUTPUT_DIR:-$(mktemp -d -t effect-vfs-vm-fault-XXXXXX)}"
guest_dir="/root/effect-vfs-vm-fault-$(date -u +%Y%m%dT%H%M%SZ)-$$"
guest_bun=/root/bun-linux-aarch64/bun
driver="$(cd "$repo_root" && bun -e 'import p from "./node_modules/@effect/sql-sqlite-bun/package.json"; console.log(p.version)')"

mkdir -p "$output_dir"
bun build "$repo_root/packages/persistence/test/fixtures/live-restart.ts" \
  --target=bun --outfile="$output_dir/live-restart-bundle.js"
utmctl exec "$vm" --cmd /bin/mkdir -p "$guest_dir"
utmctl file push "$vm" "$guest_dir/live-restart.js" < "$output_dir/live-restart-bundle.js"
utmctl file push "$vm" "$guest_dir/faultvfs.c" < "$repo_root/packages/persistence/test/fixtures/faultvfs.c"
utmctl file push "$vm" "$guest_dir/linux-fault-gate.sh" < "$repo_root/packages/persistence/scripts/linux-fault-gate.sh"
utmctl file push "$vm" "$guest_dir/linux-write-order-gate.sh" < "$repo_root/packages/persistence/scripts/linux-write-order-gate.sh"
utmctl file push "$vm" "$guest_dir/linux-disk-full-gate.sh" < "$repo_root/packages/persistence/scripts/linux-disk-full-gate.sh"

{
  printf 'vm=%s\n' "$vm"
  printf 'guest_dir=%s\n' "$guest_dir"
  printf 'driver=%s\n' "$driver"
  printf 'guest_kernel=%s\n' "$(utmctl exec "$vm" --cmd uname -srm)"
  printf 'guest_mount=%s\n' "$(utmctl exec "$vm" --cmd findmnt -T /root -o SOURCE,FSTYPE,OPTIONS)"
  printf 'guest_logical_sector=%s\n' "$(utmctl exec "$vm" --cmd cat /sys/block/vda/queue/logical_block_size)"
  printf 'guest_physical_sector=%s\n' "$(utmctl exec "$vm" --cmd cat /sys/block/vda/queue/physical_block_size)"
  printf 'guest_write_cache=%s\n' "$(utmctl exec "$vm" --cmd cat /sys/block/vda/queue/write_cache)"
} > "$output_dir/environment.txt"

cat > "$output_dir/run-guest-gates.sh" <<EOF
#!/usr/bin/env bash
set +e
export GATE_WORKER="$guest_dir/live-restart.js"
export GATE_SOURCE="$guest_dir/faultvfs.c"
export GATE_BUN="$guest_bun"
export GATE_DRIVER_VERSION="$driver"
GATE_FAULT_ITERATIONS=1 GATE_OUTPUT_DIR="$guest_dir/fault" \
  /bin/bash "$guest_dir/linux-fault-gate.sh" > "$guest_dir/fault-gate.log" 2>&1
printf '%s\n' "\$?" > "$guest_dir/fault-gate.exit"
GATE_ORDER_ITERATIONS=1 GATE_OUTPUT_DIR="$guest_dir/order" \
  /bin/bash "$guest_dir/linux-write-order-gate.sh" > "$guest_dir/write-order-gate.log" 2>&1
printf '%s\n' "\$?" > "$guest_dir/write-order-gate.exit"
GATE_FILESYSTEM=ext4-loop GATE_OUTPUT_DIR="$guest_dir/space" \
  /bin/bash "$guest_dir/linux-disk-full-gate.sh" > "$guest_dir/space-gate.log" 2>&1
printf '%s\n' "\$?" > "$guest_dir/space-gate.exit"
EOF
utmctl file push "$vm" "$guest_dir/run-guest-gates.sh" < "$output_dir/run-guest-gates.sh"
utmctl exec "$vm" --cmd /bin/bash "$guest_dir/run-guest-gates.sh"
ready=false
for _ in {1..60}; do
  if utmctl file pull "$vm" "$guest_dir/space-gate.exit" > "$output_dir/space-gate.exit" 2>/dev/null &&
    [[ -s "$output_dir/space-gate.exit" ]]; then
    ready=true
    break
  fi
  sleep 2
done
[[ "$ready" == true ]] || { echo "Guest fault gates did not finish" >&2; exit 1; }
utmctl file pull "$vm" "$guest_dir/fault-gate.log" > "$output_dir/fault-gate.log"
utmctl file pull "$vm" "$guest_dir/write-order-gate.log" > "$output_dir/write-order-gate.log"
utmctl file pull "$vm" "$guest_dir/fault-gate.exit" > "$output_dir/fault-gate.exit"
utmctl file pull "$vm" "$guest_dir/write-order-gate.exit" > "$output_dir/write-order-gate.exit"
utmctl file pull "$vm" "$guest_dir/space-gate.log" > "$output_dir/space-gate.log"

[[ "$(cat "$output_dir/fault-gate.exit")" == 0 ]] ||
  { cat "$output_dir/fault-gate.log" >&2; echo "I/O fault gate failed" >&2; exit 1; }
order_status="$(cat "$output_dir/write-order-gate.exit")"

[[ "$order_status" != 0 ]] || { echo "Lying-storage gate unexpectedly passed" >&2; exit 1; }
[[ "$(grep -c '^BREACH ' "$output_dir/write-order-gate.log")" -ge 3 ]] ||
  { cat "$output_dir/write-order-gate.log" >&2; echo "Expected lost-write breaches were absent" >&2; exit 1; }
! grep -Eq '^(UNREACHED|NO_PAUSE) ' "$output_dir/write-order-gate.log" ||
  { echo "Fault injection was not reached" >&2; exit 1; }

utmctl exec "$vm" --cmd /bin/tar -C "$guest_dir" -czf "$guest_dir/evidence.tar.gz" fault order space
archive_ready=false
for _ in {1..20}; do
  if utmctl file pull "$vm" "$guest_dir/evidence.tar.gz" > "$output_dir/evidence.tar.gz" 2>/dev/null &&
    tar -tzf "$output_dir/evidence.tar.gz" >/dev/null 2>&1; then
    archive_ready=true
    break
  fi
  sleep 2
done
[[ "$archive_ready" == true ]] || { echo "Guest evidence archive was not ready" >&2; exit 1; }
tar -C "$output_dir" -xzf "$output_dir/evidence.tar.gz"

[[ "$(cat "$output_dir/space-gate.exit")" == 0 ]] ||
  { cat "$output_dir/space-gate.log" >&2; echo "ext4 space gate failed" >&2; exit 1; }

grep -q '^directory_sync=ok ' "$output_dir/fault/1-write-main/baseline.log" ||
  { echo "Fault baseline omitted directory sync" >&2; exit 1; }
grep -q '^sector-size value=' "$output_dir/fault/1-write-main/hits.log" ||
  { echo "SQLite VFS sector size was not observed" >&2; exit 1; }

printf 'PASS I/O-fault gate; lying-storage breaches reproduced\nEvidence: %s\n' "$output_dir"
