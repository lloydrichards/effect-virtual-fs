import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { Testing, VirtualFileSystem as Vfs } from "../src/index.js"

const decoder = new TextDecoder()

const guest = { uid: 1000, gid: 1000, groups: [], privileged: false }

describe("Testing.layer", () => {
  it.effect("provides a root caller on the volume it provides", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      yield* caller.mkdir("/work")

      const other = yield* volume.caller()
      assert.strictEqual((yield* other.stat("/work")).ino, (yield* caller.stat("/work")).ino)
      assert.deepStrictEqual([(yield* caller.stat("/")).uid, (yield* caller.stat("/work")).uid], [0, 0])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("builds a fresh volume for every provide", () =>
    Effect.gen(function*() {
      const write = Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.mkdir("/work")

        return (yield* caller.readDirectory("/")).value.length
      })

      const layer = Testing.layer()
      assert.deepStrictEqual([yield* Effect.provide(write, layer), yield* Effect.provide(write, layer)], [1, 1])
    }))

  it.effect("seeds the volume from a fixture and applies volume and caller options", () =>
    Effect.gen(function*() {
      const caller = yield* Vfs.Caller
      assert.strictEqual(decoder.decode(yield* caller.readFile("/seed.txt")), "seed")
      assert.strictEqual((yield* Vfs.Volume).limits.maxEntries, 3)

      yield* caller.mkdir("/work")
      assert.strictEqual((yield* caller.stat("/work")).mode, 0o700)
    }).pipe(Effect.provide(Testing.layer({
      fixture: { entries: [{ kind: "file", path: "/seed.txt", bytes: new TextEncoder().encode("seed") }] },
      volume: { maxEntries: 3 },
      caller: { umask: 0o077 }
    }))))

  it.effect("fails with the constructor's error for invalid volume options", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(
        Effect.provide(Effect.asVoid(Vfs.Caller), Testing.layer({ volume: { maxEntries: -1 } }))
      )

      assert.deepStrictEqual([error.code, error.field], ["InvalidArgument", "maxEntries"])

      const umaskError = yield* Effect.flip(
        Effect.provide(Effect.asVoid(Vfs.Caller), Testing.layer({ caller: { umask: 0o1000 } }))
      )

      assert.deepStrictEqual([umaskError.code, umaskError.field], ["InvalidArgument", "umask"])
    }))
})

describe("Testing.callerAs", () => {
  it.effect("creates a caller with the identity on the volume in context", () =>
    Effect.gen(function*() {
      const root = yield* Vfs.Caller
      yield* root.mkdir("/shared", { mode: 0o777 })

      const caller = yield* Testing.callerAs(guest, { umask: 0o022 })
      yield* caller.mkdir("/shared/mine", { mode: 0o777 })

      const metadata = yield* root.stat("/shared/mine")
      assert.deepStrictEqual([metadata.uid, metadata.mode], [1000, 0o755])
      assert.strictEqual((yield* Effect.flip(caller.mkdir("/denied"))).code, "AccessDenied")
    }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))
})

describe("Testing.collectChanges", () => {
  it.effect("collects the first n changes committed after the watch opened", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      yield* caller.mkdir("/before")

      const changes = yield* Testing.collectChanges(yield* volume.watch, 2)
      yield* caller.mkdir("/first")
      yield* caller.rmdir("/before")
      yield* caller.mkdir("/third")

      const collected: Array<string> = []

      for (const change of yield* changes) {
        collected.push(`${change._tag} ${decoder.decode(yield* Vfs.pathToBytes(change.path))}`)
      }

      assert.deepStrictEqual(collected, ["Create /first", "Remove /before"])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("returns fewer elements when the stream ends first and fails with its error", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(yield* (yield* Testing.collectChanges(Stream.make(1, 2), 5)), [1, 2])
      assert.strictEqual(yield* Effect.flip(yield* Testing.collectChanges(Stream.fail("boom"), 1)), "boom")
    }))
})
