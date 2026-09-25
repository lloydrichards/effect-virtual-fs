import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Testing, VirtualFileSystem as Vfs } from "../src/index.js"
import { exists, failure, GUEST, RECURSIVE } from "./support/caller.js"
import { pathText } from "./support/text.js"

describe("mkdir recursive", () => {
  it.effect("creates every missing directory in one change", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      const volume = yield* Vfs.Volume
      yield* fs.mkdir("/a")
      const changes = yield* Testing.collectChanges(yield* volume.watch(), 3)

      const result = yield* fs.mkdir("/a/b/c/d", RECURSIVE)
      const events = yield* changes

      assert.deepStrictEqual(
        yield* Effect.forEach(
          events,
          (change) => Effect.map(pathText(change.path), (path) => `${change._tag} ${path}`)
        ),
        ["Create /a/b", "Create /a/b/c", "Create /a/b/c/d"]
      )
      assert.strictEqual(result.reference, yield* fs.lookup("/a/b/c/d"))
      assert.strictEqual(result.directory.after, (yield* fs.stat("/a/b/c")).revision)
    }).pipe(Effect.scoped, Effect.provide(Testing.layer())))

  it.effect("creates nothing when a later directory fails", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller

      // The third directory is past the volume's entry limit.
      const error = yield* Effect.flip(fs.mkdir("/x/y/z", RECURSIVE))

      assert.deepStrictEqual(yield* failure(error), ["NoSpace", "/x/y/z"])
      assert.isFalse(yield* exists(fs, "/x"))
    }).pipe(Effect.provide(Testing.layer({ volume: { maxEntries: 2 } }))))

  it.effect("creates nothing when the caller cannot search a directory it just created", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* fs.mkdir("/work", { mode: 0o777 })
      yield* fs.chown("/work", { uid: GUEST.uid, gid: GUEST.gid })
      const guest = yield* Testing.callerAs(GUEST)

      const error = yield* Effect.flip(guest.mkdir("/work/sealed/inner", { recursive: true, mode: 0o600 }))

      assert.deepStrictEqual(yield* failure(error), ["AccessDenied", "/work/sealed/inner"])
      assert.isFalse(yield* exists(fs, "/work/sealed"))

      // The final directory is never searched, so its mode may lack owner search.
      yield* guest.mkdir("/work/sealed", { recursive: true, mode: 0o600 })
      assert.isTrue(yield* exists(fs, "/work/sealed"))
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("succeeds on an existing directory without a change", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* fs.mkdir("/a")
      const before = yield* fs.stat("/")

      const result = yield* fs.mkdir("/a", RECURSIVE)

      assert.strictEqual(result.reference, yield* fs.lookup("/a"))
      assert.deepStrictEqual(result.directory, { before: before.revision, after: before.revision })
      assert.strictEqual((yield* fs.stat("/")).revision, before.revision)
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("rejects a final file as existing and a file on the way as not a directory", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* fs.writeFile("/f", new Uint8Array(1), { access: "write", create: "exclusive" })

      assert.deepStrictEqual(yield* failure(yield* Effect.flip(fs.mkdir("/f", RECURSIVE))), ["AlreadyExists", "/f"])
      assert.deepStrictEqual(
        yield* failure(yield* Effect.flip(fs.mkdir("/f/g", RECURSIVE))),
        ["NotDirectory", "/f/g"]
      )
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("walks dot names instead of creating them", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller

      yield* fs.mkdir("/a/./b/../c", RECURSIVE)
      yield* fs.mkdir("/a/.", RECURSIVE)
      const before = (yield* fs.stat("/")).revision
      const up = yield* fs.mkdir("/new/..", RECURSIVE)

      assert.deepStrictEqual(
        yield* Effect.forEach(["/a/b", "/a/c", "/new"], (path) => exists(fs, path)),
        [true, true, true]
      )
      // A path that leaves the directory it created names the directory it ends on, and reports the change the
      // call made to that directory's parent.
      assert.strictEqual(up.reference, yield* fs.root)
      assert.deepStrictEqual(up.directory, { before, after: (yield* fs.stat("/")).revision })
      assert.notStrictEqual(up.directory.after, up.directory.before)
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("follows a symbolic link on the way and creates only the names the caller wrote", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* fs.mkdir("/real")
      yield* fs.symlink("/real", "/link")
      yield* fs.symlink("/nowhere/deeper", "/dangling")

      yield* fs.mkdir("/link/x/y", RECURSIVE)
      assert.isTrue(yield* exists(fs, "/real/x/y"))

      // A link to a directory is an existing directory.
      yield* fs.mkdir("/link", RECURSIVE)

      assert.deepStrictEqual(
        yield* failure(yield* Effect.flip(fs.mkdir("/dangling/x", RECURSIVE))),
        ["NotFound", "/dangling/x"]
      )
      assert.deepStrictEqual(
        yield* failure(yield* Effect.flip(fs.mkdir("/dangling", RECURSIVE))),
        ["NotFound", "/dangling"]
      )
      assert.isFalse(yield* exists(fs, "/nowhere"))
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("applies the mode to every directory it creates and the times to the final one", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller

      yield* fs.mkdir("/a/b", {
        recursive: true,
        mode: 0o777,
        times: { access: { kind: "value", nanoseconds: 5n }, modification: { kind: "value", nanoseconds: 7n } }
      })

      const a = yield* fs.stat("/a")
      const b = yield* fs.stat("/a/b")

      // The caller's umask of 0o022 applies to both.
      assert.deepStrictEqual([a.mode & 0o777, b.mode & 0o777], [0o755, 0o755])
      assert.deepStrictEqual([b.atimeNs, b.mtimeNs], [5n, 7n])
      assert.notStrictEqual(a.mtimeNs, 7n)
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("resolves a relative path from the caller's directory", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* fs.mkdir("/base")
      const inBase = yield* fs.withDirectory("/base")

      yield* inBase.mkdir("x/y", RECURSIVE)

      assert.isTrue(yield* exists(fs, "/base/x/y"))
    }).pipe(Effect.scoped, Effect.provide(Testing.layer())))
})
