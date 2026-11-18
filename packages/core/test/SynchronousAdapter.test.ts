import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"
import * as SynchronousAdapter from "../src/SynchronousAdapter.js"

const bytes = Uint8Array.of(1, 2, 3)

const create = { access: "write", create: "exclusive" } as const

describe("synchronous binding", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect("closes native handles explicitly and when the binding scope ends", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make({ execution: "sync" })
        const caller = yield* volume.caller()

        const scopedHandle = yield* Effect.scoped(Effect.gen(function*() {
          const native = yield* SynchronousAdapter.bind(volume)
          const explicit = native.open("/explicit", create, false, false)
          native.mkdir("/scoped")
          const scoped = native.open("/scoped", { access: "read" }, false, true)
          native.unlink("/explicit")
          native.rmdir("/scoped")

          explicit.close()

          assert.isTrue(explicit.closed)
          assert.isFalse(scoped.closed)

          return scoped
        }))

        assert.isTrue(scopedHandle.closed)
        assert.strictEqual((yield* Effect.flip(caller.stat("/scoped"))).code, "NotFound")
      }))

    it.effect("shares positional writes between Effect and synchronous handles", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make({ execution: "sync" })

        const caller = yield* volume.caller()
        yield* caller.writeFile("/file", bytes, create)
        const file = yield* caller.open("/file", { access: "readWrite" })
        const native = (yield* SynchronousAdapter.bind(volume)).open("/file", { access: "readWrite" }, false, false)
        assert.strictEqual(yield* file.pwrite(Uint8Array.of(7), 0n), 1)
        assert.strictEqual(native.write(Uint8Array.of(8), 2n, false), 1)
        native.close()

        assert.deepStrictEqual(yield* caller.readFile("/file"), Uint8Array.of(7, 2, 8))
      }))

    it.effect("rejects a default cooperative volume", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make()
        const error = yield* Effect.flip(SynchronousAdapter.bind(volume))
        assert.deepStrictEqual([error.code, error.operation, error.field], ["InvalidArgument", "bind", "volume"])
      }))

    it.effect("exposes the same metadata and bytes through both bindings after sync", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make({ execution: "sync" })
        const caller = yield* volume.caller()
        yield* caller.writeFile("/file", bytes, create)
        const native = yield* SynchronousAdapter.bind(volume)
        const handle = native.open("/file", { access: "readWrite" }, false, false)
        const before = yield* Vfs.encodeSnapshot(yield* volume.snapshot)

        assert.deepStrictEqual(native.stat("/file"), yield* caller.stat("/file"))
        assert.strictEqual(native.access("/file", 4), yield* caller.access("/file", 4))
        assert.strictEqual(handle.stat().size, 3n)
        handle.sync()
        assert.deepStrictEqual(yield* Vfs.encodeSnapshot(yield* volume.snapshot), before)

        handle.write(Uint8Array.of(9), 0n, false)
        const restored = yield* (yield* Vfs.fromSnapshot(yield* volume.snapshot)).caller()
        assert.deepStrictEqual(yield* restored.readFile("/file"), Uint8Array.of(9, 2, 3))
      }))
  })
})
