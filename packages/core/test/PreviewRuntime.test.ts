import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"
import { runtimeOf } from "../src/internal/runtime.js"
import * as SynchronousAdapter from "../src/SynchronousAdapter.js"
import { entryNames } from "./support/text.js"

const bytes = Uint8Array.of(1, 2, 3)

const create = { access: "write", create: "exclusive" } as const

describe("preview ownership", () => {
  it.layer(BunCrypto.layer)((it) => {
    for (const execution of ["cooperative", "sync"] as const) {
      it.effect(`shares ${execution} core writes with the public preview owner`, () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.make({ execution })
          const runtime = runtimeOf(volume)
          assert.isDefined(runtime)

          if (runtime === undefined) return assert.fail("Core did not construct preview state")
          const core = yield* volume.caller()
          const preview = yield* runtime.owner.authorize({ credentials: { uid: 0, gid: 0, privileged: true } })
          yield* core.writeFile("/core", bytes, create)
          assert.deepStrictEqual(yield* preview.readFile("/core"), bytes)
          yield* preview.writeFile("/preview", bytes)
          assert.deepStrictEqual(yield* core.readFile("/preview"), bytes)
          const restored = yield* Vfs.fromSnapshot(yield* volume.snapshot)
          assert.isDefined(runtimeOf(restored))
          assert.deepStrictEqual(yield* (yield* restored.caller()).readFile("/core"), bytes)
        }))
    }

    it.effect("reconciles directory listings in linear work while preserving the order of surviving names", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make()
        const core = yield* volume.caller()
        const runtime = runtimeOf(volume)

        if (runtime === undefined) return assert.fail("Core did not construct preview state")
        const root = (yield* core.stat("/")).ino
        const names = Array.from({ length: 64 }, (_, i) => `f${63 - i}`)

        for (const name of names) yield* core.writeFile("/" + name, bytes, create)
        assert.deepStrictEqual(entryNames(yield* core.readDirectory("/")), names)

        const prior = runtime.orders.get(root)!
        let reads = 0
        prior.forEach((name, index) => {
          Object.defineProperty(prior, index, {
            get() {
              reads++

              return name
            }
          })
        })
        assert.deepStrictEqual(entryNames(yield* core.readDirectory("/")), names)
        assert.isAtMost(reads, 2 * names.length)

        const preview = yield* runtime.owner.authorize({ credentials: { uid: 0, gid: 0 } })
        yield* preview.unlink("/f62")
        yield* preview.rename("/f63", "/z")
        yield* preview.createFile("/a")
        const expected = [...names.slice(2), "a", "z"]
        assert.deepStrictEqual(entryNames(yield* core.readDirectory("/")), expected)
        assert.deepStrictEqual(entryNames(yield* core.readDirectory("/")), expected)
      }))

    it.effect("overwrites existing bytes through both handle bindings without querying volume usage", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make({ execution: "sync" })
        const runtime = runtimeOf(volume)

        if (runtime === undefined) return assert.fail("Core did not construct preview state")
        const caller = yield* volume.caller()
        yield* caller.writeFile("/file", bytes, create)
        const file = yield* caller.open("/file", { access: "readWrite" })
        const native = (yield* SynchronousAdapter.bind(volume)).open("/file", { access: "readWrite" }, false, false)
        const owner = runtime.owner
        let scans = 0
        const usage = Effect.tap(owner.usage, () => Effect.sync(() => scans++))
        Object.assign(runtime, { owner: { ...owner, usage } })

        try {
          assert.strictEqual(yield* file.pwrite(Uint8Array.of(7), 0n), 1)
          const effectScans = scans
          assert.strictEqual(native.write(Uint8Array.of(8), 2n, false), 1)
          assert.deepStrictEqual([effectScans, scans - effectScans], [0, 0])
        } finally {
          Object.assign(runtime, { owner })
          native.close()
        }

        assert.deepStrictEqual(yield* caller.readFile("/file"), Uint8Array.of(7, 2, 8))
      }))

    it.effect("shares native writes with the same public preview owner", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make({ execution: "sync" })
        const runtime = runtimeOf(volume)
        assert.isDefined(runtime)

        if (runtime === undefined) return assert.fail("Core did not construct preview state")
        const native = yield* SynchronousAdapter.bind(volume)
        const handle = native.open("/native", create, false, false)
        assert.strictEqual(handle.write(bytes, 0n, false), bytes.length)
        handle.close()
        const preview = yield* runtime.owner.authorize({ credentials: { uid: 0, gid: 0, privileged: true } })
        assert.deepStrictEqual(yield* preview.readFile("/native"), bytes)
      }))
  })
})
