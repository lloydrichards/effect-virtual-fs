# @effect-vfs/persistence

`@effect-vfs/persistence` offers two SQLite-backed ways to retain a virtual filesystem. Use
[`CheckpointStore`](#save-and-restore) to save a named snapshot and restore a separate volume later. Use
`SqliteLiveImageStore` with `LiveVolume.open` to commit a complete image on each mutation. The live store is for
bounded local experiments, not a claim of power-loss durability.

## Install

```sh
npm install @effect-vfs/core@latest @effect-vfs/persistence@latest
```

For the Bun SQLite example, install the Effect providers at the package's exact peer version:

```sh
npm install "@effect/sql-sqlite-bun@$(npm view @effect-vfs/persistence peerDependencies.effect)" "@effect/platform-bun@$(npm view @effect-vfs/persistence peerDependencies.effect)"
```

The application supplies SQLite and Crypto services and runs checkpoint migrations at startup.

## Save and restore

```ts
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { CheckpointStore } from "@effect-vfs/persistence"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
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
await Effect.runPromise(save.pipe(Effect.provide(Checkpoints), Effect.provide(BunCrypto.layer)))

// This can run in another process with the same database and layer setup.
const restore = Effect.gen(function*() {
  const store = yield* CheckpointStore
  const snapshot = yield* store.load("run-42")
  const volume = yield* Vfs.fromSnapshot(snapshot, { maxBytes: ByteSize.megabytes(5) })
  return yield* (yield* volume.caller()).readFile("/hello.txt")
})

const bytes = await Effect.runPromise(restore.pipe(Effect.provide(Checkpoints), Effect.provide(BunCrypto.layer)))
console.log(new TextDecoder().decode(bytes)) // hello
```

`CheckpointStore.make(limits)` also constructs a store directly when `SqlClient` is already provided.
Neither `make` nor `layer` runs migrations. The example's explicit migration layer runs before store construction.
Applications with an existing startup sequence can instead yield `CheckpointStore.migrate` there.

## Live image commits

`SqliteLiveImageStore` and `R2LiveImageStore` implement core's `LiveImageStore` service. `LiveVolume.open` commits a
complete image on each mutation. A confirmed storage rejection leaves the volume unchanged. An uncertain commit
outcome makes the volume unavailable until reopen.

- [SQLite live volume guide](../../apps/docs/app/content/guides/sqlite-live-volume.mdx) covers local setup, size limits, and recovery.
- [R2 adapter reference](../../apps/docs/app/content/api/persistence/r2-live-image-store.mdx) covers conditional writes and configuration.
- [R2 NFS demo](../../apps/demo-r2-nfs/README.md) shows a single gateway with mounted clients.

SQLite live storage reports `memory-only` durability. Restart and fault tests do not qualify it for physical power
loss. [Power-loss testing](POWER_LOSS_TESTING.md) describes the qualification work.

R2 has no ownership lease. Applications must enforce one gateway per image. Set `durability: "survives-power-loss"`
only when relying on Cloudflare R2's documented durable-write contract and verifying the actual R2 endpoint.

## Checkpoint contract

Names are literal, case-sensitive keys of 1–255 UTF-8 bytes. NUL and lone surrogates are rejected. Saving an existing
name fails with `AlreadyExists`. Loading a missing name fails with `NotFound`. Save and load use the configured
snapshot limits. Capturing a new snapshot and choosing a new name remain the application's responsibility.

The application owns the database lifetime and SQLite settings. Save participates in an enclosing SQL transaction;
a successful save does not commit that outer transaction. Checkpoints do not provide automatic saving, listing,
deletion, history, or incremental storage. The store does not migrate snapshot bytes from older schema revisions.

See the [checkpoint guide](../../apps/docs/app/content/guides/sqlite-checkpoints.mdx) for database ownership and
[API reference](../../apps/docs/app/content/api/persistence/checkpoint-store.mdx) for errors and limits.

## Development

From the repository root, run:

```sh
bun run test --project persistence
```

The suite exercises real Bun SQLite databases and restoration in a separate process. Real R2 checks require a private
test bucket and `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`. Run `test:r2`,
`test:r2:fault`, or `test:r2:volume` from this package. These checks use unique `effect-vfs-smoke/` keys and remove
their test objects afterward.
