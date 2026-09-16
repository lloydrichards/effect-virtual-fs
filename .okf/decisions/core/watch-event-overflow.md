---
type: Decision
title: Watch event overflow
description: Proposes bounding the watch hub and signalling dropped events with an in-band rescan marker instead of growing without limit, and records the four choices still open.
status: draft
tags: [watch, backpressure, pubsub, events, adapter]
sources:
  - id: hub
    resource: ../../../packages/core/src/internal/virtualFileSystem/watchHub.ts
    title: Watch hub publish and subscribe
  - id: core
    resource: ../../../packages/core/src/internal/virtualFileSystem.ts
    title: Change publication and volume options
  - id: api
    resource: ../../../packages/core/src/VirtualFileSystem.ts
    title: Public Change interface and Volume.watch
  - id: memory
    resource: ../../../packages/memory/src/internal/memoryFileSystem.ts
    title: Adapter mapping from Change to platform WatchEvent
  - id: pubsub
    resource: ../../../node_modules/effect/src/PubSub.ts
    title: Effect PubSub atomic and strategy implementation
  - id: inotify
    resource: https://man7.org/linux/man-pages/man7/inotify.7.html
    title: inotify(7), IN_Q_OVERFLOW and max_queued_events
  - id: inotify-src
    resource: https://github.com/torvalds/linux/blob/master/fs/notify/inotify/inotify_user.c
    title: Preallocated overflow event in inotify_new_group
  - id: fsevents
    resource: https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/FSEvents_ProgGuide/UsingtheFSEventsFramework/UsingtheFSEventsFramework.html
    title: FSEvents MustScanSubDirs and dropped-event flags
  - id: kqueue
    resource: https://man.freebsd.org/cgi/man.cgi?query=kqueue&sektion=2
    title: kqueue(2), EVFILT_VNODE fflags aggregation
  - id: rdcw
    resource: https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw
    title: ReadDirectoryChangesW and ERROR_NOTIFY_ENUM_DIR
  - id: libuv-linux
    resource: https://github.com/libuv/libuv/blob/v1.x/src/unix/linux.c
    title: uv__inotify_read watcher lookup
  - id: libuv-fsevents
    resource: https://github.com/libuv/libuv/blob/v1.x/src/unix/fsevents.c
    title: kFSEventsSystem mask filtering dropped flags
  - id: notify
    resource: https://docs.rs/notify/latest/notify/event/enum.Flag.html
    title: Rust notify Flag::Rescan
  - id: fsnotify
    resource: https://github.com/fsnotify/fsnotify/blob/main/backend_inotify.go
    title: Go fsnotify ErrEventOverflow
generated: { by: claude/okf, at: 2026-09-16T00:00:00Z }
---

# Watch event overflow

Draft. Raised while auditing the core volume implementation; nothing here is implemented and the four questions in "Open" are not settled.

## Problem

The watch hub publishes into an unbounded `PubSub`.[^hub] `publishUnsafe` never blocks, so a mutation holding the volume permit always completes, and the queue retains every `Change` until the slowest subscriber drains it. Exposure is precisely one case: at least one subscriber exists and reads slower than the mutation rate. The `activeSubscribers === 0` short-circuit already makes the unwatched case free.

Existing quotas do not bound this. [Volume capacity accounting](volume-capacity-accounting.md "constrained by") limits entries and content, not event volume, and a write loop on a single path emits without limit against a fixed namespace.

## Why bounding alone is a regression

`publishUnsafe` bypasses the PubSub strategy entirely: it calls the atomic layer and `handleSurplus` is never reached.[^pubsub] `bounded`, `dropping` and `sliding` share one atomic and differ only in strategy, so on this call path all three behave identically — return `false` and discard the new value. Sliding does not evict the oldest, because eviction lives in the strategy.

Switching constructor therefore adds no backpressure. It converts unbounded memory into silent data loss, which is worse than the present behaviour for any consumer maintaining an incremental view.

## Proposed shape

Bound the hub and tell the consumer what it missed. Every filesystem-watch API that can lose events signals it, with one consumer contract: rescan, because the lost set cannot be described. inotify emits a synthetic in-band event with `wd = -1`,[^inotify] FSEvents sets `kFSEventStreamEventFlagMustScanSubDirs`,[^fsevents] Windows returns `ERROR_NOTIFY_ENUM_DIR`,[^rdcw] Rust `notify` exposes `Flag::Rescan`,[^notify] Go `fsnotify` sends `ErrEventOverflow`.[^fsnotify]

Node is the sole outlier and not by intent: libuv resolves inotify events by watch descriptor, the overflow event carries `wd = -1`, so the lookup misses and the event is skipped;[^libuv-linux] on macOS the drop flags sit in an explicit ignore mask.[^libuv-fsevents] That is the "watching silently stopped working" failure, not a model to copy.

Three properties follow from the prior art:

- **Drop newest.** inotify tail-drops. Buffered older events stay individually useful, and the consumer applies them and then rescans. Windows discards its whole buffer, which is strictly less useful.
- **Scope the marker to a path.** FSEvents attaches the flag to a path-carrying event so the consumer rescans a subtree, not the volume. inotify's pathless marker is the cruder design, and Rust's is pathless only because it normalises across backends.
- **Never let the bound block the marker.** `inotify_new_group` preallocates the overflow event once, so it is always deliverable.[^inotify-src] The equivalent here is reserving the last slot: publish ordinary events only while the hub is below `capacity - 1`.

## Considered and rejected

- **Backpressure the producer.** Because writes go through our own code and `Stream` is pull-based, blocking the writer is available to us and is lossless; no kernel can block `write(2)` on a slow watcher. It is rejected because a watcher fiber that itself writes would deadlock against the volume permit.
- **Coalesce per path instead of bounding.** kqueue avoids overflow structurally by aggregating `fflags` per registered vnode, so its queue is bounded by watch count.[^kqueue] Coalescing is worth adopting on its own merits — it bounds the common cause, a tool rewriting one file repeatedly — but it is not a substitute: a recursive delete touches an unbounded number of _distinct_ paths, which is why FSEvents coalesces and still needs a rescan flag. It also requires a defined merge algebra per path, so it is separable from this decision rather than part of it.

## Open

1. **Marker carrier.** `Change` today is a three-tag struct with a required path.[^api] A `rescan` flag on it is additive and keeps the adapter compiling; a fourth `_tag` is breaking but forces every consumer to rule on it. The flag risks reproducing libuv's silent discard by default.
2. **Adapter behaviour.** Platform `WatchEvent` has three variants and no overflow notion,[^memory] and `@effect/platform` offers no precedent to follow. What `@effect-vfs/memory` does with a marker it cannot express is a decision, not a detail.
3. **Per-subscriber accounting.** Effect's PubSub shares one refcounted ring buffer, so a permanently stalled subscriber holds every slot and an actively reading subscriber goes silent and never receives the marker. Kernels avoid this by giving each instance its own queue. Resolving it needs either per-subscriber depth via `remainingUnsafe` or a policy for evicting a stalled subscriber.
4. **Capacity.** Default value, whether it joins `VolumeOptions` beside the existing limits,[^core] and whether per-path coalescing lands here or later.

## Evidence

PubSub behaviour was read from the vendored source, not executed. The stalled-subscriber case in question 3 is derived from the refcount discipline and needs a regression test before it is treated as established.

[^hub]: `make` builds `PubSub.unbounded`, and both publish paths return early when `activeSubscribers` is zero.

[^pubsub]: `publishUnsafe` calls `self.pubsub.publish(value)` and returns its boolean; `bounded`, `dropping` and `sliding` all construct `makeAtomicBounded` and differ only in the strategy that `publishUnsafe` never invokes.

[^core]: `VolumeOptions` already carries `maxEntries`, `maxBytes`, `maxFileBytes` and `maxPathBytes`, and `publishNode` is the single producer of change events.

[^api]: `Change` is `{ _tag: "Create" | "Update" | "Remove"; path: BytePath }`, and `Volume.watch` is documented as not replaying events, which the PubSub default replay window of zero satisfies.

[^memory]: The adapter forwards `event._tag` unchanged into a platform `WatchEvent`, so any variant or field the platform type lacks is lost at that boundary.

[^inotify]: Events beyond `max_queued_events` are dropped and an `IN_Q_OVERFLOW` event is always generated, delivered in the ordinary read stream.

[^inotify-src]: The group's overflow event is allocated at creation with `wd = -1`, `cookie = 0` and no name, so delivery never depends on memory available at overflow time.

[^fsevents]: A dropped event always also sets `MustScanSubDirs`; the `UserDropped` and `KernelDropped` flags are informational only, and the documented contract is a recursive rescan of the path on the event.

[^kqueue]: Repeated triggers do not enqueue repeated kevents; the filter aggregates them into one kevent whose `fflags` holds the accumulated set, so the queue is bounded by registered knotes.

[^rdcw]: On buffer overflow the call still succeeds but returns zero bytes and discards the whole buffer; the documented response is to enumerate the directory or subtree.

[^libuv-linux]: `uv__inotify_read` resolves each event through `find_watcher(loop, e->wd)` and `continue`s when it returns null, which is always the case for the overflow event's `wd = -1`.

[^libuv-fsevents]: The dropped-event flags are members of `kFSEventsSystem`, and events matching that mask are skipped with an explicit "ignore system events" branch.

[^notify]: `Flag::Rescan` marks a lapse in events and is surfaced by `Event::need_rescan()`; its documentation names in-memory filesystem representations as the consumer that must refresh.

[^fsnotify]: The inotify backend maps `IN_Q_OVERFLOW` to `ErrEventOverflow` on the error channel rather than the event channel.
