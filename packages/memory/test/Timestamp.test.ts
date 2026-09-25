import { Testing, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, PlatformError } from "effect"
import * as Memory from "../src/MemoryFileSystem.js"

const MAXIMUM_MS = 8_640_000_000_000_000
const MAXIMUM_NS = BigInt(MAXIMUM_MS) * 1_000_000n

const overflowingFixture = (field: "atimeNs" | "mtimeNs" | "birthtimeNs", timestamp: bigint): Vfs.Fixture => ({
  entries: [{ kind: "file", path: "/file", bytes: new Uint8Array([42]), metadata: { [field]: timestamp } }]
})

const BOUNDARY_FIXTURE: Vfs.Fixture = {
  entries: [{
    kind: "file",
    path: "/file",
    bytes: new Uint8Array(),
    metadata: { atimeNs: -MAXIMUM_NS, mtimeNs: MAXIMUM_NS, birthtimeNs: -1_999_999n, ctimeNs: 10n ** 100n }
  }]
}

describe("adapter timestamp conversion", () => {
  for (const field of ["atimeNs", "mtimeNs", "birthtimeNs"] as const) {
    for (const sign of [-1n, 1n]) {
      it.effect(`should fail stat with InvalidData when ${field} exceeds the Date range with sign ${sign}`, () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          const before = yield* caller.stat("/file")
          const fs = yield* Memory.bind(yield* Vfs.Volume)
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
        }).pipe(Effect.provide(Testing.layer({ fixture: overflowingFixture(field, sign * 10n ** 100n) }))))
    }
  }

  it.effect("should return independent valid dates when timestamps reach Date boundaries", () =>
    Effect.gen(function*() {
      const fs = yield* Memory.bind(yield* Vfs.Volume)
      const file = yield* fs.open("/file")

      for (const info of [yield* fs.stat("/file"), yield* file.stat]) {
        assert.strictEqual(Option.getOrThrow(info.atime).getTime(), -MAXIMUM_MS)
        assert.strictEqual(Option.getOrThrow(info.mtime).getTime(), MAXIMUM_MS)
        assert.strictEqual(Option.getOrThrow(info.birthtime).getTime(), -1)
        Option.getOrThrow(info.atime).setTime(0)
      }

      assert.strictEqual(Option.getOrThrow((yield* fs.stat("/file")).atime).getTime(), -MAXIMUM_MS)
    }).pipe(Effect.provide(Testing.layer({ fixture: BOUNDARY_FIXTURE }))))
})
