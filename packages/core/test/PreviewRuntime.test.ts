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

        const prior = runtime.compatibility.orders.get(root)!
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

    it.effect("reclaims compatibility entries as objects and scoped handles retire", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make({ maxEntries: 2 })
        const caller = yield* volume.caller()
        const compatibility = runtimeOf(volume)!.compatibility
        const root = yield* caller.root
        const other = yield* (yield* Vfs.make()).caller()

        for (let i = 0; i < 100; i++) {
          const link = yield* caller.symlink("/target", "/link")
          yield* caller.link("/link", "/alias")
          yield* caller.unlink("/link")
          assert.strictEqual(compatibility.links.size, 1)
          assert.deepStrictEqual(yield* caller.readLink(link.reference), new TextEncoder().encode("/target"))
          yield* caller.unlink("/alias")
          assert.strictEqual((yield* Effect.flip(caller.stat(link.reference))).code, "StaleReference")

          yield* caller.mkdir("/directory")
          yield* caller.readDirectory("/directory")
          yield* Effect.scoped(Effect.gen(function*() {
            const directory = yield* caller.openDirectory("/directory")

            if (i % 2 === 0) yield* directory.close
          }))
          yield* caller.rmdir("/directory")

          const retired = yield* Effect.scoped(Effect.gen(function*() {
            const handle = yield* caller.open("/file", { ...create, append: true })
            yield* handle.write(bytes)
            const reference = (yield* caller.readDirectory("/")).value[0]!.reference
            const key = yield* volume.referenceKey(reference)

            yield* caller.rename("/file", "/renamed")
            yield* caller.link("/renamed", "/alias")
            const aliases = (yield* caller.readDirectory("/")).value
            assert.deepStrictEqual(aliases.map((entry) => new TextDecoder().decode(entry.name)), ["renamed", "alias"])

            for (const entry of aliases) assert.strictEqual(entry.reference, reference)
            yield* caller.unlink("/renamed")
            yield* caller.unlink("/alias")
            assert.strictEqual(yield* volume.resolveReferenceKey(key), reference)
            assert.strictEqual((yield* caller.stat(reference)).size, 3n)

            if (i % 2 === 0) {
              yield* handle.close
              assert.strictEqual((yield* Effect.flip(volume.resolveReferenceKey(key))).code, "StaleReference")
            }

            return reference
          }))

          assert.strictEqual((yield* Effect.flip(caller.stat(retired))).code, "StaleReference")
          assert.strictEqual((yield* Effect.flip(other.stat(retired))).code, "ForeignReference")
          assert.deepStrictEqual(yield* volume.usage, { entries: 0, usedBytes: 0n })
          assert.deepStrictEqual([...compatibility.tokens.values()].map((token) => token.core), [root])
          assert.strictEqual(compatibility.orders.size, 1)
          assert.strictEqual([...compatibility.links.values()].reduce((sum, link) => sum + link.byteLength, 0), 0)
          assert.strictEqual(compatibility.retained.size, 0)
          assert.strictEqual(compatibility.activeGrants.size, 0)
        }
      }))

    it.effect("retires synchronous pins after explicit and scoped close", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make({ execution: "sync" })
        const caller = yield* volume.caller()
        const compatibility = runtimeOf(volume)!.compatibility

        yield* Effect.scoped(Effect.gen(function*() {
          const native = yield* SynchronousAdapter.bind(volume)
          const explicit = native.open("/explicit", create, false, false)
          native.mkdir("/scoped")
          const scoped = native.open("/scoped", { access: "read" }, false, true)
          const explicitId = explicit.stat().ino
          const scopedId = scoped.stat().ino
          native.unlink("/explicit")
          native.rmdir("/scoped")

          assert.strictEqual(compatibility.retained.size, 2)
          explicit.close()
          assert.isFalse(compatibility.tokens.has(explicitId))
          assert.isTrue(compatibility.tokens.has(scopedId))

          native.symlink("/root", "/link")
          assert.strictEqual(compatibility.links.size, 1)
          native.unlink("/link")
          assert.strictEqual(compatibility.links.size, 0)
        }))

        assert.strictEqual(compatibility.retained.size, 0)
        assert.strictEqual(compatibility.tokens.size, 0)
        assert.strictEqual((yield* Effect.flip(caller.stat("/scoped"))).code, "NotFound")
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
