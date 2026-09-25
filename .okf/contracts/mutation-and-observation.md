---
type: Contract
title: Mutation and observation
description: Defines coordinated publication, interruption boundaries, snapshot consistency, and committed watch events.
status: stable
tags: [concurrency, watches, snapshots]
sources:
  - resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Mutation coordination and watch implementation
  - resource: ../../packages/core/test/Replacement.test.ts
    title: Replacement and coordination tests
  - resource: ../../packages/core/test/VirtualFileSystem.test.ts
    title: Watch and lifecycle tests
  - resource: ../../packages/core/test/MutationRevision.test.ts
    title: Revision and coordinated observation tests
  - resource: ../../packages/core/test/Watch.test.ts
    title: Watch registration and delivery tests
  - resource: ../../packages/core/test/WatchBounded.test.ts
    title: Bounded admission and watch overflow tests
  - resource: ../../packages/core/test/ScopedWatch.test.ts
    title: Scoped watch tests
  - id: tracing-tests
    resource: ../../packages/core/test/Tracing.test.ts
    title: Public tracing boundary tests
  - id: tree-tests
    resource: ../../packages/core/test/RemoveRecursive.test.ts
    title: Recursive removal as a composition of changes
generated: { by: claude-code, at: "2026-09-26T12:00:00+02:00" }
---

# Mutation and observation

One volume coordinates mutations, observations, snapshot capture, and resource release. Observations may run beside each other; a mutation, a resource release, or a watch registration runs alone, so an observation never sees a change half applied, and a mutation waiting for the volume is not overtaken by observations that arrive after it. Admission limits the number of callers waiting to enter the volume. Excess work fails with retryable `VolumeBusy` before mutation or durable commit. Waiting for an admitted mutation, observation, or watch registration is interruptible; interruption after a committed publication does not roll it back. Cleanup finalizers remain able to enter the volume.

Runtime-only per-object revisions distinguish committed content, metadata, link-count, and namespace changes even when clock values repeat. Each committed operation advances the volume revision once and stamps it on every object it changed, so objects changed by one operation report equal revisions. Metadata observations pair copied metadata with its revision. Directory observations pair owned entry names and stable child references with the directory revision from one state. Reads, rejected changes, and explicit no-op branches do not advance revisions.

Watches stream committed create, update, and remove paths through a scoped queue for each subscriber. Registration is coordinated with mutations, so no committed event is lost between subscribing and becoming active. Watches have no replay. When a queue fills, its subscriber receives buffered changes followed by `Rescan` at `/`. It must rescan and repeat if another marker arrives. Other subscribers continue to receive events. A watch scoped to an object reference receives only the changes that name the object or lie in its subtree (its direct children when not recursive), tested against the committed tree before they count toward its queue; it follows renames of the object and its ancestors, receives `Rescan` at the object's current path, and ends after `Remove` for the object once its last name is gone; that `Remove` is never replaced by `Rescan`. The [scoped watch decision](../decisions/core/scoped-watch.md "defined by") defines the scope. The [watch overflow decision](../decisions/core/watch-event-overflow.md "defined by") defines the capacity and adapter behavior.

Events are path addressed. A committed change to a node with no reachable name, such as an unlinked file still held by a handle, publishes nothing. Aliases observe changes to the same file. Multi-call adapter helpers are compositions, not transactions.

Recursive operations are compositions too, with one exception. `walk` reads each directory in its own observation, so it sees each listing whole but no snapshot of the tree, and it writes nothing. A recursive `remove` is one change per entry and stops at the first failure, leaving what it has not reached. A recursive `mkdir` is one transition: every directory it creates publishes together, and a failure creates none. The [recursive tree operations decision](../decisions/core/recursive-tree-operations.md "defined by") defines the partial-failure rules.

These choices [implement the remaining implementation policy](../decisions/core/remaining-implementation-profile.md "implements") and [depend on the resource and authority model](resources-and-authority.md "depends on").
