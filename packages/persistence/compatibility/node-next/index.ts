import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { CheckpointError, CheckpointStore } from "@effect-vfs/persistence"
import { ByteSize, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

const limits = {
  maxEncodedBytes: ByteSize.kilobytes(100),
  maxRecords: 100,
  maxEntries: 100,
  maxDecodedBytes: ByteSize.kilobytes(10)
}
export const live: Layer.Layer<CheckpointStore, Vfs.ImageError, SqlClient> = CheckpointStore.layer(limits)
export const program: Effect.Effect<
  Vfs.Volume,
  CheckpointError | Vfs.ImageError | Vfs.ConfigurationError,
  CheckpointStore
> = Effect.gen(function*() {
  const store = yield* CheckpointStore
  return yield* Vfs.fromSnapshot(yield* store.load("run"))
})
