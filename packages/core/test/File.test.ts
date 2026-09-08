import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Scope } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"

const bytes = (...values: Array<number>) => new Uint8Array(values)

describe("regular files", () => {
  it.effect("shares content but keeps independent offsets and owns transfer buffers", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      const a = yield* fs.open("/f", { access: "readWrite", create: "exclusive" })
      const input = bytes(1, 2, 3)
      const write = a.write(input)
      input[0] = 4
      assert.strictEqual(yield* write, 3)
      input[0] = 9
      const b = yield* fs.open("/f", { access: "read" })
      const read = yield* b.read(2)
      assert.deepStrictEqual(read, bytes(4, 2))
      read[0] = 8
      assert.deepStrictEqual(yield* a.pread(3, 0n), bytes(4, 2, 3))
      assert.strictEqual(yield* a.seek(0n, "current"), 3n)
      assert.deepStrictEqual(yield* b.read(5), bytes(3))
      assert.deepStrictEqual(yield* b.read(1), bytes())
    }))

  it.effect("preserves offsets across truncate and positional I/O and fills gaps with zero", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      const f = yield* fs.open("/f", { access: "readWrite", create: "exclusive" })
      yield* f.write(bytes(1, 2, 3))
      yield* f.seek(8n, "start")
      yield* f.truncate(1n)
      assert.strictEqual(yield* f.seek(0n, "current"), 8n)
      yield* f.write(bytes(7))
      assert.deepStrictEqual(yield* f.pread(10, 0n), bytes(1, 0, 0, 0, 0, 0, 0, 0, 7))
      yield* f.pwrite(bytes(6), 1n)
      assert.strictEqual(yield* f.seek(0n, "current"), 9n)
      assert.strictEqual((yield* Effect.flip(f.seek(-10n, "current"))).code, "InvalidArgument")
      assert.strictEqual(yield* f.seek(0n, "current"), 9n)
      assert.strictEqual((yield* Effect.flip(f.pread(1, 1n << 64n))).code, "InvalidArgument")
      assert.strictEqual((yield* Effect.flip(f.pwrite(bytes(1), 1n << 64n))).code, "InvalidArgument")
      assert.strictEqual(yield* f.seek(1n, "data"), 1n)
      assert.strictEqual(yield* f.seek(1n, "hole"), 9n)
      assert.strictEqual((yield* Effect.flip(f.seek(9n, "data"))).code, "NoData")
      assert.strictEqual(yield* f.seek(0n, "current"), 9n)
    }))

  it.effect("appends atomically while positional writes ignore append and preserve offset", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      const a = yield* fs.open("/f", { access: "readWrite", append: true, create: "ifMissing" })
      const b = yield* fs.open("/f", { access: "write", append: true })
      yield* Effect.all([a.write(bytes(1, 1)), b.write(bytes(2, 2))], { concurrency: "unbounded" })
      const data = yield* a.pread(4, 0n)
      assert.isTrue(data.join() === "1,1,2,2" || data.join() === "2,2,1,1")
      const position = yield* a.seek(0n, "current")
      yield* a.pwrite(bytes(9), 0n)
      assert.strictEqual(yield* a.seek(0n, "current"), position)
      assert.strictEqual((yield* a.pread(1, 0n))[0], 9)
      yield* a.seek(0n, "start")
      yield* a.write(bytes())
      assert.strictEqual(yield* a.seek(0n, "current"), 0n)
    }))

  it.effect("returns capacity-limited prefixes and preserves bytes and metadata on failed growth", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make({ maxBytes: 6 })).caller()
      const f = yield* fs.open("/f", { access: "readWrite", create: "exclusive" })
      yield* f.write(bytes(1, 2, 3, 4))
      assert.strictEqual(yield* f.write(bytes(5, 6, 7)), 2)
      const before = yield* f.stat()
      assert.strictEqual((yield* Effect.flip(f.write(bytes(8)))).code, "NoSpace")
      assert.strictEqual((yield* Effect.flip(f.truncate(7n))).code, "NoSpace")
      assert.deepStrictEqual(yield* f.stat(), before)
      assert.strictEqual(yield* f.pwrite(bytes(9), 1n), 1)
      yield* f.truncate(4n)
      assert.strictEqual((yield* Effect.flip(f.pwrite(bytes(8), 6n))).code, "NoSpace")
      assert.strictEqual(yield* f.pwrite(bytes(8, 9), 5n), 1)
      assert.deepStrictEqual(yield* f.pread(9, 0n), bytes(1, 9, 3, 4, 0, 8))
    }))

  it.effect("retains unlinked content charge until the final independent handle closes", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make({ maxBytes: 2, maxEntries: 1 })).caller()
      const a = yield* fs.open("/f", { access: "readWrite", create: "exclusive" })
      const b = yield* fs.open("/f", { access: "read" })
      yield* a.write(bytes(1, 2))
      yield* fs.unlink("/f")
      assert.strictEqual((yield* a.stat()).nlink, 0)
      const replacement = yield* fs.open("/f", { access: "write", create: "exclusive" })
      assert.strictEqual((yield* Effect.flip(replacement.write(bytes(3)))).code, "NoSpace")
      yield* a.close()
      assert.deepStrictEqual(yield* b.read(2), bytes(1, 2))
      yield* b.close()
      assert.strictEqual(yield* replacement.write(bytes(3, 4)), 2)
      assert.strictEqual((yield* Effect.flip(a.close())).code, "InvalidHandle")
      assert.strictEqual((yield* Effect.flip(a.read(0))).code, "InvalidHandle")
    }))

  it.effect("does not create files when scoped acquisition cannot retain a handle", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      const scope = yield* Scope.make()
      yield* Scope.close(scope, Exit.void)
      const result = yield* Effect.exit(
        fs.open("/f", { access: "write", create: "exclusive" }).pipe(Scope.provide(scope))
      )
      assert.isTrue(Exit.isFailure(result))
      assert.strictEqual((yield* Effect.flip(fs.stat("/f"))).code, "NotFound")
      const liveScope = yield* Scope.make()
      const f = yield* fs.open("/f", { access: "write", create: "exclusive" }).pipe(Scope.provide(liveScope))
      yield* Scope.close(liveScope, Exit.void)
      assert.strictEqual((yield* Effect.flip(f.write(bytes()))).code, "InvalidHandle")
    }))

  it.effect("checks kind, access, exclusive creation and file bounds before changing content", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make({ maxFileBytes: 2 })
      const fs = yield* volume.caller()
      const f = yield* fs.open("/f", { access: "readWrite", create: "exclusive", mode: 0o400 })
      yield* f.write(bytes(1, 2, 3))
      assert.strictEqual((yield* Effect.flip(f.write(bytes(3)))).code, "FileTooLarge")
      const guest = yield* volume.caller({ identity: { uid: 0, gid: 0, groups: [], privileged: false } })
      assert.strictEqual(
        (yield* Effect.flip(guest.open("/f", { access: "write", truncate: true }))).code,
        "AccessDenied"
      )
      assert.deepStrictEqual(yield* f.pread(3, 0n), bytes(1, 2))
      assert.strictEqual(
        (yield* Effect.flip(fs.open("/f", { access: "write", create: "exclusive" }))).code,
        "AlreadyExists"
      )
      assert.strictEqual((yield* Effect.flip(fs.open("/", { access: "read" }))).code, "IsDirectory")
      assert.strictEqual((yield* Effect.flip(fs.stat("/f/.."))).code, "NotDirectory")
      assert.strictEqual((yield* Effect.flip(fs.stat("/f/"))).code, "NotDirectory")
      const read = yield* fs.open("/f", { access: "read" })
      assert.strictEqual((yield* Effect.flip(read.write(bytes()))).code, "InvalidHandle")
      assert.strictEqual((yield* Effect.flip(read.truncate(0n))).code, "InvalidHandle")
    }))
})
