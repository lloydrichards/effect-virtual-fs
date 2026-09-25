import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { type CheckpointError, CheckpointStore } from "@effect-vfs/persistence"
import { ByteSize, type Crypto, Effect, type Layer, type PlatformError } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"

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
  CheckpointStore | Crypto.Crypto
> = Effect.gen(function*() {
  const store = yield* CheckpointStore

  return yield* Vfs.fromSnapshot(yield* store.load("run"))
})
