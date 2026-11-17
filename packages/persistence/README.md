# @effect-vfs/persistence

`@effect-vfs/persistence` offers checkpoint and live-image storage. Use
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

`SqliteLiveImageStore`, `PgLiveImageStore`, `D1LiveImageStore` and `R2LiveImageStore` implement core's `LiveImageStore` service. `LiveVolume.open` commits a
complete image on each mutation. A confirmed storage rejection leaves the volume unchanged. An uncertain commit
outcome makes the volume unavailable until reopen.

- [SQLite live volume guide](../../apps/docs/app/content/guides/sqlite-live-volume.mdx) covers local setup, size limits, and recovery.
- [R2 adapter reference](../../apps/docs/app/content/api/persistence/r2-live-image-store.mdx) covers conditional writes and configuration.
- [R2 NFS demo](../../apps/demo-r2-nfs/README.md) shows a single gateway with mounted clients.

SQLite live storage reports `memory-only` durability. Restart and fault tests do not qualify it for physical power
loss. [Power-loss testing](POWER_LOSS_TESTING.md) describes the qualification work.

R2 has no ownership lease. Applications must enforce one gateway per image. Set `durability: "survives-power-loss"`
only when relying on Cloudflare R2's documented durable-write contract and verifying the actual R2 endpoint.

Every live-image layer requires a supplied client. Provide each client directly to its store with `Layer.provide`
before composing application layers. PostgreSQL and D1 client layers also provide generic `SqlClient`; merging
all drivers at one level can give SQLite the wrong client. One store-layer instance represents one owner.
Create separate store-layer instances and scopes for independent owners.

Import the transport-independent `R2Store` when you supply a custom R2 client. Its runtime
and declarations do not load the AWS SDK. For an AWS SDK client, import `fromS3` from
`R2S3Transport` and provide the adapted client to the store:

```ts
import { S3Client } from "@aws-sdk/client-s3"
import { fromS3 } from "@effect-vfs/persistence/R2S3Transport"
import * as R2Store from "@effect-vfs/persistence/R2Store"
import { ByteSize, Layer } from "effect"

const s3 = new S3Client({
  region: "auto",
  endpoint: "https://ACCOUNT_ID.r2.cloudflarestorage.com",
  credentials: { accessKeyId: "ACCESS_KEY_ID", secretAccessKey: "SECRET_ACCESS_KEY" }
})
const R2ClientLayer = Layer.succeed(
  R2Store.Client,
  fromS3(s3, "workspace-images")
)
const Store = R2Store.layer({
  key: "workspace-123",
  maxImageBytes: ByteSize.mebibytes(4)
}).pipe(Layer.provide(R2ClientLayer))
```

The original `R2LiveImageStore` subpath continues to export the same store and S3 adapter.
The package still installs the AWS SDK as a dependency.

The AWS SDK creates `s3`. The store passes `maxImageBytes` to the bounded reader supplied by `fromS3`.
It rejects an oversized response before reading when the reported length exceeds the limit. Otherwise, it counts chunks
and releases the body when a chunk crosses the limit. An oversized stored image fails with `CorruptStore`.
The SDK and its HTTP handler may buffer bytes before exposing a chunk. Legacy custom clients are checked after `read`
returns. Implement `readBounded` to enforce a transport limit. Direct calls to `fromS3(...).read` still materialize the body.

Keep the store Layer open for the full owner lifetime. For example, provide it around the program that uses the volume,
or build it with `Layer.build` in the enclosing owner scope. Close the complete owner before opening a replacement for the
same key. Closing waits for outstanding requests, even if their callers stopped waiting. The store borrows the SDK client,
so a separate owner for another key can continue using it.

If the SDK reports a write failure with an uncertain outcome, keep the key offline. Use transport or provider evidence to
establish that the request can no longer change the object, then verify the authoritative image before reopening. A
successful GET alone can still precede a late remote write. The adapter freezes the uncertain owner and provides no
automatic retry or takeover.
The application owns the SDK client and closes it after all stores using it have closed. Closing a store does not
destroy that client. SQLite continues to require a dedicated `SqlClient` for its verified filename, plus
`FileSystem`, `Path` and `Digest`.

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

## PostgreSQL live images

Install `@effect/sql-pg@~4.1.4` alongside persistence. SQLite and R2 users do not need this optional peer.
Run the versioned migration once through your application's migration system, before opening any stores:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f node_modules/@effect-vfs/persistence/migrations/postgresql/001_live_images.sql
```

The fixed table is `public.effect_vfs_live_images`. Missing or incompatible schema fails startup. Opening a
store never creates or repairs tables. The adapter owns the table's columns, primary key and version marker.
Do not add application triggers, rules, row-level security or other constraints to this table. Apply migrations
with a provisioning role and grant the runtime role SELECT, INSERT and UPDATE access. Coordinate DDL while
owners are stopped.

```ts
import { LiveVolume } from "@effect-vfs/core"
import * as PgLiveImageStore from "@effect-vfs/persistence/PgLiveImageStore"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as PgClient from "@effect/sql-pg/PgClient"
import { ByteSize, Effect, Layer, Redacted } from "effect"

const maxImageBytes = ByteSize.mebibytes(4)
const Client = PgClient.layerFrom(PgClient.makeClient({
  url: Redacted.make("postgresql://user:password@localhost/app"),
  ssl: true,
  connectTimeout: "5 seconds",
  multiplex: false,
  maxMessageSize: Math.max(16 * 1024 * 1024, Number(ByteSize.toBigInt(maxImageBytes)) + 90)
}))
const Store = PgLiveImageStore.layer({ key: "workspace-123", maxImageBytes }).pipe(Layer.provide(Client))

const program = Effect.scoped(Effect.gen(function*() {
  const volume = yield* LiveVolume.open({
    maxImageBytes: ByteSize.mebibytes(4),
    volume: {
      maxEntries: 1000,
      maxBytes: ByteSize.mebibytes(2),
      maxFileBytes: ByteSize.mebibytes(1),
      maxPathBytes: ByteSize.bytes(1024)
    }
  })
  return yield* (yield* volume.caller()).stat("/")
})).pipe(Effect.provide(Store), Effect.provide(NodeCrypto.layer))
```

Supply a fresh, dedicated single-connection client for each open store using `PgClient.layerFrom(PgClient.makeClient(...))`.
Do not share that client with another store, application queries, transactions, listeners or streams. Reusing the
same client-layer instance shares its connection; a second store can wait for the first store to close. Pools are
outside this adapter's supported setup. The application is responsible for this dedication; the native client type
cannot prove exclusive use.

The store reserves one connection until its own scope closes and executes directly through it. A filesystem commit
is one autocommit statement, independent of a separate application's transaction. Success waits for the driver's
ReadyForQuery completion. The supplied client must use default PostgreSQL type decoding, no acquisition hooks,
and a receive budget of at least `max(16 MiB, maxImageBytes + 90 bytes)`. The store checks its advertised receive
budget and rejects `onAcquire` hooks before reserving. Do not mutate client configuration after construction.

The key contains 1 to 256 UTF-16 code units of well-formed Unicode without NUL. Key comparisons must use
deterministic collations. The image limit must be positive and below 1 GiB. Invalid store options perform no
reservation or store SQL, but the supplied client layer may already have connected. Client startup failures remain
native SQL errors from that layer; failures inside the store use its existing VFS errors.
Existing oversized images are rejected without transferring their image bytes. Digests and safe generations are
validated by the shared protocol.

Enforce one application-controlled owner for each database and volume key. Close both the old store
and its dedicated client scopes before starting a fresh client and store. Closing only the store releases its
reservation but leaves a separately scoped client alive. Generation checks reject stale writes but cannot retire another process's
cached reads. There is no lease or automatic takeover. Query failures, lost replies, malformed receipts and
interruption after a write attempt freeze the owner. Reopen through a fresh client and owner after closing the complete old composition.

This v1 reports `memory-only`. It persists and reopens images but exposes no stronger-durability assertion and
does not qualify writable NFS.

For integration tests, use a disposable PostgreSQL database with the migration already applied. The tests temporarily
alter the fixed table to verify schema rejection. Set `VFS_PG_TEST_URL` and run `bun run test:pg` from this package.
The explicit command fails when the URL is absent. Ordinary tests skip PostgreSQL when it is absent. CI runs
PostgreSQL 18.3 with Bun 1.4.4 in its own job. `VFS_PG_PROXY_PORT` optionally supplies the first proxy port on
hosts whose ephemeral listener range is exhausted.

## D1 live images

Install the optional `@effect/sql-d1@~4.1.4` peer for the D1 subpath. Other adapters do not require it.
Apply `migrations/d1/001_live_images.sql` from the published package through your explicit D1 migration system
before opening a store. The adapter validates the fixed `effect_vfs_live_images` and
`effect_vfs_live_images_schema` tables. Opening never creates, repairs or silently upgrades them.
Keep their published v1 table declarations, binary key collation and version row unchanged. Startup permits
whitespace, keyword case and ordinary double-quoted identifier spelling differences. Extra constraints, foreign
keys and other schema clauses are rejected, as are triggers and indexes. Coordinate schema changes while owners
are stopped.

```ts
import * as D1LiveImageStore from "@effect-vfs/persistence/D1LiveImageStore"
import * as D1Client from "@effect/sql-d1/D1Client"
import { ByteSize, Layer } from "effect"

const makeStore = (db: D1Client.D1ClientConfig["db"]) =>
  D1LiveImageStore.layer({ key: "workspace-123", maxImageBytes: ByteSize.kibibytes(512) }).pipe(
    Layer.provide(D1Client.layer({ db }))
  )
```

Supply the native `D1Client` layer using a plain `env.DB` binding, plus the application's `Digest` service.
Different store keys may share this client while each store retains its own pending-query scope. The adapter uses
one conditional statement per mutation, without BEGIN or generic transactions. D1 Sessions
are excluded. Cloudflare documents that the [plain binding executes on the primary](https://developers.cloudflare.com/d1/best-practices/read-replication/).

Keys contain 1 to 256 UTF-16 code units without NUL or unpaired surrogates. Well-formed Unicode, including paired
surrogates, remains supported. Invalid UTF-16 is rejected before querying D1 so different keys cannot collapse
to the same UTF-8 identity. The configurable image limit must be positive and at most 1 MiB. This leaves metadata headroom under D1's [2,000,000-byte complete-row limit](https://developers.cloudflare.com/d1/platform/limits/).
Oversized stored images are withheld by the SQL projection. BLOB byte arrays are validated before conversion.
The 1 MiB cap is an admission limit. Worker CPU, memory and request-query budgets still need workload qualification.

Enforce one application-controlled owner for each database and key. Independent Worker instances must not open
cached volumes for the same key. A Durable Object can be part of an ownership design, but this adapter does not
provide its routing, eviction or takeover lifecycle. A per-process registry does not coordinate different isolates.
The release guarantee is `memory-only`, with no stronger-durability override or writable NFS qualification.

Uncertain queries and interruption after a write attempt freeze the owner. D1 Promise cancellation does not prove
that the database stopped executing. Caller interruption remains responsive, while the owner scope retains pending
statements. Close the entire old volume owner's scope and wait for it to finish before reopening. Scope closure
waits for pending statements to settle and can therefore wait for a slow or unresponsive binding. The borrowed D1
binding is never destroyed. The adapter does not retry uncertain writes.

Run `bun run test:d1` from this package for the pinned Miniflare/workerd contracts and bundled Worker smoke.
The launcher uses Node for workerd integration. Ordinary Bun tests skip this suite, and a dedicated CI job runs it.
Local cases cover interruption, late completion, lost replies, corruption, primary-serving metadata and fresh-owner
recovery. Local emulation does not establish hosted Cloudflare behavior or power-loss durability.

### Qualify against hosted D1

Hosted qualification is still required before releasing this adapter. From this package directory:

1. Authenticate Wrangler and create a disposable D1 database with `bunx wrangler d1 create effect-vfs-d1-qualification`.
2. Set both database IDs in `test/fixtures/d1.wrangler.jsonc` to that disposable database's ID.
3. Run `bunx wrangler d1 migrations apply DB --remote --config test/fixtures/d1.wrangler.jsonc`.
4. Run `bun run test:d1:remote`, then request the local URL printed by Wrangler.
5. Require HTTP 200 and a JSON report with `status: "passed"` and `primary: true`. Stop Wrangler and delete the disposable database afterward.

The qualification Worker uses a fresh key for every request, checks conditional writes and empty/binary/1 MiB
images across fresh owners, and deletes its image row afterward. It is a test harness, not an application ownership
example. Repeat cancellation and lost-reply qualification in the intended deployment before treating a workload as
supported. Do not use the qualification configuration with a production database.
