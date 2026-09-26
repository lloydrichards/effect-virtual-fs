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
generated: { by: claude/okf, at: "2026-09-26T14:30:00+02:00" }
---

# Checkpoint persistence

`@effect-vfs/persistence` stores explicitly captured core snapshots as create-only names in an application-provided SQLite database. Saving an existing name fails without replacing it, and competing saves allow exactly one winner.

Applications own database provisioning, migration timing, snapshot capture, restoration into a fresh volume, and driver lifetime. The store applies the same required decode budgets on save and load, and never rewrites stored bytes. Saving encodes under those budgets, whose meter fails wherever loading would, so it decodes nothing it just encoded. The store rejects invalid names and malformed stored images, distinguishes missing data from storage failure, and participates in an enclosing SQL transaction.

This contract [depends on](snapshots-and-fixtures.md "depends on") the snapshot image boundary and is established by [named checkpoint persistence](../decisions/named-checkpoint-persistence.md "constrained by").
