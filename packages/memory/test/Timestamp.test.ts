import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, PlatformError } from "effect"
import * as Memory from "../src/MemoryFileSystem.js"

describe("adapter timestamp conversion", () => {
  for (const field of ["atimeNs", "mtimeNs", "birthtimeNs"] as const) {
    for (const sign of [-1n, 1n]) {
      it.effect(`should fail stat with InvalidData when ${field} exceeds the Date range with sign ${sign}`, () =>
        Effect.gen(function*() {
          const timestamp = sign * 10n ** 100n
          const volume = yield* Vfs.fromFixture({
            entries: [{ kind: "file", path: "/file", bytes: new Uint8Array([42]), metadata: { [field]: timestamp } }]
          })
          const caller = yield* volume.caller()
          const before = yield* caller.stat("/file")
          const fs = yield* Memory.bind(volume)
          const file = yield* fs.open("/file")
          const pathError = yield* Effect.flip(fs.stat("/file"))
          const handleError = yield* Effect.flip(file.stat)
          for (const error of [pathError, handleError]) {
            assert.strictEqual(error.reason._tag, "InvalidData")
            assert.strictEqual(error.reason.method, "stat")
            assert.include(error.reason.description ?? "", field)
          }
          assert.instanceOf(pathError.reason, PlatformError.SystemError)
          assert.instanceOf(handleError.reason, PlatformError.SystemError)
          assert.strictEqual(pathError.reason.pathOrDescriptor, "/file")
          assert.isNumber(handleError.reason.pathOrDescriptor)
          assert.deepStrictEqual(yield* caller.stat("/file"), before)
        }))
    }
  }

  it.effect("should return owned valid dates when timestamps reach either Date boundary", () =>
    Effect.gen(function*() {
      const maximumMs = 8_640_000_000_000_000
      const maximumNs = BigInt(maximumMs) * 1_000_000n
      const volume = yield* Vfs.fromFixture({
        entries: [{
          kind: "file",
          path: "/file",
          bytes: new Uint8Array(),
          metadata: { atimeNs: -maximumNs, mtimeNs: maximumNs, birthtimeNs: -1_999_999n, ctimeNs: 10n ** 100n }
        }]
      })
      const fs = yield* Memory.bind(volume)
      const file = yield* fs.open("/file")
      for (const info of [yield* fs.stat("/file"), yield* file.stat]) {
        assert.strictEqual(Option.getOrThrow(info.atime).getTime(), -maximumMs)
        assert.strictEqual(Option.getOrThrow(info.mtime).getTime(), maximumMs)
        assert.strictEqual(Option.getOrThrow(info.birthtime).getTime(), -1)
        Option.getOrThrow(info.atime).setTime(0)
      }
      assert.strictEqual(Option.getOrThrow((yield* fs.stat("/file")).atime).getTime(), -maximumMs)
    }))
})
