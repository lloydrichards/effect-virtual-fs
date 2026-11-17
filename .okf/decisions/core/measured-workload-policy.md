---
type: Decision
title: Measured workload and quota policy
description: Recommends a bounded small workspace and qualifies a larger snapshot-delta workload while retaining current capacity defaults.
status: stable
tags: [capacity, quotas, release, storage]
sources:
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/276#issuecomment-5980395978
    title: Workload qualification and policy rationale
  - resource: ../../evidence/workload-envelope.md#large-snapshot-deltas
    title: Measured larger snapshot-delta workload
  - resource: ../../../packages/core/src/internal/runtime.ts
    title: Persistent name lookup and insertion-order slots
  - resource: ../../../packages/core/src/internal/volumeLimits.ts
    title: Current capacity and admission defaults
  - resource: ../../../packages/core/src/internal/runtime.ts
    title: Dense replacement buffers and snapshot ownership
  - resource: ../../../packages/core/test/Snapshot.test.ts
    title: Namespace mutation, capture, overlay, and encoded-restore regression
generated: { by: codex/okf, at: "2026-11-17T21:25:49+01:00" }
---

# Measured workload and quota policy

Recommend a starting policy of 8 MiB logical volume content, 1 MiB per file, 1,000 namespace entries, 1,024 encoded
path bytes, 64 pending operations, and 256 events per subscriber. The measured example uses 1,000 root-level files
of 4 KiB and two separate file edits through snapshot delta and merge. This is a qualified example on the measured
Node/macOS configuration, not a guarantee for every workload fitting the quotas.

```ts
const workspace = Vfs.make({
  maxBytes: ByteSize.mebibytes(8),
  maxFileBytes: ByteSize.mebibytes(1),
  maxEntries: 1000,
  maxPathBytes: ByteSize.bytes(1024),
  maxPendingOperations: 64,
  maxWatchEvents: 256
})
```

Retain unset defaults for `maxBytes`, `maxEntries`, and `maxPathBytes`. Applications choose their workload and resource
policy. Use persistent directory entries for live namespace mutations. Name lookup uses Effect `HashMap`; insertion-order
slots also use Effect `HashMap`. Inserting or replacing an entry copies only affected branches,
and deletion compacts the slots when deleted slots outnumber live entries. Native `ReadonlyMap` consumers, listing
order, immutable snapshots, and encoded formats stay compatible. Restored native maps are converted on their first
namespace edit. This reduces repeated wide-directory copying while adding some retained directory metadata. The
[persistent-state decision](persistent-volume-state.md "refined by") owns the collection and ordering policy.

Retain dense replacement-buffer file storage for this release. Detaching before write preserves captured and
overlay content; one-machine measurements do not justify a replacement storage design. Frequent large-file updates
should receive separate storage investigation for a named consumer. Prefer small files and batch writes in current
applications.

Logical quotas do not bound metadata, temporary copies, snapshots, processing, watch subscriber totals, or runtime
memory. The engine file ceiling is not recommended operating capacity. Use literal patterns for agent queries by
default. Applications exposing native regex must choose an explicit execution policy because synchronous matching
cannot be preempted by Effect timeouts.

The [measurement evidence](../../evidence/workload-envelope.md "evidenced by") records inputs and limitations.
The [capacity accounting decision](volume-capacity-accounting.md "constrained by") owns logical charging;
the [snapshot search decision](../snapshot-search.md "constrained by") owns regex execution guarantees.
Requalify increased workloads or different deployment runtimes. Cross-runtime evidence remains separate release work.

## Larger snapshot-delta example

A flat workspace starts with 10,000 regular files of 4 KiB each. Two sibling snapshots each replace a disjoint
set of 512 files with 8 KiB files. The merged snapshot holds 45,154,304 payload bytes. The same volume passes
traversal with the default delta policy, but delta creation fails first at `identityBytes`. Raising that budget
alone exposes the independent `outputBytes` limit.

Use this complete policy for the measured example.

```ts
const volumeOptions = {
  maxBytes: ByteSize.bytes(45_154_304),
  maxFileBytes: ByteSize.bytes(8_192),
  maxEntries: 10_000,
  maxPathBytes: ByteSize.bytes(1_024),
  maxPendingOperations: 64,
  maxWatchEvents: 256
}

const deltaLimits = {
  maxEncodedBytes: ByteSize.mebibytes(12),
  maxIdentityBytes: ByteSize.mebibytes(48),
  maxDeltaRecords: 1_024,
  maxDecodedDeltaBytes: ByteSize.bytes(8_393_706),
  maxBaseRecords: 10_001,
  maxTargetRecords: 10_001,
  maxEntries: 10_000,
  maxOutputRecords: 10_001,
  maxOutputBytes: ByteSize.bytes(45_154_304),
  maxInheritedRecords: 9_489
}
```

Pass `volumeOptions` to `Vfs.make` and `Vfs.fromSnapshot`. Use `deltaLimits` for diff, inspect, the byte codec,
and apply. Pass it as `{ limits: deltaLimits }` to merge. The root counts as one snapshot record. The decoded-delta
budget covers the 8,388,608 carried file bytes, short ASCII paths `/f0` through `/f1023`, and two digests.

Volume quotas and snapshot-processing budgets are independent. For example, an unchanged delta inherits all
10,001 records and exceeds this example's inherited-record budget. Longer changed paths, hard links, wider edits,
and other directory shapes can change the budget and memory costs. Use the [measured workload and limits checks](../../evidence/workload-envelope.md#large-snapshot-deltas)
to requalify changes to the workload or runtime. The published presets retain their existing limits.
