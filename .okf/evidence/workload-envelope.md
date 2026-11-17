---
type: Evidence
title: Measured core and memory workloads
description: Records reproducible Node and Bun workload measurements for filesystem operations, snapshot processing, admission, and watch recovery.
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
generated: { by: codex/okf, at: 2026-11-17T20:25:49.553Z }
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
and restore. See [large snapshot deltas](#large-snapshot-deltas) for the explicitly bounded 10,000-file workload.
Ordinary short competing operations do not saturate admission. A separately held gate proves 65 admitted callers,
1,000 rejected excess mutations, and recovery. A stalled subscriber retains 255 changes and one `Rescan`, recovers
one known file's final state, and receives a later update.

Repeated partial writes and growth use much more process memory than logical file content. Memory samples may miss
peaks inside operations. OS peak RSS includes warmup and imports; forced GC does not require RSS to shrink.
Timing includes assertions and instrumentation. Logical quotas do not establish process memory bounds, arbitrary
snapshot retention, cross-runtime performance, or timing guarantees. Ordinary unit tests assert behavior, not time.

The [capacity contract](../contracts/capacity-and-limits.md "qualifies") defines logical charging independently of
process memory and snapshot-processing budgets.

## Large snapshot deltas

Run on Bun 1.4.4 from the repository root.

```sh
bun install --frozen-lockfile
bun run --cwd packages/effect-preview build
bun run --cwd packages/core build
bun run --cwd packages/memory build
bun --expose-gc scripts/capacity/measure.mjs /tmp/vfs-large-deltas.json \
  delta-default:10000 delta-bounded:10000 delta-boundaries:10000
```

Each fresh process runs one same-input warmup and one measured sample. The three profiles have the same layout and
edits. The base has 10,000 root-level files of 4 KiB. Each snapshot edits 512 disjoint files, writing 8 KiB of new
data into each. The qualified run verifies both deltas, a conflict-free merge, encoding and decoding, inspection,
application, restoration, and the content of all 10,000 restored files. The measured volume and delta policies appear
in the JSON output and in the [workload decision](../decisions/core/measured-workload-policy.md#larger-snapshot-delta-example).

The default policy reaches the first diff and rejects at `identityBytes`. Raising only that limit moves the rejection
to `outputBytes`. The boundary run checks the full policy alongside single-field reductions. A base-record or entry
budget one below the actual count rejects creation. An inherited-record budget one below one side's 9,489
inherited records rejects application. A delta-record budget of 1,023 rejects the merged delta. Reducing the exact
decoded delta size, output record count or output payload size by one rejects application of the merged delta.

On a shared Linux x64 host with a Core i5-10500T and 31.1 GiB RAM, Bun 1.4.4 and Effect 4.1.4 ran three samples
per profile against engine revision `a260fe90`. The qualified delta encoded to 11,550,843 bytes and all nine samples
passed their assertions.

| Profile                                             | Median elapsed | Median first diff | Median process peak RSS | Highest process peak RSS |
| --------------------------------------------------- | -------------: | ----------------: | ----------------------: | -----------------------: |
| Default, rejected at first diff                     |         8.72 s |            218 ms |                 555 MiB |                  574 MiB |
| Qualified, including restoration and content checks |        14.38 s |            701 ms |                 981 MiB |                1,024 MiB |
| Single-field rejections                             |         9.85 s |            429 ms |                 720 MiB |                  732 MiB |

For the qualified run, merge took a median 799 ms, application 427 ms, and restoration 404 ms.

Process peak RSS includes startup, warmup and imports. The default run stops at the first diff, while the qualified
run completes the remaining snapshot operations and verifies every restored file. The peak difference is an observed
cost of the admitted workload. Phase memory samples can miss short peaks, and these timings include assertions.
