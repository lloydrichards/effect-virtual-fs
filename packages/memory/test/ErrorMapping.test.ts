import { Testing, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, Stream } from "effect"
import * as PlatformError from "effect/PlatformError"
import { toPlatformError } from "../src/internal/platformError.js"
import * as Memory from "../src/MemoryFileSystem.js"

const systemReason = (error: PlatformError.PlatformError): PlatformError.SystemError =>
  error.reason instanceof PlatformError.SystemError ? error.reason : assert.fail("Expected a system error")

it("should map volume admission pressure to Busy when translating a core error", () => {
  const coreError = new Vfs.VfsError({ code: "VolumeBusy", operation: "writeFile" })
  const error = toPlatformError(coreError, "writeFile", "/file")

  const reason = systemReason(error)
  assert.strictEqual(reason._tag, "Busy")
  assert.strictEqual(reason.method, "writeFile")
  assert.strictEqual(reason.pathOrDescriptor, "/file")
  assert.strictEqual(reason.cause, coreError)
})

describe("memory adapter error mapping", () => {
  it.effect("should report NoSpace when a write exceeds capacity", () =>
    Effect.gen(function*() {
      const fs = yield* Memory.bind(yield* Vfs.Volume)

      const error = yield* Effect.flip(fs.writeFileString("/file", "too large"))

      const reason = systemReason(error)
      assert.strictEqual(reason._tag, "Unknown")
      assert.strictEqual(reason.method, "writeFile")
      assert.strictEqual(reason.pathOrDescriptor, "/file")
      assert.strictEqual(reason.description, "NoSpace")
    }).pipe(Effect.provide(Testing.layer({ volume: { maxBytes: ByteSize.bytes(1) } }))))

  it.effect("should report an ownership denial as PermissionDenied that says EPERM", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const owner = yield* Memory.bind(volume)
      yield* owner.writeFileString("/file", "x")
      const guest = yield* Memory.bind(volume, { identity: { uid: 1, gid: 1, groups: [], privileged: false } })

      const error = yield* Effect.flip(guest.chmod("/file", 0o600))

      const reason = systemReason(error)
      assert.strictEqual(reason._tag, "PermissionDenied")
      assert.strictEqual(reason.method, "chmod")
      assert.strictEqual(reason.description, "NotPermitted (EPERM)")
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("should attribute a missing path to watch when watch subscription fails", () =>
    Effect.gen(function*() {
      const fs = yield* Memory.make
      const error = yield* Effect.flip(fs.watch("/missing").pipe(Stream.runDrain))

      const reason = systemReason(error)
      assert.strictEqual(reason._tag, "NotFound")
      assert.strictEqual(reason.method, "watch")
      assert.strictEqual(reason.pathOrDescriptor, "/missing")
    }))
})
