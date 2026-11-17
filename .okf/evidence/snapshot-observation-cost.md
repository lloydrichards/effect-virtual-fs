---
type: Evidence
title: Snapshot capture after unchanged observations
description: Measures the cost of capturing the same filesystem state after a stat or a read.
status: stable
tags: [snapshots, measurements, core]
sources:
  - id: research
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/365
    title: Snapshot cache invalidation investigation
  - id: harness
    resource: ../../scripts/capacity/snapshot-observations.mjs
    title: Reproducible workloads and raw timings
  - id: runtime
    resource: ../../packages/core/src/internal/runtime.ts
    title: Epoch invalidation and snapshot comparison
  - id: preview
    resource: ../../packages/effect-preview/src/virtual-file-system/internal/capture.ts
    title: Capture assembly and streamed record ownership
---

# Snapshot capture after unchanged observations

On Bun 1.4.4, the median second snapshot took **1.27–1.49 ms** after an unchanged stat or read
with 512 KiB of background files, and **3.77–3.92 ms** with 4 MiB. Taking two consecutive
snapshots took **0.38–2.17 µs** for the second capture. In every unchanged case the second
capture returned the first snapshot object. The write control produced a new snapshot.

These results show a repeatable difference in this workload. The benchmark does not
establish a latency requirement, quantify process memory or predict savings for remote storage.

## Reproduce

Run from the repository root with pinned Bun. The harness writes every cycle's first
capture, operation and second capture times to JSON, alongside the tested revision and host.

```sh
bun install --frozen-lockfile
bun run build --filter=@effect-vfs/core
mkdir -p .cache
bun scripts/capacity/snapshot-observations.mjs .cache/snapshot-observations.json
```

The baseline was `f65a9cd36db91539ef8e2e33b0fc78fbe0e286be` on Linux x64
(kernel 7.2.15-1-omarchy, Intel Core i5-10500T, 31.1 GiB RAM). The harness uses two
flat file sets: 128 files of 4 KiB each, and four files of 1 MiB each. Each also has a
one-byte probe file. The snapshot-backed case restores a previously captured seed into
ordinary memory. The live-image case uses `LiveVolume.open` with an in-process store that
accepts staged images. It measures live-image serialization on writes without disk or remote I/O.

Each operation runs five rounds of 20 measured capture/operation/capture cycles, rotating
operation order and discarding three warmup cycles per operation per round. Setup and
assertions sit outside timing. Before measuring reads, the harness reads the probe once so
relatime does not update it during the measured cycles. Every measured read checks its byte,
every stat checks size, and the live-volume counter checks that only the write control commits.

## Recorded samples

These are second-capture times in microseconds. The median column uses all 100 cycles for that
row. Each round column is the median of that round's 20 cycles.

| Volume          | Background files | Operation |  Median | Round 1 | Round 2 | Round 3 | Round 4 | Round 5 |
| --------------- | ---------------- | --------- | ------: | ------: | ------: | ------: | ------: | ------: |
| snapshot-backed | 128 × 4 KiB      | none      |    0.40 |    1.41 |    0.48 |    0.38 |    0.39 |    0.32 |
| snapshot-backed | 128 × 4 KiB      | stat      | 1265.55 | 2064.19 | 1400.98 | 1190.27 | 1165.24 | 1163.81 |
| snapshot-backed | 128 × 4 KiB      | read      | 1352.95 | 1767.92 | 1392.71 | 1385.56 | 1159.74 | 1142.14 |
| snapshot-backed | 128 × 4 KiB      | write     | 1500.51 | 1731.44 | 1647.50 | 1502.69 | 1424.51 | 1402.68 |
| live-image      | 128 × 4 KiB      | none      |    2.00 |    2.51 |    1.92 |    2.01 |    1.92 |    1.88 |
| live-image      | 128 × 4 KiB      | stat      | 1485.95 | 2074.35 | 1626.25 | 1458.99 | 1423.06 | 1369.92 |
| live-image      | 128 × 4 KiB      | read      | 1352.94 | 1367.41 | 1348.56 | 2316.10 | 1232.24 | 1224.35 |
| live-image      | 128 × 4 KiB      | write     | 1709.67 | 1697.37 | 1675.63 | 1707.76 | 1821.36 | 1705.42 |
| snapshot-backed | 4 × 1 MiB        | none      |    0.38 |    0.34 |    0.41 |    0.42 |    0.36 |    0.33 |
| snapshot-backed | 4 × 1 MiB        | stat      | 3859.66 | 4627.34 | 3736.95 | 4111.95 | 3931.90 | 3815.12 |
| snapshot-backed | 4 × 1 MiB        | read      | 3837.07 | 4129.01 | 3740.51 | 3769.95 | 3748.67 | 3725.92 |
| snapshot-backed | 4 × 1 MiB        | write     | 3901.48 | 3887.85 | 3904.40 | 3811.28 | 3785.88 | 4144.93 |
| live-image      | 4 × 1 MiB        | none      |    2.17 |    1.87 |    2.05 |    2.13 |    2.09 |    3.12 |
| live-image      | 4 × 1 MiB        | stat      | 3771.58 | 3802.59 | 3781.76 | 3897.08 | 3762.89 | 3736.65 |
| live-image      | 4 × 1 MiB        | read      | 3920.29 | 3878.48 | 3992.71 | 3919.90 | 3869.05 | 3988.51 |
| live-image      | 4 × 1 MiB        | write     | 4086.90 | 4008.91 | 4142.19 | 4149.54 | 4160.41 | 3979.85 |

## What accounts for the difference

Each admitted core operation advances the epoch before it runs. A cache miss calls the
preview capture, which copies regular-file payload during capture assembly and again when
the capture emits its records. Core collects those records and compares metadata and payload
before returning the previous snapshot. For the measured fixtures, the two passes together
copy 1,048,578 or 8,388,610 regular-file bytes per full capture, including the probe.
Those are counts derived from the two source paths and fixture sizes. They exclude other
allocations and do not measure bytes copied by the runtime or the storage provider.

A follow-up can evaluate whether the saved work warrants changing invalidation. It must prove
that stat, access and sync can reuse the cache when authoritative state is unchanged, and that
reads which update relatime, metadata changes, namespace changes, synchronous writes and final
handle release still invalidate when needed. Preserve the capture gates and publication
rules in the [mutation and observation contract](../contracts/mutation-and-observation.md).
