import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { Testing, VirtualFileSystem as Vfs } from "../src/index.js"

const decoder = new TextDecoder()

const guest = { uid: 1000, gid: 1000, groups: [], privileged: false }

describe("Testing.layer", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should provide a root caller on the same volume when the test layer is constructed",
      () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.Volume
          const caller = yield* Vfs.Caller
          yield* caller.mkdir("/work")

          const other = yield* volume.caller()
          assert.strictEqual((yield* other.stat("/work")).ino, (yield* caller.stat("/work")).ino)
          assert.deepStrictEqual([(yield* caller.stat("/")).uid, (yield* caller.stat("/work")).uid], [0, 0])
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should build a fresh volume when the test layer is provided again", () =>
      Effect.gen(function*() {
        const write = Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          yield* caller.mkdir("/work")

          return (yield* caller.readDirectory("/")).value.length
        })

        const layer = Testing.layer()
        assert.deepStrictEqual([yield* Effect.provide(write, layer), yield* Effect.provide(write, layer)], [1, 1])
      }))
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should seed a volume and apply caller options when a fixture is supplied",
      () =>
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
        })))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should return the constructor error when volume options are invalid", () =>
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
})

describe("Testing.callerAs", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should create a caller with the requested identity when a volume is in context",
      () =>
        Effect.gen(function*() {
          const root = yield* Vfs.Caller
          yield* root.mkdir("/shared", { mode: 0o777 })

          const caller = yield* Testing.callerAs(guest, { umask: 0o022 })
          yield* caller.mkdir("/shared/mine", { mode: 0o777 })

          const metadata = yield* root.stat("/shared/mine")
          assert.deepStrictEqual([metadata.uid, metadata.mode], [1000, 0o755])
          assert.strictEqual((yield* Effect.flip(caller.mkdir("/denied"))).code, "AccessDenied")
        }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } })))
    )
  })
})

describe("Testing.collectChanges", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect("should collect the first n changes committed when the watch opened", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const caller = yield* Vfs.Caller
        yield* caller.mkdir("/before")

        const changes = yield* Testing.collectChanges(yield* volume.watch(), 2)
        yield* caller.mkdir("/first")
        yield* caller.rmdir("/before")
        yield* caller.mkdir("/third")

        const collected: Array<string> = []

        for (const change of yield* changes) {
          collected.push(`${change._tag} ${decoder.decode(yield* Vfs.pathToBytes(change.path))}`)
        }

        assert.deepStrictEqual(collected, ["Create /first", "Remove /before"])
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should return fewer elements when the stream ends first", () =>
      Effect.gen(function*() {
        assert.deepStrictEqual(yield* (yield* Testing.collectChanges(Stream.make(1, 2), 5)), [1, 2])
      }))
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should fail with the stream error when the stream fails", () =>
      Effect.gen(function*() {
        assert.strictEqual(yield* Effect.flip(yield* Testing.collectChanges(Stream.fail("boom"), 1)), "boom")
      }))
  })
})
