import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { type CheckpointError, CheckpointStore } from "@effect-vfs/persistence"
import { ByteSize, Effect, type Layer, type PlatformError } from "effect"
import type * as Digest from "effect/crypto/Digest"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import type { SqlClient } from "effect/sql/SqlClient"

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
