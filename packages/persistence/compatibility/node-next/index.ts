import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { CheckpointError, CheckpointStore } from "@effect-vfs/persistence"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

const limits = { maxEncodedBytes: 100_000, maxRecords: 100, maxEntries: 100, maxDecodedBytes: 10_000 }
export const live: Layer.Layer<CheckpointStore, Vfs.ImageError, SqlClient> = CheckpointStore.layer(limits)
export const program: Effect.Effect<
  Vfs.Volume,
  CheckpointError | Vfs.ImageError | Vfs.ConfigurationError,
  CheckpointStore
> = Effect.gen(function*() {
  const store = yield* CheckpointStore
  return yield* Vfs.fromSnapshot(yield* store.load("run"))
})
