# @effect-vfs/persistence

`@effect-vfs/persistence` offers two SQLite-backed ways to retain a virtual filesystem. Use
[`CheckpointStore`](#save-and-restore) to save a named snapshot and restore a separate volume later. Use
`SqliteLiveImageStore` with `LiveVolume.open` to commit a complete image on each mutation. The live store is for
bounded local experiments, not a claim of power-loss durability.

## Install

```sh
npm install @effect-vfs/core @effect-vfs/persistence @effect/sql-sqlite-bun@4.0.0-rc.114 @effect/platform-node-shared@4.0.0-rc.114 effect@4.0.0-rc.114
```

The application supplies the SQLite `SqlClient` Layer and runs checkpoint migrations at startup. Start with the
[save-and-restore example](#save-and-restore). For live commits, read the [durability and storage limits](#live-image-commits)
before choosing a database path and size limits.

## Save and restore

```ts
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { CheckpointStore } from "@effect-vfs/persistence"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
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
await Effect.runPromise(save.pipe(Effect.provide(Checkpoints), Effect.provide(NodeCrypto.layer)))

// This can run in another process with the same database and layer setup.
const restore = Effect.gen(function*() {
  const store = yield* CheckpointStore
  const snapshot = yield* store.load("run-42")
  const volume = yield* Vfs.fromSnapshot(snapshot, { maxBytes: ByteSize.megabytes(5) })
  return yield* (yield* volume.caller()).readFile("/hello.txt")
})

const bytes = await Effect.runPromise(restore.pipe(Effect.provide(Checkpoints), Effect.provide(NodeCrypto.layer)))
console.log(new TextDecoder().decode(bytes)) // hello
```

`CheckpointStore.make(limits)` also constructs a store directly when `SqlClient` is already provided.
Neither `make` nor `layer` runs migrations. The example's explicit migration layer runs before store construction.
Applications with an existing startup sequence can instead yield `CheckpointStore.migrate` there.

## Live image commits

### Experimental R2 store

`@effect-vfs/persistence/R2LiveImageStore` provides an experimental `LiveImageStore` for a single, externally owned
volume. Pass an AWS SDK `S3Client` configured for the R2 S3 endpoint to `R2LiveImageStore.fromS3`, then pass that
client, an object key, and `maxImageBytes` to `R2LiveImageStore.layer`. The application supplies Effect `Crypto`.
Each commit replaces the complete image with an ETag condition and stores a generation and SHA-256 digest. If a
write outcome is uncertain, the store stops accepting commits until the volume is reopened.

The adapter has no cross-server ownership lease. It reports `memory-only` by default. An application that uses
Cloudflare R2's documented synchronous durable-write contract, verifies its actual R2 endpoint, and enforces one
gateway per image may explicitly pass `durability: "survives-power-loss"`. This assertion allows the public NFS
server's guarded `writable: true` option. It must not be used with an arbitrary `R2Client` or S3-compatible store.
Real-bucket tests cover conditional writes, reopening, lost HTTP responses, competing owners, and a concurrent
write race. The [mounted NFS test app](../../apps/nfs-r2-writable-test/README.md) records independent clients,
restart recovery, and a file `WRITE` whose successful R2 HTTP response was lost. These tests do not establish
sustained NFS throughput or a distributed lease.

To run the real-bucket smoke test, use a dedicated private R2 bucket and a bucket-scoped R2 API token with object
read and write access. Set `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` in the shell,
then run `bun run --filter @effect-vfs/persistence test:r2`. The test creates a random key under
`effect-vfs-smoke/`, checks conditional writes and reopening, and deletes that key in a `finally` block. It does not
delete the bucket. Do not commit credentials or paste them into an issue or chat. A failed cleanup may leave the
single test object; the command prints its key so it can be removed by the `effect-vfs-smoke/` prefix.
Run `bun run --filter @effect-vfs/persistence test:r2:fault` for the real-bucket lost-reply, writer-race, and
short sequential-write checks. These also use unique keys under `effect-vfs-smoke/` and remove them afterward.
Run `bun run --filter @effect-vfs/persistence test:r2:volume` to write, update, and read a `LiveVolume` file across
three fresh Bun processes. This checks image persistence through the public volume API. It does not exercise NFS.

### SQLite store

`SqliteLiveImageStore.layer` supplies the `LiveImageStore` service used by `LiveVolume.open`. The application
provides a dedicated SQLite client for an absolute local database path, plus Effect `FileSystem`, `Path`, and
`Crypto` services. The store holds an exclusive SQLite lock and commits a complete image per mutation. A confirmed
storage rejection leaves the volume unchanged. An uncertain commit outcome makes the volume unavailable until reopen.

The provider uses SQLite DELETE journaling and `synchronous=EXTRA`; it enables `fullfsync=ON` on macOS. Configure
both an image limit and a database limit. The database limit does not bound the adjacent rollback journal. Reserve
space for both before use. The provider cannot check free space through Effect's `FileSystem` service, and a disk-full
commit can still have an uncertain outcome.

Process-restart, fault-injection, and bounded VM tests cover specific configurations. The provider has not been
qualified for physical power loss or arbitrary storage stacks, so `Volume.durability` remains `memory-only`.
Do not use it to promise NFS `FILE_SYNC4`. See the [live volume guide](../../apps/docs/app/content/guides/sqlite-live-volume.mdx)
for setup and recovery, [power-loss testing](POWER_LOSS_TESTING.md) for qualification work, and the
[SQLite crash recovery workflow](../../.github/workflows/sqlite-crash-gate.yml) for the opt-in gate.

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
