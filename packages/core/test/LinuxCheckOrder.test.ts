import { assert, describe } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"
import { it } from "./TestEffect.js"

// Pins the check order the public API decision fixed for every verb: search permission on a directory before
// any name in it is looked up, then the name, trailing slashes and the structural rules, then write
// permission. Each expectation was read from Linux (node:24-alpine) as an unprivileged uid.

const GUEST = { uid: 1000, gid: 1000, groups: [], privileged: false } as const

const encode = (value: string) => new TextEncoder().encode(value)

// /ro (0o555, root) holds file x and directory d; /noexec (0o644, root) can be read but not searched and holds
// file f; /gfile and /gdir belong to the guest; /hard1 and /hard2 are one file.
const arrange = Effect.gen(function*() {
  const volume = yield* Vfs.make()
  const admin = yield* volume.caller({ umask: 0 })

  const write = (path: string) =>
    admin.writeFile(path, encode(path), { access: "write", create: "exclusive", mode: 0o644 })

  yield* admin.mkdir("/ro", { mode: 0o755 })
  yield* write("/ro/x")
  yield* admin.mkdir("/ro/d", { mode: 0o755 })
  yield* admin.chmod("/ro", 0o555)
  yield* admin.mkdir("/noexec", { mode: 0o755 })
  yield* write("/noexec/f")
  yield* admin.chmod("/noexec", 0o644)
  yield* write("/hard1")
  yield* admin.link("/hard1", "/hard2")
  yield* write("/gfile")
  yield* admin.mkdir("/gdir", { mode: 0o755 })
  yield* admin.chown("/gfile", { uid: GUEST.uid, gid: GUEST.gid })
  yield* admin.chown("/gdir", { uid: GUEST.uid, gid: GUEST.gid })
  const guest = yield* volume.caller({ identity: GUEST })

  return { admin, guest, volume }
})

// The code an operation fails with, or "OK".
const outcome = <A, E extends { readonly code: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.match(effect, { onFailure: (error): string => error.code, onSuccess: (): string => "OK" })

describe("a directory the caller cannot search reveals none of its names", () => {
  it.effect("through paths", () =>
    Effect.gen(function*() {
      const { guest } = yield* arrange

      assert.deepStrictEqual({
        mkdirExisting: yield* outcome(guest.mkdir("/noexec/f")),
        symlinkExisting: yield* outcome(guest.symlink("t", "/noexec/f")),
        linkExisting: yield* outcome(guest.link("/gfile", "/noexec/f")),
        rmdirMissing: yield* outcome(guest.rmdir("/noexec/missing")),
        unlinkMissing: yield* outcome(guest.unlink("/noexec/missing")),
        renameMissing: yield* outcome(guest.rename("/noexec/missing", "/gdir/x"))
      }, {
        mkdirExisting: "AccessDenied",
        symlinkExisting: "AccessDenied",
        linkExisting: "AccessDenied",
        rmdirMissing: "AccessDenied",
        unlinkMissing: "AccessDenied",
        renameMissing: "AccessDenied"
      })
    }))

  it.effect("through entries of a reference", () =>
    Effect.gen(function*() {
      const { admin, guest } = yield* arrange
      const noexec = yield* admin.lookup("/noexec")
      const at = (name: string) => Vfs.Entry(noexec, name)

      assert.deepStrictEqual({
        mkdirExisting: yield* outcome(guest.mkdir(at("f"))),
        mkdirMissing: yield* outcome(guest.mkdir(at("missing"))),
        rmdirMissing: yield* outcome(guest.rmdir(at("missing"))),
        unlinkMissing: yield* outcome(guest.unlink(at("missing")))
      }, {
        mkdirExisting: "AccessDenied",
        mkdirMissing: "AccessDenied",
        rmdirMissing: "AccessDenied",
        unlinkMissing: "AccessDenied"
      })
    }))
})

describe("trailing slashes are judged before write permission", () => {
  it.effect("in a directory the caller cannot write", () =>
    Effect.gen(function*() {
      const { guest } = yield* arrange

      assert.deepStrictEqual({
        unlinkFileSlash: yield* outcome(guest.unlink("/ro/x/")),
        unlinkDirectorySlash: yield* outcome(guest.unlink("/ro/d/")),
        linkOntoSlash: yield* outcome(guest.link("/gfile", "/ro/new/")),
        symlinkOntoSlash: yield* outcome(guest.symlink("t", "/ro/new/")),
        renameFileOntoSlash: yield* outcome(guest.rename("/gfile", "/ro/new/")),
        renameOntoItselfSlash: yield* outcome(guest.rename("/ro/x", "/ro/x/"))
      }, {
        unlinkFileSlash: "NotDirectory",
        unlinkDirectorySlash: "IsDirectory",
        linkOntoSlash: "NotFound",
        symlinkOntoSlash: "NotFound",
        renameFileOntoSlash: "NotDirectory",
        renameOntoItselfSlash: "NotDirectory"
      })
    }))
})

describe("rename's structural outcomes precede write permission", () => {
  it.effect("in directories the caller cannot write", () =>
    Effect.gen(function*() {
      const { guest } = yield* arrange

      assert.deepStrictEqual({
        ontoItself: yield* outcome(guest.rename("/ro/x", "/ro/x")),
        acrossHardLinks: yield* outcome(guest.rename("/hard1", "/hard2")),
        intoOwnSubtree: yield* outcome(guest.rename("/ro/d", "/ro/d/sub"))
      }, {
        ontoItself: "OK",
        acrossHardLinks: "OK",
        intoOwnSubtree: "InvalidArgument"
      })
    }))
})

describe("a removed directory held by a handle", () => {
  it.effect("takes no new children through the handle, and leaves no usage behind", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const fs = yield* volume.caller()
      yield* fs.mkdir("/a")
      const handle = yield* fs.openDirectory("/a")
      yield* fs.rmdir("/a")
      yield* fs.writeFile("/moved", new Uint8Array([9, 9]), { access: "write", create: "exclusive" })

      const created = yield* outcome(fs.mkdir(Vfs.Entry(handle, "orphan")))

      const written = yield* outcome(
        fs.writeFile(Vfs.Entry(handle, "f"), new Uint8Array([1, 2, 3]), { access: "write", create: "exclusive" })
      )

      const opened = yield* outcome(
        Effect.scoped(fs.open(Vfs.Entry(handle, "g"), { access: "write", create: "exclusive" }))
      )

      const moved = yield* outcome(fs.rename("/moved", Vfs.Entry(handle, "moved")))
      yield* handle.close

      assert.deepStrictEqual({ created, written, opened, moved }, {
        created: "NotFound",
        written: "NotFound",
        opened: "NotFound",
        moved: "NotFound"
      })
      assert.deepStrictEqual(yield* volume.usage, { entries: 1, usedBytes: 2n })
      assert.isTrue(Exit.isSuccess(yield* Effect.exit(fs.stat("/moved"))))
    }))
})

describe("entry names and no-follow targets", () => {
  it.effect("a string entry name with a lone surrogate fails as a string path does", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const fs = yield* volume.caller()

      assert.deepStrictEqual({
        viaPath: yield* outcome(fs.mkdir("/\uD800")),
        viaEntry: yield* outcome(fs.mkdir(Vfs.Entry("/", "\uD800"))),
        otherSurrogate: yield* outcome(fs.mkdir(Vfs.Entry("/", "\uDC00")))
      }, {
        viaPath: "InvalidPathEncoding",
        viaEntry: "InvalidPathEncoding",
        otherSurrogate: "InvalidPathEncoding"
      })
    }))

  it.effect("readFile and truncate refuse a symlink they do not follow, as open does", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const fs = yield* volume.caller()
      yield* fs.writeFile("/f", encode("x"), { access: "write", create: "exclusive" })
      yield* fs.symlink("f", "/fl")
      const target = Vfs.Target.Path({ path: "/fl", followFinalSymlink: false })

      assert.deepStrictEqual({
        open: yield* outcome(Effect.scoped(fs.open(target, { access: "read" }))),
        readFile: yield* outcome(fs.readFile(target)),
        truncate: yield* outcome(fs.truncate(target, 0n))
      }, { open: "SymlinkLoop", readFile: "SymlinkLoop", truncate: "SymlinkLoop" })
    }))
})
