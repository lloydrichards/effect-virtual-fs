import { type LiveVolume, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { type CheckpointError, CheckpointStore } from "@effect-vfs/persistence"
import * as D1LiveImageStore from "@effect-vfs/persistence/D1LiveImageStore"
import * as PgLiveImageStore from "@effect-vfs/persistence/PgLiveImageStore"
import * as R2LiveImageStore from "@effect-vfs/persistence/R2LiveImageStore"
import * as SqliteLiveImageStore from "@effect-vfs/persistence/SqliteLiveImageStore"
import * as D1Client from "@effect/sql-d1/D1Client"
import * as PgClient from "@effect/sql-pg/PgClient"
import { ByteSize, Effect, type FileSystem, Layer, type Path, type PlatformError, Redacted } from "effect"
import type * as Digest from "effect/crypto/Digest"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import type { SqlClient } from "effect/sql/SqlClient"
import type { Equals } from "effect/Types"

const limits = {
  maxEncodedBytes: ByteSize.kilobytes(100),
  maxRecords: 100,
  maxEntries: 100,
  maxDecodedBytes: ByteSize.kilobytes(10)
}

export const live: Layer.Layer<CheckpointStore, Vfs.VfsError, SqlClient> = CheckpointStore.layer(limits)

export const program: Effect.Effect<
  Vfs.Volume,
  CheckpointError | Vfs.VfsError | PlatformError.PlatformError,
  CheckpointStore | Digest.Digest | SecureRandom.SecureRandom
> = Effect.gen(function*() {
  const store = yield* CheckpointStore

  return yield* Vfs.fromSnapshot(yield* store.load("run"))
})

type Assert<A extends true> = A

export const postgres = PgLiveImageStore.layer({ key: "workspace-1", maxImageBytes: ByteSize.mebibytes(4) })

export type PostgresRequirements = Assert<Equals<Layer.Services<typeof postgres>, PgClient.PgClient | Digest.Digest>>

export type PostgresOutput = Assert<Equals<Layer.Success<typeof postgres>, LiveVolume.LiveImageStore>>

export const postgresProvided = postgres.pipe(Layer.provide(PgClient.layerFrom(PgClient.makeClient({
  url: Redacted.make("postgresql://localhost/app"),
  ssl: true,
  multiplex: false,
  maxMessageSize: 16 * 1024 * 1024
}))))

export type ProvidedPostgresRequirements = Assert<Equals<Layer.Services<typeof postgresProvided>, Digest.Digest>>

PgLiveImageStore.layer({
  key: "workspace-1",
  maxImageBytes: ByteSize.mebibytes(4),
  // @ts-expect-error PostgreSQL v1 has no stronger durability assertion.
  durability: "survives-power-loss"
})

export const d1 = D1LiveImageStore.layer({ key: "workspace-1", maxImageBytes: ByteSize.kibibytes(512) })

export type D1Requirements = Assert<Equals<Layer.Services<typeof d1>, D1Client.D1Client | Digest.Digest>>

export const d1Provided = (db: D1Client.D1ClientConfig["db"]) => d1.pipe(Layer.provide(D1Client.layer({ db })))

export const rejectD1Session = (db: D1Client.D1ClientConfig["db"]) =>
  D1Client.layer({
    // @ts-expect-error Sessions can route reads to replicas and are not accepted in v1.
    db: db.withSession()
  })

D1LiveImageStore.layer({
  key: "workspace-1",
  maxImageBytes: ByteSize.kibibytes(512),
  // @ts-expect-error D1 v1 has no stronger durability assertion.
  durability: "survives-power-loss"
})

export const r2 = R2LiveImageStore.layer({ key: "workspace-1", maxImageBytes: ByteSize.mebibytes(4) })

export type R2Requirements = Assert<Equals<Layer.Services<typeof r2>, R2LiveImageStore.Client | Digest.Digest>>

export const r2Provided = (client: R2LiveImageStore.R2Client) =>
  r2.pipe(Layer.provide(Layer.succeed(R2LiveImageStore.Client, client)))

export const sqlite = SqliteLiveImageStore.layer({
  filename: "/tmp/live.sqlite",
  maxImageBytes: ByteSize.mebibytes(4),
  maxDatabaseBytes: ByteSize.mebibytes(16)
})

export type SqliteRequirements = Assert<
  Equals<Layer.Services<typeof sqlite>, SqlClient | FileSystem.FileSystem | Path.Path | Digest.Digest>
>
