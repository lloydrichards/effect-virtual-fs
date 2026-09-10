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
generated: { by: codex/okf, at: 2026-09-10T00:00:00Z }
---

# Mutation and observation

One volume coordinates mutations, observations, snapshot capture, and resource release. Expected failures occur before publication. Waiting is interruptible; interruption after a committed publication does not roll it back.

Watches stream committed create, update, and remove paths through a scoped unbounded buffer. They have no replay and do not silently drop committed events. Aliases observe changes to the same underlying file. Multi-call adapter helpers are compositions, not transactions.

These choices [implement the remaining implementation policy](/decisions/remaining-implementation-profile.md "implements") and [depend on the resource and authority model](/contracts/resources-and-authority.md "depends on").
