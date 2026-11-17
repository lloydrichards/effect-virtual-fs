import { VirtualFileSystem } from "@effect-vfs/core"
import * as Vfs from "@effect-vfs/core/VirtualFileSystem"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { Effect } from "effect"
import assert from "node:assert/strict"

assert.strictEqual(VirtualFileSystem.make, Vfs.make)

await Effect.runPromise(
  Effect.scoped(Effect.gen(function*() {
    const volume: Vfs.Volume = yield* VirtualFileSystem.make()
    const writer = yield* volume.caller()
    const bytes = Uint8Array.of(0, 127, 128, 255)
    yield* writer.writeFile("/round-trip", bytes, { access: "write", create: "exclusive" })

    const reader = yield* volume.caller()
    assert.deepStrictEqual(yield* reader.readFile("/round-trip"), bytes)
  })).pipe(Effect.provide(NodeCrypto.layer))
)
