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
generated: { by: codex/okf, at: 2026-09-13T09:24:00+02:00 }
---

# Mutation and observation

One volume coordinates mutations, observations, snapshot capture, and resource release. Expected failures occur before publication. Waiting is interruptible; interruption after a committed publication does not roll it back.

Runtime-only per-object revisions distinguish committed content, metadata, link-count, and namespace changes even when clock values repeat. Metadata observations pair copied metadata with its revision. Directory observations pair owned entry names and stable child references with the directory revision from one state. Reads, rejected changes, and explicit no-op branches do not advance revisions.

Watches stream committed create, update, and remove paths through a scoped unbounded buffer. They have no replay and do not silently drop committed events. Aliases observe changes to the same underlying file. Multi-call adapter helpers are compositions, not transactions.

These choices [implement the remaining implementation policy](/decisions/remaining-implementation-profile.md "implements") and [depend on the resource and authority model](/contracts/resources-and-authority.md "depends on").
