---
type: Decision
title: Scoped watch
description: A volume watch narrows to one object reference and optionally its subtree, filters each event against the installed tree before it counts toward the queue, rescans at the scope's current path, and ends after the scope's removal.
status: stable
tags: [watch, events, references, adapter]
sources:
  - id: api
    resource: ../../../packages/core/src/Watch.ts
    title: WatchOptions and the Change schema
  - id: volume
    resource: ../../../packages/core/src/VirtualFileSystem.ts
    title: Volume.watch contract
  - id: engine
    resource: ../../../packages/core/src/internal/virtualFileSystem.ts
    title: WatchEvent, scopeRoot, scopedSelection, and publication in install
  - id: hub
    resource: ../../../packages/core/src/internal/watchHub.ts
    title: Per-subscriber selection, rescan, and settle
  - id: adapter
    resource: ../../../packages/memory/src/internal/memoryFileSystem.ts
    title: FileSystem.watch over a scoped core watch
  - id: tests
    resource: ../../../packages/core/test/ScopedWatch.test.ts
    title: Subtree, depth, renames, moves, scope end, and rejected scopes
  - id: bounded-tests
    resource: ../../../packages/core/test/WatchBounded.test.ts
    title: Scoped subscriber under an out-of-scope flood, a scoped Rescan, and the scope's removal at the last slot
  - id: adapter-tests
    resource: ../../../packages/memory/test/CoreBinding.test.ts
    title: Ancestor rename, a watched file followed across renames and hidden from its other hard links, end of an adapter watch, and changes that land as it opens
  - id: adapter-alias-tests
    resource: ../../../packages/memory/test/MemoryFileSystem.test.ts
    title: A watched file reports its watched name only
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/206
    title: Path-scoped watch
generated: { by: claude-code, at: "2026-09-26T13:25:00+02:00" }
---

# Scoped watch

Amends the [public API decision](public-api-targets-services-and-errors.md "amends"), which had declined a path-scoped watch for 0.6.0, and the [watch event overflow decision](watch-event-overflow.md "amends"), whose `Rescan` at `/` assumed every watch covers the volume, and keeps its rule that `Volume.watch` is an effect registered before it returns. The decisions were grilled on 2026-09-25 and recorded on [issue #206](https://github.com/lloydrichards/effect-virtual-fs/issues/206 "decided on"); the review of 2026-09-26 amended decisions 6 and 7.

## Context

Every core watch covered the whole volume. The memory adapter narrowed it with a byte-prefix filter over each event's path, resolved once when it subscribed. Changes outside the watched path still filled the subscriber's queue, so a narrow watch overflowed on events it discarded. A rename of the watched directory or one of its ancestors silently stopped the watch, because every later event carried a path outside the fixed prefix. The hub already builds each event once per commit from the installed value, so testing it against a scope before queueing costs one walk up the tree.

## Decisions

1. **The scope is an object reference.** `Volume.watch({ scope?, recursive? })` takes an `ObjectReference`, checked while the registration holds the volume: an unknown token fails `InvalidReference`, another volume's `ForeignReference`, and an object with no name left `StaleReference`. A value that is not a reference at all fails decoding as `InvalidArgument` with `field: "scope"`. Without a scope the watch covers the volume, as before. A path target is resolved by the caller, as memory does; a `Caller.watch` that resolves with the caller's identity waits for #28.
2. **Filter before enqueue.** Each subscriber's selection decides whether it takes an event before the event counts toward its queue, so changes outside the scope cannot overflow it. An event carries the directory holding its entry and the object the entry names. It is in scope when it names the scope object, or when its directory is the scope or, if recursive, lies below it on the installed tree's parent chain. The scope therefore follows renames of the object and its ancestors.
3. **`Rescan` names the scope.** A scoped subscriber's marker carries the scope's current path, or its last one when the same change removed it. The `/` of the overflow decision applies to a volume-wide watch only. Memory ignores the marker's path.
4. **Moves across the boundary.** Each event is tested on its own, so a move out of scope arrives as `Remove` and a move in as `Create`, with no events for the moved subtree, as for an unscoped watch. A rename of the scope object itself is reported as `Remove` at its old path and `Create` at its new one, since both name the object, and the watch goes on.
5. **Depth is `recursive`.** It mirrors Effect's `FileSystem.watch` option. `false` reports the object and its direct children only. It defaults to `true`, unlike Effect, so that `watch()` stays the recursive volume-wide watch; memory passes Effect's flag through, so its default stays non-recursive. `watch({ recursive: false })` without a scope reports the root's direct children.
6. **The scope's removal ends the stream.** Once the object's last name is gone, the subscriber receives `Remove` for it and its stream ends, as inotify sends `IN_DELETE_SELF` then `IN_IGNORED`. The `Remove` is reported once the publication that removed the object has been offered, at each path it had before the change, whether an event named it or a rename replaced it and none did. It is never replaced by `Rescan`: the queue keeps one slot past its capacity for it, so it arrives even when the removal would have filled the queue, and after the marker when one is already queued. A file with several names stays watched until the last goes.
7. **Memory watches through a scope.** `FileSystem.watch` resolves the path with `realPath`, looks up the object it names (the root for `/`), and opens a core watch scoped to it. The byte filter is gone, which fixes the silent ancestor rename. A watch on a file reports only changes made under the watched name, not under the file's other hard links, as it did before; the watched name follows the file when it or an ancestor is renamed, so a change under a new name is reported once the old name no longer names the file; a directory watch reports its subtree at current paths. A watch ends once its object is removed. Resolving the path and registering the watch are separate turns on the volume, so a change can land between them: the adapter keeps a registration only when the path still names the scope once the watch is active, and otherwise closes it and resolves again, up to three times before failing `Busy`. A path removed in that window fails `NotFound`. Out-of-scope paths never reach the adapter, so an out-of-scope non-UTF-8 name still cannot fail it.

## Consequences

`Volume.watch` is a function: `volume.watch()` replaces `volume.watch`. The hub no longer knows the rescan path or availability; the engine passes each subscriber's selection, and one publication per installation carries the values before and after it. Permission checks on the scope are not part of a volume watch, which is capability-level. The [mutation and observation contract](../../contracts/mutation-and-observation.md "constrains") states scoped delivery, and the [memory adapter compatibility contract](../../contracts/memory-adapter-compatibility.md "constrains") the adapter's watch identity.
