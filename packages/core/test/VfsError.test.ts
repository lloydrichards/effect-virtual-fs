import { assert, describe } from "@effect/vitest"
import { ByteSize, Effect, Exit, Layer, Schema } from "effect"
import { LiveVolume, VfsError, VirtualFileSystem as Vfs } from "../src/index.js"
import { it } from "./TestEffect.js"

const LIMITS = {
  maxEncodedBytes: ByteSize.kilobytes(64),
  maxRecords: 100,
  maxEntries: 100,
  maxDecodedBytes: ByteSize.kilobytes(64)
}

const WireError = Schema.fromJsonString(VfsError.VfsError)

// The wire form of an error, with its path as whatever base64 text the sender wrote.
const RawWireError = Schema.fromJsonString(
  Schema.Struct({ _tag: Schema.String, code: Schema.String, operation: Schema.String, path: Schema.String })
)

describe("VfsError", () => {
  it.effect("an error names no path that a BytePath could not hold", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()

      for (const input of ["", "/a\u0000b"]) {
        const error = yield* Effect.flip(fs.readFile(input))

        assert.isUndefined(error.path, `input ${input.length} characters`)
      }
    }))

  it.effect("decoding an error from the wire rejects an empty path or one holding a NUL", () =>
    Effect.gen(function*() {
      // "" and the base64 of "/a\0b".
      for (const path of ["", "L2EAYg=="]) {
        const text = yield* Schema.encodeEffect(RawWireError)({
          _tag: "VfsError",
          code: "NotFound",
          operation: "readFile",
          path
        })

        const decoded = yield* Effect.exit(Schema.decodeEffect(WireError)(text))

        assert.isTrue(Exit.isFailure(decoded), `path "${path}"`)
      }
    }))

  it.effect("make carries its code in the type and leaves absent details absent", () =>
    Effect.gen(function*() {
      const failure: VfsError.StoreFailure = VfsError.make({
        code: "Storage",
        operation: "Store.load",
        field: undefined
      })

      assert.deepStrictEqual(
        Object.keys(failure).filter((key) => key !== "_tag").sort(),
        ["code", "operation"]
      )
      assert.strictEqual(failure.message, "Store.load failed with Storage")

      const decoded = yield* Schema.decodeEffect(WireError)(yield* Schema.encodeEffect(WireError)(failure))
      assert.deepStrictEqual([decoded.code, decoded.operation], ["Storage", "Store.load"])
    }))
})

describe("option decoding names the offending field", () => {
  it.effect("decodeSnapshot rejects malformed limits as InvalidArgument at the key", () =>
    Effect.gen(function*() {
      const bytes = yield* Vfs.encodeSnapshot(yield* (yield* Vfs.make()).snapshot)
      const error = yield* Effect.flip(Vfs.decodeSnapshot(bytes, { ...LIMITS, maxRecords: -1 }))

      assert.deepStrictEqual(
        { code: error.code, operation: error.operation, field: error.field },
        { code: "InvalidArgument", operation: "decodeSnapshot", field: "maxRecords" }
      )
    }))

  it.effect("LiveVolume.open names the nested volume option that failed", () =>
    Effect.gen(function*() {
      const store = Layer.succeed(
        LiveVolume.LiveImageStore,
        LiveVolume.LiveImageStore.of({
          loadOrCreate: (initial) => Effect.succeed(initial),
          commit: () => Effect.succeed("committed" as const)
        })
      )

      const error = yield* Effect.flip(
        Effect.scoped(
          LiveVolume.open({
            maxImageBytes: ByteSize.kilobytes(64),
            volume: {
              maxEntries: -1,
              maxBytes: ByteSize.kilobytes(32),
              maxFileBytes: ByteSize.kilobytes(16),
              maxPathBytes: ByteSize.bytes(1024)
            }
          })
        ).pipe(Effect.provide(store))
      )

      assert.deepStrictEqual([error.code, error.field], ["InvalidArgument", "volume.maxEntries"])
    }))
})
