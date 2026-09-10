---
type: Contract
title: Checkpoint persistence
description: Defines explicit create-only named SQLite checkpoints over validated core snapshot images.
status: stable
tags: [persistence, sqlite, snapshots]
sources:
  - resource: ../../packages/persistence/src/CheckpointStore.ts
    title: Checkpoint store implementation
  - resource: ../../packages/persistence/test/CheckpointStore.test.ts
    title: Checkpoint behavior tests
  - resource: ../../packages/persistence/test/Restart.test.ts
    title: Separate-process restart test
generated: { by: codex/okf, at: 2026-09-10T00:00:00Z }
---

# Checkpoint persistence

`@effect-vfs/persistence` stores explicitly captured core snapshots as create-only names in an application-provided SQLite database. Saving an existing name fails without replacing it, and competing saves allow exactly one winner.

Applications own database provisioning, migration timing, snapshot capture, restoration into a fresh volume, and driver lifetime. The store validates the same required decode budgets on save and load, rejects invalid names and malformed stored images, distinguishes missing data from storage failure, and participates in an enclosing SQL transaction.

This contract [depends on](/contracts/snapshots-and-fixtures.md "depends on") the snapshot image boundary and is established by [named checkpoint persistence](/decisions/named-checkpoint-persistence.md "constrained by").
