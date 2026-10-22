import assert from "node:assert/strict"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { NodeVirtualProvider } from "@effect-vfs/node"
import * as Effect from "effect/Effect"

await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
  const volume = yield* Vfs.make({ execution: "sync" })
  const provider = yield* NodeVirtualProvider.bind(volume)
  const caller = yield* volume.caller()
  provider.writeFileSync("/consumer", "built package")
  assert.equal(Buffer.from(yield* caller.readFile("/consumer")).toString(), "built package")
  const handle = provider.openSync("/consumer")
  assert.equal(handle.readFileSync("utf8"), "built package")
  handle.closeSync()
})).pipe(Effect.provide(NodeCrypto.layer)))

await assert.rejects(import("@effect-vfs/node/internal/fileHandle"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" })

await assert.rejects(import("@effect-vfs/core/internal/adapterBinding"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" })
