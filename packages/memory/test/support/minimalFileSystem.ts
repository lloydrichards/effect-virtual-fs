import * as Vfs from "@effect-vfs/core/VirtualFileSystem"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import { bindOperations } from "../../src/internal/fileSystemAdapter.js"

export const make = Effect.fnUntraced(function*(options?: Vfs.VolumeOptions) {
  const volume = yield* Vfs.fromFixture({ entries: [{ kind: "directory", path: "/tmp" }] }, options).pipe(
    Effect.provide(NodeCrypto.layer)
  )

  return yield* bindOperations(yield* volume.caller({ umask: 0 }))
})

export const layer = Layer.effect(FileSystem.FileSystem, make())
