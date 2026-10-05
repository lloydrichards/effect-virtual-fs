import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { Effect, pipe } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"

const bytes = Uint8Array.of(1, 2, 3)

const options = { access: "write", create: "exclusive" } as const

const times: Vfs.Times = {
  access: { kind: "value", nanoseconds: 5n },
  modification: { kind: "value", nanoseconds: 7n }
}

describe("dual capability methods", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect("should preserve content metadata and link identity when caller mutations use either call style", () =>
      Effect.gen(function*() {
        const caller = yield* (yield* Vfs.make()).caller()

        for (const curried of [false, true]) {
          const file = curried ? "/curried" : "/direct"
          const alias = `${file}-alias`
          const moved = `${file}-moved`
          const write = caller.writeFile(bytes, options)
          yield* curried ? pipe(file, write) : caller.writeFile(file, bytes, options)
          assert.deepStrictEqual(yield* caller.readFile(file), bytes)

          yield* curried ? caller.chmod(0o640)(file) : caller.chmod(file, 0o640)
          assert.strictEqual((yield* caller.stat(file)).mode, 0o640)
          yield* curried ? caller.chown({ uid: 12, gid: 13 })(file) : caller.chown(file, { uid: 12, gid: 13 })
          const owned = yield* caller.stat(file)
          assert.deepStrictEqual([owned.uid, owned.gid], [12, 13])
          yield* curried ? caller.utimes(times)(file) : caller.utimes(file, times)
          const timed = yield* caller.stat(file)
          assert.deepStrictEqual([timed.atimeNs, timed.mtimeNs], [5n, 7n])
          yield* curried ? caller.truncate(2n)(file) : caller.truncate(file, 2n)
          assert.deepStrictEqual(yield* caller.readFile(file), Uint8Array.of(1, 2))
          const attributes = { size: 1n, mode: 0o600, owner: { uid: 14 }, times }
          yield* curried ? caller.setattr(attributes)(file) : caller.setattr(file, attributes)
          const updated = yield* caller.stat(file)
          assert.deepStrictEqual([updated.size, updated.mode, updated.uid, updated.mtimeNs], [1n, 0o600, 14, 7n])

          const linked = yield* curried ? caller.link(alias)(file) : caller.link(file, alias)
          assert.strictEqual((yield* caller.stat(alias)).ino, updated.ino)
          const renamed = yield* curried ? caller.rename(moved)(alias) : caller.rename(alias, moved)
          assert.strictEqual((yield* caller.stat(moved)).ino, updated.ino)
          assert.deepStrictEqual(yield* caller.readFile(moved), Uint8Array.of(1))
          assert.ok(linked.reference)
          assert.strictEqual(renamed._tag, "SameDirectory")
        }
      }))

    it.effect("should retain root authority and typed failures when a curried writer is reused after root rename", () =>
      Effect.gen(function*() {
        const owner = yield* (yield* Vfs.fromFixture({
          entries: [{ kind: "directory", path: "/workspace" }]
        })).caller()

        const rooted = yield* owner.withRoot("/workspace")
        const write = rooted.writeFile(bytes, options)
        yield* owner.rename("/workspace", "/moved")
        yield* Effect.succeed("/file").pipe(Effect.flatMap(write))
        assert.deepStrictEqual(yield* owner.readFile("/moved/file"), bytes)
        assert.strictEqual((yield* Effect.flip(owner.readFile("/file"))).code, "NotFound")
        assert.strictEqual((yield* Effect.flip(write("/file"))).code, "AlreadyExists")
        assert.strictEqual((yield* Effect.flip(rooted.chmod(-1)("/file"))).code, "InvalidArgument")
      }))

    it.effect("should preserve cursor isolation and closure failures when positional writes and seeks are curried", () =>
      Effect.gen(function*() {
        const caller = yield* (yield* Vfs.make()).caller()
        const handle = yield* caller.open("/file", { access: "readWrite", create: "exclusive" })

        const writeAt = handle.pwrite(1n)
        const seek = handle.seek("start")
        assert.strictEqual(yield* writeAt(bytes), 3)
        assert.strictEqual(yield* handle.seek(0n, "current"), 0n)
        assert.strictEqual(yield* seek(2n), 2n)
        assert.deepStrictEqual(yield* handle.read(2), Uint8Array.of(2, 3))
        assert.strictEqual((yield* Effect.flip(seek(-1n))).code, "InvalidArgument")
        assert.strictEqual(yield* handle.seek("current")(0n), 4n)
        yield* handle.close
        assert.strictEqual((yield* Effect.flip(writeAt(bytes))).code, "InvalidHandle")
        assert.strictEqual((yield* Effect.flip(seek(0n))).code, "InvalidHandle")
      }))
  })
})
