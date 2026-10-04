---
type: Evidence
title: Measured core and memory workloads
description: Records reproducible Node measurements of writes, trees, snapshots, admission, and watch recovery without treating logical quotas as process memory bounds.
status: stable
tags: [capacity, measurements, memory, release]
sources:
  - id: harness
    resource: ../../scripts/capacity/measure.mjs
    title: Fresh-process measurement harness and behavioral assertions
  - id: measurements
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/276#issuecomment-5980395978
    title: Measurement method, results, and quota guidance
  - id: baseline
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/276#issuecomment-5980396163
    title: Original complete measurement samples
  - id: optimized
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/276#issuecomment-5980396341
    title: Optimized complete samples and source digests
  - id: namespace-tests
    resource: ../../packages/core/test/Snapshot.test.ts
    title: Captured namespace, overlay, listing-order and encoded-restore regression
  - id: admission-tests
    resource: ../../packages/core/test/Watch.test.ts
    title: Admission, cancellation, overflow, and subscriber regression tests
generated: { by: codex/okf, at: 2026-10-04T13:11:54.526Z }
---

# Measured core and memory workloads

The reusable command checks observable outputs and records timing, memory, runtime, hardware, warmup, repetitions,
and source digests. Run from the repository root after building core and memory:

```sh
bun run --cwd packages/core build
bun run --cwd packages/memory build
node --expose-gc scripts/capacity/measure.mjs /tmp/vfs-capacity-results.json
```

Each scenario has one same-input warmup and three fresh-process samples. Workloads cover partial writes and growth
at 1, 16, and 64 MiB; wide directories with 100, 1,000, and 10,000 files; depths of 32, 128, and 256; snapshots,
deltas and merges; competing operations and controlled admission; slow watches; and memory-adapter reads.
The retained issue comments own the original and optimized measurements on Node 24.21.0/macOS arm64.

Persistent ordered directory entries substantially reduce copying during wide-directory creation. The measured
tradeoff is higher populated heap use, with some smaller traversal, merge and adapter-read phases slower.
No universal speedup or statistical confidence for small timing differences is claimed. Listing order, captured
snapshots, sibling overlays and encoded restoration have regression coverage. Deletion can trigger compaction;
a restored native map converts on its first namespace edit.

The exact bounded policy succeeds for 1,000 files of 4 KiB and two independent edits through delta, merge, apply,
and restore. A 10,000-file tree traverses but exceeds default delta `identityBytes`; no merge is claimed for it.
Ordinary short competing operations do not saturate admission. A separately held gate proves 65 admitted callers,
1,000 rejected excess mutations, and recovery. A stalled subscriber retains 255 changes and one `Rescan`, recovers
one known file's final state, and receives a later update.

Repeated partial writes and growth use much more process memory than logical file content. Memory samples may miss
peaks inside operations. OS peak RSS includes warmup and imports; forced GC does not require RSS to shrink.
Timing includes assertions and instrumentation. Logical quotas do not establish process memory bounds, arbitrary
snapshot retention, cross-runtime performance, or timing guarantees. Ordinary unit tests assert behavior, not time.

The [capacity contract](../contracts/capacity-and-limits.md "qualifies") defines logical charging independently of
process memory and snapshot-processing budgets.
