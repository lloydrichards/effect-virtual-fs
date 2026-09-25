---
type: Decision
title: Watch event overflow
description: Defines bounded per-subscriber watch retention, an in-band rescan marker, and retryable volume admission.
status: stable
tags: [watch, admission, events, adapter]
sources:
  - id: api
    resource: ../../../packages/core/src/VirtualFileSystem.ts
    title: Public limits, Change, and Volume.watch contract
  - id: engine
    resource: ../../../packages/core/src/internal/virtualFileSystem.ts
    title: Admission and change publication
  - id: hub
    resource: ../../../packages/core/src/internal/watchHub.ts
    title: Per-subscriber watch queues
  - id: adapter
    resource: ../../../packages/memory/src/internal/memoryFileSystem.ts
    title: Platform watch overflow projection
  - id: adapter-api
    resource: ../../../packages/memory/src/MemoryFileSystem.ts
    title: Public overflow guard
  - id: tests
    resource: ../../../packages/core/test/WatchBounded.test.ts
    title: PubSub probe, admission, and subscriber tests
  - id: adapter-tests
    resource: ../../../packages/memory/test/CoreBinding.test.ts
    title: Adapter overflow test
  - id: pubsub
    resource: ../../../node_modules/effect/src/PubSub.ts
    title: Effect PubSub publishUnsafe implementation
generated: { by: claude-code, at: "2026-09-26T12:00:00+02:00" }
---

# Watch event overflow

## Admission

`maxPendingOperations` defaults to 64. The volume admits at most 65 callers at once, the same number as the gate holds permits; an observation takes one and a mutation or watch registration takes them all. Excess mutations, observations, and watch registrations fail with retryable `FsError` code `VolumeBusy` before mutation or durable commit. All three permit waits are interruptible; watch registration installs its finalizer before it waits, so a scope that closes during registration still removes the subscriber. Cleanup finalizers and provider shutdown can still enter the volume. NFS maps `VolumeBusy` to `NFS4ERR_DELAY` in both the default read-only and guarded writable profiles.[^engine]

## Watch retention and recovery

Every subscriber has an independent queue. `maxWatchEvents` defaults to 256 and must be at least 2. The last slot is reserved for `Rescan`, the fourth `Change._tag`. When a queue fills, its subscriber receives buffered changes in order, followed by `Rescan`; further changes to that subscriber are dropped until it consumes the marker. Nothing is queued behind the marker, so the publisher treats an empty queue as the marker having been taken and delivers again from the next change. A stalled subscriber cannot block a mutation or stop another subscriber's progress. A volume-wide watch receives `Rescan` at `/`, which calls for a full rescan; a [scoped watch](scoped-watch.md "amended by") receives it at its scope's current path, changes outside its scope never count toward its queue, and the `Remove` that ends it takes one slot kept past the capacity, so the marker never replaces it. No path coalescing is part of this decision.[^api][^hub][^tests]

`Volume.watch()` stays an effect that returns the stream only after the subscriber is registered while holding every permit. A change committed after it returns is never missed, so a caller can subscribe and then write. A lazy `Stream` member would register only when first pulled and lose that guarantee, so none is offered; the memory adapter wraps the effect with `Stream.unwrap` at its own boundary. The stream takes one event per pull, so a partially consumed stream can be run again without losing buffered changes.[^hub][^adapter]

A core consumer rescans after `Rescan` and repeats if another marker arrives. Effect's `FileSystem.WatchEvent` cannot represent the marker. `@effect-vfs/memory` ends its watch stream with a platform error identified by `MemoryFileSystem.isWatchOverflow`. Its caller opens a new watch before rescanning the watched path, then repeats if that watch overflows. Opening the watch first avoids a gap between the scan and registration.[^adapter][^adapter-api][^adapter-tests]

## Why each subscriber owns a queue

The previous unbounded PubSub retained changes until the slowest subscriber consumed them. Merely changing its constructor to bounded would silently lose events: `PubSub.publishUnsafe` bypasses the configured surplus strategy. The focused probe confirms that a stalled subscriber causes `publishUnsafe` to reject a new event even when another subscriber has consumed the earlier events. Independent queues and an in-band marker preserve observable loss without giving the stalled subscriber control over writers.[^pubsub][^tests]

Existing [volume capacity accounting](volume-capacity-accounting.md "complements") bounds entries and content, not repeated events for one path.

[^api]: `Change`, `VolumeOptions`, and `VolumeLimits` expose the public contract.

[^engine]: The admission wrapper runs before coordinated work and releases its slot after success, failure, or interruption.

[^hub]: Each queue reserves one slot for its own marker and publishes without waiting for its consumer.

[^tests]: The PubSub probe, overflow test, active-subscriber test, and cancelled mutation and watch waits exercise these rules.

[^adapter]: The adapter maps ordinary changes to `WatchEvent` and turns `Rescan` into a stream failure, including for subtree watches.

[^adapter-api]: The public guard identifies the adapter's exact overflow error.

[^adapter-tests]: The test observes the error through the public guard, then opens a new watch before rescanning and receives a change made during that scan.

[^pubsub]: `publishUnsafe` calls the atomic publish operation without the bounded strategy's surplus handler.
