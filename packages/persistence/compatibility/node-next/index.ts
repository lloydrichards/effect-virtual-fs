import { type LiveVolume, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { type CheckpointError, CheckpointStore } from "@effect-vfs/persistence"
import * as PgLiveImageStore from "@effect-vfs/persistence/PgLiveImageStore"
import * as PgClient from "@effect/sql-pg/PgClient"
import { ByteSize, Effect, Layer, type PlatformError, Redacted } from "effect"
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
