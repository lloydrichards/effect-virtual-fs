---
type: Decision
title: Measured workload and quota policy
description: Recommends an explicitly bounded small workspace with persistent directory updates while retaining current capacity defaults and dense file storage.
status: stable
tags: [capacity, quotas, release, storage]
sources:
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/276#issuecomment-5980395978
    title: Workload qualification and policy rationale
  - resource: ../../../packages/core/src/internal/directoryEntries.ts
    title: Persistent name lookup and insertion-order slots
  - resource: ../../../packages/core/src/internal/volumeLimits.ts
    title: Current capacity and admission defaults
  - resource: ../../../packages/core/src/internal/virtualFileSystem.ts
    title: Dense replacement buffers and snapshot ownership
  - resource: ../../../packages/core/test/Snapshot.test.ts
    title: Namespace mutation, capture, overlay, and encoded-restore regression
generated: { by: codex/okf, at: 2026-10-04T13:11:54.526Z }
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
slots use the existing persistent inode-table structure. Inserting or replacing an entry copies only affected branches,
and deletion compacts the slots when deleted slots outnumber live entries. Native `ReadonlyMap` consumers, listing
order, immutable snapshots, and encoded formats stay compatible. Restored native maps are converted on their first
namespace edit. This reduces repeated wide-directory copying while adding some retained directory metadata.

Retain dense replacement-buffer file storage for this release. Detaching before write preserves captured and
overlay content; one-machine measurements do not justify a replacement storage design. Frequent large-file updates
should receive separate storage investigation for a named consumer. Prefer small files and batch writes in current
applications.

Logical quotas do not bound metadata, temporary copies, snapshots, processing, watch subscriber totals, or runtime
memory. The engine file ceiling is not recommended operating capacity. Volume and delta budgets remain separate:
10,000 files of 4 KiB exceed the default delta identity-byte budget even though their volume can be traversed.
Use literal patterns for agent queries by default. Applications exposing native regex must choose an explicit
execution policy because synchronous matching cannot be preempted by Effect timeouts.

The [measurement evidence](../../evidence/workload-envelope.md "evidenced by") records inputs and limitations.
The [capacity accounting decision](volume-capacity-accounting.md "constrained by") owns logical charging;
the [snapshot search decision](../snapshot-search.md "constrained by") owns regex execution guarantees.
Requalify increased workloads or different deployment runtimes. Cross-runtime evidence remains separate release work.
