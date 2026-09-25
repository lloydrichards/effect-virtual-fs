---
type: Decision
title: Persistence store helpers
description: Names every persistence failure by its entry point, shares one internal failure and digest module between the live stores, and holds each store's ownership claim in one Ref.
status: stable
tags: [persistence, errors, sqlite, r2]
sources:
  - id: checkpoint-store
    resource: ../../packages/persistence/src/CheckpointStore.ts
    title: Checkpoint failures named by entry point
  - id: store-support
    resource: ../../packages/persistence/src/internal/storeSupport.ts
    title: Shared failure constructors and SHA-256 digest
  - id: sqlite-store
    resource: ../../packages/persistence/src/SqliteLiveImageStore.ts
    title: SQLite live store ownership Ref
  - id: r2-store
    resource: ../../packages/persistence/src/R2LiveImageStore.ts
    title: R2 live store ownership Ref
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/182
    title: Persistence store helpers
generated: { by: claude-code, at: "2026-09-26T10:30:00+02:00" }
---

# Persistence store helpers

Follows the [public API decision](core/public-api-targets-services-and-errors.md "follows"), which made `VfsError` the single error family. The decisions were grilled on 2026-09-25 and recorded on [issue #182](https://github.com/lloydrichards/effect-virtual-fs/issues/182 "decided on").

## Context

`CheckpointStore` built its `VfsError`s by hand with `operation` values that disagreed within one call: a missing checkpoint reported `load`, a rejected limit `CheckpointStore.make`, and a corrupt image core's `decodeSnapshot`. The R2 and SQLite live stores each copied the same failure constructors and digest, and each kept its ownership claim in `let` variables. The persistence tests still provided `Crypto` layers that `LiveVolume.open` no longer needs.

## Decisions

1. **Validate-once moves to #185.** `CheckpointStore.save` still encodes and then decodes until the limits API is reshaped there.
2. **One naming scheme for `operation`: `Module.entry`.** `CheckpointError` reports `CheckpointStore.save`, `CheckpointStore.load` or `CheckpointStore.migrate`. The store's `VfsError`s, including snapshot encode and decode failures, report `CheckpointStore.make`, `CheckpointStore.save` or `CheckpointStore.load`. The live stores report `SqliteLiveImageStore.layer` and `.loadOrCreate`, and `R2LiveImageStore.layer`, `.loadOrCreate` and `.fromS3`. A commit reports an outcome, not a failure, so it has no operation.
3. **One internal store-support module** holds the failure constructors, built per entry point, and the SHA-256 digest both live stores use.
4. **Ownership lives in one `Ref` per store.** A successful commit advances the generation and keeps the availability flag as it finds it, so a commit that lands after another commit froze the store cannot unfreeze it.
5. **Tests share their setup.** The dead `Crypto` layers are gone, each checkpoint suite shares one migrated database and takes a fresh one where a test alters the table, and both restart suites drive their workers through `ChildProcessSpawner`, checking the worker's exit code as well as its output.

## Consequences

The service shapes, commit outcomes and shutdown order are unchanged. Sharing the checkpoint database exposed that the Bun SQLite driver drops a leading U+FEFF from bound names, tracked in #218.
