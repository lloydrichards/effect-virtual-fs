---
type: Evidence
title: Effect HashMap collection tradeoffs
description: Records the accepted actual-VFS CPU and retained-heap costs of replacing the integer trie, with source provenance and runtime limits.
status: stable
tags: [core, collections, performance, memory]
sources:
  - id: measurements
    resource: ../../research/305-vfs-integration-final.json
    title: Final paired trials, normalized traces and source hashes
  - id: ownership
    resource: ../../packages/core/test/internal/volumeState.test.ts
    title: Persistent state and metadata updates without payload inspection
  - id: ordering
    resource: ../../packages/core/test/behaviour/directoryOrder.test.ts
    title: Compaction, insertion order and snapshot isolation
generated: { by: codex/okf, at: "2026-10-21T17:53:04+00:00" }
---

# Effect HashMap collection tradeoffs

The project accepted HashMap for private inode records and explicit directory slots after reviewing actual VFS behavior and costs. Reuse removes maintenance of the custom generic trie. It costs more CPU and retained heap in these scenarios. The [persistent-state decision](../decisions/core/persistent-volume-state.md "supports") owns the representation and ownership requirements.

## Actual VFS measurements

The final comparison uses installed Effect 4.0.0, Bun 1.4.0 and Node 24.21.0 on macOS arm64. The trie baseline is `bfbc3a003a002ed4d6fa3f2cd39c99aa41fdf00c`. The accepted candidate's core sources match the hashes in `research/305-vfs-integration-final.json`.

Five paired trials per runtime and variant run in fresh processes with alternating variant order and one complete warmup trace. Setup, imports and bundling are outside the timed groups. Assertions and result allocation are included. Values are median elapsed milliseconds, with the ratio of candidate and baseline medians. They are scenario measurements, not confidence intervals.

| Workload                                                | Bun trie → HashMap ms | Increase | Node trie → HashMap ms | Increase |
| ------------------------------------------------------- | --------------------: | -------: | ---------------------: | -------: |
| Build 2,000 files                                       |         34.71 → 37.76 |     8.8% |          69.33 → 72.97 |     5.3% |
| 10,000 stats                                            |         36.18 → 42.14 |    16.5% |          44.74 → 47.63 |     6.5% |
| List 10,000 entries twenty times                        |         59.20 → 67.53 |    14.1% |          56.71 → 66.45 |    17.2% |
| 100 mixed directory commits                             |         71.64 → 78.08 |     9.0% |          64.62 → 75.42 |    16.7% |
| Delete/recreate 1,024 entries, retain sixteen snapshots |         35.37 → 38.83 |     9.8% |          42.69 → 49.84 |    16.7% |
| Delete 6,000 entries, triggering compaction             |         80.35 → 90.04 |    12.1% |          82.03 → 94.02 |    14.6% |

The mixed workload performs 32 stats per commit and lists every ten commits. The listing fixture converts its imported native directory map to the measured representation before timing.

Median whole-process post-GC heap with live tool and wide volumes, sixteen historical snapshots, a restored volume and an overlay rises from **28.00 to 32.74 MiB on Bun** and **36.81 to 40.66 MiB on Node**. The extra heap is 4.74 and 3.85 MiB respectively. These include runtime infrastructure and warmup effects. Bun measures JSC heapSize; Node measures heapUsed. They are neither per-inode costs nor peak memory or RSS. Bun's before/after warmup delta does not represent the complete VFS footprint.

Cold chmod and reads of four 1 MiB files are also recorded. Those submillisecond rows are noisy and do not establish meaningful relative rankings. No numerical regression budget was set before measurement. Acceptance is a maintenance tradeoff for these observed costs, not a general performance guarantee.

## Behavioral and ownership evidence

All twenty normalized public traces match. They cover live and restored order, compaction, retained snapshots, overlays, hard links, unlink while open, positional I/O, final close and usage. Wall-clock metadata and random reference IDs are excluded from trace equality.

The persistent-state test checks replacement and removal without changing earlier state. The metadata test fails if reference marking is removed because structural comparison attempts payload inspection. The public directory test preserves live order after compaction and retains captured contents. Snapshot, LiveVolume and SnapshotDelta suites own high-ID import and allocator-exhaustion coverage. Public behavior suites remain the authority for publication, cancellation and adapter semantics.

## Provenance and requalification

Raw trials retain source SHA-256 hashes, worker and bundle hashes, dependency/runtime versions and every measured trace. The exploratory harness is not retained. These results are a historical measurement record, not a maintained benchmark command. Future comparisons need a new harness with matched workload, warmup and retention policies. Compare source and dependency hashes before interpreting new results. Timing values are not ordinary test thresholds.

This evidence executes the installed package, not Effect's target next-minor source. Source inspection alone cannot qualify a different dependency version. Browser runtime and native Node VFS integration also remain separate work. Requalify different workloads, retention policies, runtimes or dependency versions.
