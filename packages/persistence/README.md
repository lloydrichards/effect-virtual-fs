# SQLite persistence

`@effect-vfs/persistence` saves named filesystem snapshots and loads them for restoration in a later process.
The application chooses when to capture, supplies its SQLite connection through a `SqlClient` Layer, and controls
startup migrations.

The package does not load a runtime-specific database driver. The examples below use
`@effect/sql-sqlite-bun@4.0.0-rc.114` as an application-supplied Layer; another compatible SQLite `SqlClient` Layer
can be supplied by the application.

Core's `LiveVolume.open` uses a `LiveImageStore` service for live image commits.
`@effect-vfs/persistence/SqliteLiveImageStore` provides a scoped SQLite Layer through Effect's `SqlClient` service.
The application supplies a dedicated SQLite client for the same absolute local database path, plus Effect
`FileSystem`, `Path`, and `Crypto` Layers. The store reserves one SQL connection, holds SQLite's exclusive file lock
until release, and commits one complete image per mutation. It requires explicit image and database size limits.
The Bun SQLite client is one possible application-supplied Layer; it is not a production dependency of this package.

The provider uses SQLite's DELETE journal and `synchronous=EXTRA`, with `fullfsync=ON` on macOS. It checks these
settings on its commit connection, verifies image integrity, and distinguishes a confirmed rollback from an
uncertain commit result. A confirmed rejection leaves the live volume unchanged; an uncertain outcome makes it
unavailable until the application closes and reopens it. Reopening preserves the logical volume identity and
creates a new runtime incarnation. A second `LiveVolume.open` on the same provider Layer fails `Ownership`.

This provider has process-restart coverage. Tests kill the writer after an acknowledged commit and after an
unacknowledged image update but before `COMMIT`, then reopen the database. Injected lost commit and rollback
acknowledgements also verify that the live volume stops serving operations until reopen. It has not been qualified
against operating-system crashes or power loss on a specific filesystem and device. `Volume.durability` therefore
remains `memory-only`. This provider must not yet be used to promise NFS `FILE_SYNC4`. The database page limit does
not cap temporary rollback-journal space, so the application must reserve disk space for a complete-image
transaction. Database creation also happens inside the supplied SQL Layer, before this provider can inspect the
path; the provider does not establish that the containing directory was synchronized after creation. The current
core watch queue is also unbounded. Use this provider for bounded local experiments until
those limits and crash tests are completed. Crash and power-loss qualification is tracked in
[#129](https://github.com/lloydrichards/effect-virtual-fs/issues/129); bounded admission and watch delivery are
tracked in [#122](https://github.com/lloydrichards/effect-virtual-fs/issues/122).

## Save and restore

```ts
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { CheckpointStore } from "@effect-vfs/persistence"
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import { Effect, Layer } from "effect"
import * as ByteSize from "effect/ByteSize"

const limits = {
  maxEncodedBytes: ByteSize.megabytes(10),
  maxRecords: 10_000,
  maxEntries: 20_000,
  maxDecodedBytes: ByteSize.megabytes(5)
}

const Database = SqliteClient.layer({ filename: "checkpoints.sqlite" })
const Checkpoints = CheckpointStore.layer(limits).pipe(
  Layer.provide(Layer.effectDiscard(CheckpointStore.migrate)),
  Layer.provide(Database)
)

const save = Effect.gen(function*() {
  const store = yield* CheckpointStore
  const volume = yield* Vfs.fromFixture({
    entries: [{ kind: "file", path: "/hello.txt", bytes: new TextEncoder().encode("hello") }]
  })
  yield* store.save("run-42", yield* volume.snapshot)
})

// Run once. Reusing the same name fails with AlreadyExists.
await Effect.runPromise(save.pipe(Effect.provide(Checkpoints)))

// This can run in another process with the same database and layer setup.
const restore = Effect.gen(function*() {
  const store = yield* CheckpointStore
  const snapshot = yield* store.load("run-42")
  const volume = yield* Vfs.fromSnapshot(snapshot, { maxBytes: ByteSize.megabytes(5) })
  return yield* (yield* volume.caller()).readFile("/hello.txt")
})

const bytes = await Effect.runPromise(restore.pipe(Effect.provide(Checkpoints)))
```

`CheckpointStore.make(limits)` also constructs a store directly when `SqlClient` is already provided.
Neither `make` nor `layer` runs migrations. The example's explicit migration layer runs before store construction.
Applications with an existing startup sequence can instead yield `CheckpointStore.migrate` there.

## Contract

- `save(name, snapshot)` creates one immutable named checkpoint. It does not replace an existing name.
- `load(name)` returns a validated core `Snapshot`. Restoring it creates a fresh independent volume.
- Names contain 1–255 UTF-8 bytes. NUL and lone UTF-16 surrogates are rejected. Leading BOM characters are preserved.
  Names are literal, case-sensitive keys with no path handling or Unicode normalization.
- Construction validates and copies `DecodeLimits` when its Effect executes. Save validates the encoded snapshot
  against those same limits before inserting. This adds a validation pass but guarantees that the store can load
  what it saves under its configured limits.
- SQLite stores the existing JSON/base64 image as a BLOB. Load checks BLOB size inside its query before returning
  the payload, then runs core's complete snapshot decoder. Limits bound logical input, not exact heap use.
- While snapshot version 1 is being solidified, checkpoints written by an earlier schema revision may fail core
  validation. Regenerate those checkpoints; the persistence package does not migrate snapshot bytes.
- Capturing remains the caller's responsibility. Subsequent volume edits require another snapshot and a new name.

`CheckpointError` has `code`, `operation`, and optional `name` and `cause` fields:

| Code            | Meaning                                                            |
| --------------- | ------------------------------------------------------------------ |
| `InvalidName`   | The key violates the name contract.                                |
| `NotFound`      | No checkpoint exists under this name.                              |
| `AlreadyExists` | A valid save attempted to reuse a name. The original is preserved. |
| `Storage`       | SQLite or migration failed; `cause` preserves diagnostic details.  |

Core `ImageError` is preserved for invalid configuration limits, unsupported or corrupt images, and exceeded
image budgets. Save validates the name and image before attempting insertion, so invalid input can fail before
duplicate-name detection. Restore applies its own destination volume limits independently.

## Database ownership and commit behavior

The application provides a SQLite `SqlClient` whose scope must outlive the store. The module owns
`effect_vfs_checkpoints` and `effect_vfs_checkpoint_migrations`. Its numbered migrations use a separate ledger from
the application's migrations. Run startup migration before accepting checkpoint requests; coordinate startup
migrations when multiple processes open the same database.

An insert is atomic and enforces uniqueness in SQLite. Competing saves cannot overwrite the winning checkpoint.
The store participates in an enclosing Effect SQL transaction if one exists; in that case, successful `save`
does not commit the outer transaction. Without an outer transaction, a successful save has completed its insert.
Interruption can arrive after commit but before acknowledgment. Retrying that name can return `AlreadyExists`.

The Bun driver uses synchronous SQLite calls, so database contention can block the event loop. Applications own
busy timeout, journaling, synchronization settings, and backups. The restart test verifies restoration after the
writer process exits; it does not establish power-loss durability for arbitrary SQLite configurations.

This version provides no history, replacement, listing, deletion, revision checks, automatic saving, compression,
or incremental snapshot storage. Snapshot diffs are a separate core feature.

## Development

From the repository root:

```sh
bun run test --filter=@effect-vfs/persistence
```

The package test task builds its exports, runs real SQLite tests under Bun, and launches separate save and restore
processes against a temporary database. NodeNext declaration checks cover the public package exports; they are not
a Node SQLite runtime test.
