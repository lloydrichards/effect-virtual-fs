import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, Exit, Layer, Schema } from "effect"
import { LiveVolume, Testing, VfsError, VirtualFileSystem as Vfs } from "../src/index.js"
import { pathText } from "./support/text.js"

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
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should reject an unrepresentable error path when constructing a VfsError",
      () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller

          for (const input of ["", "/a\u0000b"]) {
            const error = yield* Effect.flip(fs.readFile(input))

            assert.isUndefined(error.path, `input ${input.length} characters`)
          }
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should reject empty or NUL paths when decoding an error from the wire",
      () =>
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
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should retain its code and omit absent details when constructing an error",
      () =>
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
        })
    )
  })
})

describe("option decoding names the offending field", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should report InvalidArgument at the key when decodeSnapshot receives malformed limits",
      () =>
        Effect.gen(function*() {
          const bytes = yield* Vfs.encodeSnapshot(yield* (yield* Vfs.Volume).snapshot)
          const error = yield* Effect.flip(Vfs.decodeSnapshot(bytes, { ...LIMITS, maxRecords: -1 }))

          assert.deepStrictEqual(
            { code: error.code, operation: error.operation, field: error.field },
            { code: "InvalidArgument", operation: "decodeSnapshot", field: "maxRecords" }
          )
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should name the nested option when LiveVolume.open rejects volume configuration",
      () =>
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
        })
    )
  })
})

const encoder = new TextEncoder()

// Which operation and which argument an error names, with an absent path kept distinct from undefined.
interface Attribution {
  readonly code: Vfs.VfsCode
  readonly operation: string
  readonly path: unknown
}

const attribution = (error: Vfs.VfsError): Effect.Effect<Attribution> =>
  Effect.map("path" in error ? pathText(error.path) : Effect.succeed("<absent>"), (path) => ({
    code: error.code,
    operation: error.operation,
    path
  }))

describe("filesystem error attribution", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should name the failing argument when a two-path operation rejects input",
      () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          yield* fs.writeFile("/a", new Uint8Array([1]), { access: "write", create: "exclusive" })
          yield* fs.writeFile("/b", new Uint8Array([2]), { access: "write", create: "exclusive" })

          assert.deepEqual(yield* attribution(yield* Effect.flip(fs.rename("/missing", "/c"))), {
            code: "NotFound",
            operation: "rename",
            path: "/missing"
          })

          assert.deepEqual(yield* attribution(yield* Effect.flip(fs.rename("/a", "/nowhere/c"))), {
            code: "NotFound",
            operation: "rename",
            path: "/nowhere/c"
          })

          assert.deepEqual(yield* attribution(yield* Effect.flip(fs.link("/a", "/b"))), {
            code: "AlreadyExists",
            operation: "link",
            path: "/b"
          })

          assert.deepEqual(yield* attribution(yield* Effect.flip(fs.symlink("bad\0target", "/link"))), {
            code: "InvalidArgument",
            operation: "symlink",
            // No BytePath holds a NUL, so the error names no path.
            path: "<absent>"
          })
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should attribute errors to the public operation when positional I/O fails",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          const handle = yield* fs.open("/file", { access: "readWrite", create: "exclusive" })

          assert.deepEqual(yield* attribution(yield* Effect.flip(handle.pread(-1, 0n))), {
            code: "InvalidArgument",
            operation: "read",
            path: "<absent>"
          })

          assert.deepEqual(yield* attribution(yield* Effect.flip(handle.pwrite(new Uint8Array([1]), -1n))), {
            code: "InvalidArgument",
            operation: "write",
            path: "<absent>"
          })

          yield* handle.close

          assert.deepEqual(yield* attribution(yield* Effect.flip(handle.pread(1, 0n))), {
            code: "InvalidHandle",
            operation: "pread",
            path: "<absent>"
          })

          assert.deepEqual(yield* attribution(yield* Effect.flip(handle.pwrite(new Uint8Array([1]), 0n))), {
            code: "InvalidHandle",
            operation: "pwrite",
            path: "<absent>"
          })
        })).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should omit paths for reference failures when scoped directory entry points fail",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          const root = yield* fs.root

          assert.deepEqual(
            yield* attribution(yield* Effect.flip(fs.unlink(Vfs.Entry(root, encoder.encode("missing"))))),
            {
              code: "NotFound",
              operation: "unlink",
              path: "<absent>"
            }
          )

          assert.deepEqual(yield* attribution(yield* Effect.flip(fs.withDirectory("/missing"))), {
            code: "NotFound",
            operation: "withDirectory",
            path: "/missing"
          })
        })).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should omit a path when an untyped caller supplies undefined", () =>
      Effect.gen(function*() {
        const fs = yield* Vfs.Caller
        // SAFETY: deliberately violates PathInput to pin the error shape an untyped caller sees.
        const error = yield* Effect.flip(fs.symlink(undefined as never, "/link"))

        assert.deepEqual(yield* attribution(error), { code: "InvalidArgument", operation: "symlink", path: "<absent>" })
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should attribute failure to commit when a live image exceeds its limit",
      () =>
        Effect.gen(function*() {
          const stored = yield* LiveVolume.prepareEmptyImage()

          const session = yield* LiveVolume.openImage(
            stored,
            ByteSize.bytes(stored.length + 64),
            () => Effect.succeed("committed" as const)
          )

          const fs = yield* session.volume.caller()
          const bytes = new Uint8Array(1024)

          assert.deepEqual(
            yield* attribution(
              yield* Effect.flip(fs.writeFile("/large", bytes, { access: "write", create: "exclusive" }))
            ),
            { code: "StorageRejected", operation: "commit", path: "<absent>" }
          )

          yield* session.shutdown
        })
    )
  })
})
