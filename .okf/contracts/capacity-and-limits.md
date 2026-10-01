---
type: Contract
title: Capacity and limits
description: Defines logical entry and byte accounting together with file, path, and snapshot processing limits.
status: stable
tags: [capacity, limits, quotas]
sources:
  - resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Volume options and quota implementation
  - resource: ../../packages/core/src/Snapshot.ts
    title: Snapshot decode limits
  - resource: ../../packages/core/src/internal/volumeLimits.ts
    title: Effective and stored volume limits
  - resource: ../../packages/core/test/LiveVolume.test.ts
    title: Durable runtime limits and capacity compatibility
  - resource: ../../packages/core/test/FileHandle.test.ts
    title: File quota behavior tests
generated: { by: codex/okf, at: 2026-10-01T11:00:00Z }
---

# Capacity and limits

Volumes may bound logical regular-file bytes, individual file size, and encoded path length with exact `ByteSize.ByteSize` values, while namespace entry limits remain numeric. File contents and symlink targets are charged once per inode; directory names consume entries; root and implicit dot entries do not.

Unlinked open files remain charged. Dense regular files cannot exceed 4,294,967,295 bytes, and `maxFileBytes` may lower that ceiling. Total-volume accounting compares exact bigint byte counts without narrowing them to JavaScript numbers. Snapshot decoding requires exact `ByteSize.ByteSize` encoded and decoded byte limits plus numeric record and entry limits; restore also enforces destination volume quotas.

Every constructed volume also publishes storage facts independent of capacity: a durability level, a stable logical identity, and a fresh runtime incarnation. Core currently reports `memory-only`. Snapshot bytes contain neither token; callers may supply an identity when restoring to continue the same logical volume, while every restoration receives a new incarnation.

`Volume.limits` reports the effective static limits. Absent `maxBytes`, `maxEntries`, or `maxPathBytes` means unlimited; `maxFileBytes` always reports the smaller of the configured limit and the engine's 4,294,967,295-byte ceiling. The reusable `Volume.usage` effect samples `usedBytes` and `entries` together under the mutation gate. `usedBytes` includes content of open unlinked files until the last handle closes, while `entries` counts their removed names no longer. Restoring a snapshot starts the new volume's usage at the reachable content and entry totals.

See [volume capacity accounting](../decisions/core/volume-capacity-accounting.md "constrained by"), [volume durability and usage facts](../decisions/core/volume-durability-and-usage-facts.md "refined by"), and [optional total path limit](../decisions/core/optional-total-path-limit.md "constrained by").

Live images store capacity limits and identity. `LiveVolume.open` compares the requested effective capacities with those stored in the image and checks identity when explicitly supplied; a mismatch fails with `IncompatibleStore`. Omitted byte, entry, and path quotas mean unlimited, and an omitted file limit means the engine ceiling. Equal byte quantities compare equal regardless of their unit.

`maxPendingOperations` and `maxWatchEvents` apply to each open and are excluded from the version 1 live image. Reopening may change them without changing stored capacity. Pending admission defaults to 64 plus one active-operation slot. Watch retention defaults to 256 per subscriber, including its reserved `Rescan` slot. The [watch overflow decision](../decisions/core/watch-event-overflow.md "constrained by") defines their behavior.
