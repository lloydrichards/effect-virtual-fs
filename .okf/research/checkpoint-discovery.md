---
type: Research
title: Checkpoint discovery and cleanup
description: Explores how a build workspace can find checkpoints and safely retire saved images.
status: draft
tags: [persistence, sqlite, snapshots]
sources:
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/13
    title: Discovery and cleanup design questions
  - resource: https://github.com/lloydrichards/effect-virtual-fs/pull/12
    title: Initial named checkpoint implementation and qualification
  - resource: ../contracts/checkpoint-persistence.md
    title: Create-only named checkpoint contract
  - resource: ../../packages/persistence/src/CheckpointStore.ts
    title: SQLite schema and save/load admission
  - resource: ../../packages/persistence/test/CheckpointStore.test.ts
    title: Persistence, restart, and caller transaction tests
  - resource: ../../apps/docs/app/lib/playground/storage.ts
    title: Single browser workspace checkpoint example
---

# Checkpoint discovery and cleanup

Start with an application catalog for one build workflow. Use it to test whether people find and restore the
right workspace before adding a listing or deletion capability to the shared store.

## Restore a previous workspace

Consider a build service that saves a workspace at a failed build or a deliberate resume point. An operator
opens the build's workspace history, chooses a recognizable run, and restores its checkpoint into a fresh
volume. The application already knows the workspace and run identifiers, the display label, and the caller's
access. Give each save a unique opaque checkpoint name and store the application fields beside it. Include
the capture time for display and use a database-assigned sequence for ordering. Add an encoded byte count
only when storage accounting needs it and the adapter can report it without loading the image.

The docs playground illustrates one end of this design. It saves one known browser key with a timestamp and
offers reopen and explicit removal. It uses its own IndexedDB and SQLite WASM storage path. That example
establishes the value of a known resume point but provides no evidence of a multi-checkpoint consumer or a
shared retention rule.

## Catalog ownership and pagination

The SQLite migration creates `effect_vfs_checkpoints` with a literal text primary key and an image BLOB.
The package qualifies create-only saves and bounded loads across a process restart. It participates in the
caller's SQL transaction. It stores no workspace, timestamp, owner, or retention fields. A known-key
`load(name)` validates the image. Treat catalog membership as metadata, since a row can still refer to a
missing or invalid image.

On the same database and SQL client, write the app-owned catalog row and call `save` within one transaction.
Capture the snapshot before opening the transaction. The current `save` still encodes it inside the caller's
transaction, so measure writer lock duration for large images. Keep a unique application save identifier
across retries. If interruption leaves completion uncertain, look up that identifier and the catalog mapping
before retrying. A duplicate name alone does not establish that the intended save completed.
With storage split across transactions or services, treat the mapping as potentially stale and define
reconciliation in the application.

Use indexed keyset pagination by workspace and descending sequence. Keep the initial high-water mark and
the last returned sequence in a cursor bound to workspace and filter. Bound page size and fetch one extra
row to detect continuation. Insertions above the high-water mark appear on a fresh listing. Deletions
between pages may shorten later pages. A keyset scan does not promise a stable catalog snapshot or reserve
an image for restoration. A restore rechecks authorization, resolves the selected catalog entry, and handles
a missing image through the normal refresh flow. Restrict listing to metadata fields and avoid selecting
the image BLOB.

An in-memory Bun 1.4.4 SQLite probe used synthetic image and catalog tables. Page one returned sequences
4 and 3 for workspace A. After sequence 5 was inserted and sequence 3 was removed, the next page using
the saved cursor returned sequence 1. SQLite's query plan used the composite workspace/sequence index.
A failed catalog insert rolled back an image insert in the same transaction. The probe tested the SQL
design in one process. It did not run the public checkpoint adapter or quantify contention.

## Cleanup and concurrency

Start with explicit operator cleanup in a prototype. A catalog-only hide can remove a row from discovery
without reclaiming image space. Physical removal requires a reviewed storage operation that can remove the
intended image and its catalog row together. Direct edits to the package's private table would tie the
application to its migration. Keep retention criteria such as age, per-workspace limits, pinned runs, and
storage targets with the application. Deleting images can make SQLite pages reusable. File shrinkage
depends on the application's SQLite maintenance settings.

Give each saved image a never-reused application identifier. If a cleanup action can refer to a reused name,
require an expected generation checked in the delete transaction. This prevents an old cleanup request from
removing a newer save. A shortlist or cursor is not authority to delete. Recheck access and current retention
state in the transaction. When a load wins the race, its owned snapshot remains usable after the row is
removed. When removal wins, the load can report `NotFound`. A consumer that promises delayed restore after
selection would need a separate reservation or pin policy.

Before proposing a package change, identify a concrete multi-checkpoint consumer and agree on the first
workflow, the catalog's ordering and refresh semantics, and the authority to remove a checkpoint. Qualify
restart, two writers, interrupted save, pagination across inserts and deletes, concurrent load and removal,
and exact literal-name handling including leading BOMs. If reclaiming image storage is the only gap after the
prototype, evaluate a small explicit removal capability before adding a shared catalog API.
