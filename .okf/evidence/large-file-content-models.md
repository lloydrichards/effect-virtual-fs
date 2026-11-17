---
type: Evidence
title: Large-file content storage comparison
description: Measures replacement buffers and copy-on-write pages for repeated partial writes and contiguous growth.
status: stable
tags: [capacity, storage, measurements]
sources:
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/284
    title: Large-file storage investigation
  - resource: workload-envelope.md
    title: Existing integrated capacity workloads
  - resource: ../../scripts/capacity/file-content-models.mjs
    title: Isolated content-model comparison
  - resource: ../../packages/effect-preview/src/virtual-file-system/internal/handles.ts
    title: Current dense write and truncate staging
  - resource: ../contracts/mutation-and-observation.md
    title: Coordinated commit and publication
  - resource: ../decisions/core/volume-capacity-accounting.md
    title: Logical charging and live inode ownership
---

# Large-file content storage comparison

For 100 aligned 4 KiB overwrites of a 64 MiB file, the dense model copied 6.25 GiB of old payload. The 64 KiB
page model copied 6.25 MiB, and the 4 KiB page model replaced complete pages without copying their previous bytes.
Flattening the paged result took 34–35 ms in the same workload, compared with 11 ms for the dense export.
The measurements support considering 64 KiB immutable pages if a consumer needs frequent large-file updates.
The existing dense storage policy stays in place.

## Reproduce

Run the comparison from the repository root on Bun 1.4.4.

```sh
mkdir -p .cache
bun scripts/capacity/file-content-models.mjs .cache/file-content-models.json
```

The harness uses the partial and growth workloads from the [integrated capacity benchmark](workload-envelope.md).
Partial writes overwrite the first 4 KiB 100 times. Growth appends 1 MiB at a time from empty until the target size.
Both workloads use targets of 1, 16, and 64 MiB. Each model, scenario, and size has one discarded process run and
three measured fresh-process runs. The model order rotates between rounds. Each run verifies a digest of the complete
result and of an initial generation retained across the writes.

The baseline stages a new dense buffer and copies the previous payload and new input. Paged models shallow-copy
the page vector and replace affected pages. Complete page overwrites replace the page directly. Partial page writes
copy the old page before applying the input. The two page sizes are 4 KiB and 64 KiB. The final export produces a new
contiguous byte array for every model. The isolated harness bypasses filesystem operation admission, input ownership
checks, metadata, quota checks, capture and encoding, and durable commits.

## Results

The run used Linux x64, kernel 7.2.15-1-omarchy, an Intel Core i5-10500T, and 31.1 GiB RAM at
`812957e388b55d41c1b591961ba557d8c5fb4e5d`. Values are the medians of the three process results.
Latency p50 and p95 select the element at the floor of the corresponding fraction of the sorted operation samples.
A 1 MiB growth trial has one operation, so its p50 and p95 coincide. Sampled RSS is the largest sample taken before
or after a write. The process peak through writes includes the runtime startup and file setup. The harness also emits
sampled heap and the process high-water RSS through export to JSON.

| File MiB | Scenario | Model     | Write p50 ms | Write p95 ms | Sampled RSS MiB | Peak RSS through writes MiB | Export ms | Allocated MiB | Old bytes copied MiB |
| -------: | -------- | --------- | -----------: | -----------: | --------------: | --------------------------: | --------: | ------------: | -------------------: |
|        1 | partial  | dense     |       0.0698 |       0.6063 |            46.7 |                        47.4 |    0.0726 |        100.00 |               100.00 |
|        1 | partial  | pages-4k  |       0.0033 |       0.0113 |            23.0 |                        23.2 |    0.4627 |          0.39 |                 0.00 |
|        1 | partial  | pages-64k |       0.0222 |       0.0568 |            26.8 |                        27.6 |    0.5428 |          6.25 |                 6.25 |
|        1 | growth   | dense     |       0.3913 |       0.3913 |            20.6 |                        23.3 |    0.3644 |          1.00 |                 0.00 |
|        1 | growth   | pages-4k  |       0.6734 |       0.6734 |            21.2 |                        23.3 |    0.4399 |          1.00 |                 0.00 |
|        1 | growth   | pages-64k |       0.4887 |       0.4887 |            21.2 |                        23.3 |    0.4064 |          1.00 |                 0.00 |
|       16 | partial  | dense     |       3.1951 |       7.1765 |           211.9 |                       212.4 |    2.4033 |       1600.00 |              1600.00 |
|       16 | partial  | pages-4k  |       0.0180 |       0.0392 |            42.4 |                        42.7 |    7.9034 |          0.39 |                 0.00 |
|       16 | partial  | pages-64k |       0.0234 |       0.0349 |            29.7 |                        29.9 |    7.7610 |          6.25 |                 6.25 |
|       16 | growth   | dense     |       3.9953 |       8.7861 |           108.6 |                       108.8 |   10.1516 |        136.00 |               120.00 |
|       16 | growth   | pages-4k  |       0.5089 |       1.7191 |            40.9 |                        41.1 |    7.6570 |         16.00 |                 0.00 |
|       16 | growth   | pages-64k |       0.3779 |       1.4376 |            37.0 |                        37.2 |    7.0010 |         16.00 |                 0.00 |
|       64 | partial  | dense     |      17.4754 |      38.0463 |          1043.8 |                      1043.8 |   11.2553 |       6400.00 |              6400.00 |
|       64 | partial  | pages-4k  |       0.0470 |       0.0807 |           103.3 |                       103.5 |   35.0085 |          0.39 |                 0.00 |
|       64 | partial  | pages-64k |       0.0314 |       0.0430 |            33.7 |                        34.0 |   34.1754 |          6.25 |                 6.25 |
|       64 | growth   | dense     |       9.3358 |      24.3990 |           510.4 |                       510.6 |   30.4700 |       2080.00 |              2016.00 |
|       64 | growth   | pages-4k  |       0.4776 |       1.1328 |            95.9 |                        96.0 |   28.7418 |         64.00 |                 0.00 |
|       64 | growth   | pages-64k |       0.3605 |       0.7448 |            86.0 |                        86.3 |   26.5652 |         64.00 |                 0.00 |

Allocated bytes count new backing storage created by writes. Old bytes count the prior payload copied during writes.
These counters exclude setup, the input block, page-vector references, runtime allocator overhead, and export. RSS
includes the entire process. For partial trials the initial file is zero-filled. The runtime and OS can defer backing
zero pages until touched, so the measured RSS of a paged model does not establish its footprint for a fully populated
file. Samples also miss within-operation peaks. Export timing measures materialization alone. It excludes base64,
snapshot bookkeeping, provider writes, and digest verification.

## Design implications

- **Dense replacement buffers.** Keep one contiguous representation with simple whole-file export and low
  small-file overhead. A candidate owns its replacement bytes before publication. A 64 MiB file still incurs
  64 MiB of prior-payload copying for every partial write.
- **Immutable pages.** The tested vector copies one reference per page on each update. A smaller page reduces
  copying for small overwrites and increases page references and export work. A larger page reduces page metadata
  and vector-copy cost and increases work for unaligned updates. A persistent vector could reduce reference
  copying, with added lookup overhead that this trial did not measure.
- **Geometric dense growth.** Extra capacity could amortize appends when a writer exclusively owns a mutable
  buffer. Published snapshots and interrupted or rejected candidates require independent bytes. Reserving extra
  capacity alone leaves partial-write copying intact and can increase retained memory.

The measured models do not establish operating headroom for a workload with many retained snapshots, random
writes, gaps, or durable publication. Any candidate must count logical bytes once per inode, keep hard links attached
to that inode, and zero-fill extensions without exposing truncated bytes. An unchanged page may be shared across
generations only while immutable. The candidate stays private until commit succeeds. Rejection and interruption
retain the previously published generation. Public reads and capture records must still own their bytes, and snapshot
v1 and durable-image encoding must remain compatible.

Keep the [measured workload policy](../decisions/core/measured-workload-policy.md) for the existing small-workspace
profile. The investigation and its linked consumer work do not identify a named consumer requiring this change.
Qualify any candidate with that consumer's read and update mix, retained generations, snapshot export, and commit
backend. Exercise pwrite and truncate boundaries, holes, short writes under quotas, snapshot and overlay isolation,
serialized round trips, and rollback before changing the runtime.
