import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { assert, it } from "@effect/vitest"
import { ByteSize, Effect, Stream } from "effect"
import * as PlatformError from "effect/PlatformError"
import { layerDeterministicCrypto } from "../src/internal/crypto.js"
import { toPlatformError } from "../src/internal/platformError.js"
import * as Memory from "../src/MemoryFileSystem.js"

const systemReason = (error: PlatformError.PlatformError): PlatformError.SystemError =>
  error.reason instanceof PlatformError.SystemError ? error.reason : assert.fail("Expected a system error")

it("maps volume admission pressure to Busy", () => {
  const coreError = new Vfs.FsError({ code: "VolumeBusy", operation: "writeFile" })
  const error = toPlatformError(coreError, "writeFile", "/file")

  const reason = systemReason(error)
  assert.strictEqual(reason._tag, "Busy")
  assert.strictEqual(reason.method, "writeFile")
  assert.strictEqual(reason.pathOrDescriptor, "/file")
  assert.strictEqual(reason.cause, coreError)
})

it.layer(layerDeterministicCrypto)("memory adapter error mapping", (it) => {
  it.effect("reports capacity rejection without calling the resource invalid", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make({ maxBytes: ByteSize.bytes(1) })
      const fs = yield* Memory.bind(volume)

      const error = yield* Effect.flip(fs.writeFileString("/file", "too large"))

      const reason = systemReason(error)
      assert.strictEqual(reason._tag, "Unknown")
      assert.strictEqual(reason.method, "writeFile")
      assert.strictEqual(reason.pathOrDescriptor, "/file")
      assert.strictEqual(reason.description, "NoSpace")
    }))

  it.effect("attributes a missing watched path to watch", () =>
    Effect.gen(function*() {
      const fs = yield* Memory.make
      const error = yield* Effect.flip(fs.watch("/missing").pipe(Stream.runDrain))

      const reason = systemReason(error)
      assert.strictEqual(reason._tag, "NotFound")
      assert.strictEqual(reason.method, "watch")
      assert.strictEqual(reason.pathOrDescriptor, "/missing")
    }))
})
