import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Deferred, Effect, Exit, Fiber, pipe, Predicate, Result, Schema, Scope, Stream } from "effect"
import type * as Digest from "effect/crypto/Digest"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import * as TestClock from "effect/testing/TestClock"
import {
  Caller as CallerModule,
  LiveVolume,
  Testing,
  type VfsError as VfsErrorModule,
  VirtualFileSystem as Vfs
} from "../src/index.js"
import { GUEST, write } from "./support/caller.js"
import { entryNames, pathText, text } from "./support/text.js"

const bytes = (value: string) => new TextEncoder().encode(value)

const writeOptions = { access: "write", create: "exclusive" } as const

const fixture = Effect.gen(function*() {
  const owner = yield* Vfs.Caller
  yield* owner.mkdir("/tenant/child", { recursive: true })
  yield* owner.mkdir("/outside")
  yield* owner.writeFile("/tenant/file", bytes("inside"), writeOptions)
  yield* owner.writeFile("/outside/file", bytes("outside"), writeOptions)
  const caller = yield* owner.withRoot("/tenant")

  return { owner, caller }
})

describe("confined callers", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect("rebases absolute paths and symlinks and clamps parent traversal", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture
        yield* owner.symlink("/file", "/tenant/absolute")
        yield* owner.symlink("../../file", "/tenant/child/relative")

        for (const path of ["/file", "../../file", "/../../file", "/absolute", "/child/relative"]) {
          assert.strictEqual(text(yield* caller.readFile(path)), "inside")
        }

        assert.strictEqual((yield* Effect.flip(caller.readFile("/outside/file"))).code, "NotFound")
        assert.strictEqual(yield* pathText(yield* caller.realPath("/child/relative")), "/file")
        assert.deepStrictEqual(yield* caller.parent("/"), yield* caller.root)
        const cwd = yield* caller.withDirectory("/child")
        assert.strictEqual(text(yield* cwd.readFile("../../file")), "inside")
        assert.strictEqual(text(yield* cwd.readFile("/file")), "inside")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("rechecks deep handle ancestry after a trusted move and restoration", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture
        const nested = "/child/" + Array.from({ length: 256 }, () => "d").join("/")
        yield* caller.mkdir(nested, { recursive: true })
        yield* caller.writeFile(`${nested}/file`, bytes("deep"), writeOptions)
        const handle = yield* caller.open(`${nested}/file`, { access: "readWrite" })
        assert.strictEqual(text((yield* handle.pread(4, 0n)).bytes), "deep")
        yield* owner.rename("/tenant/child", "/outside/moved")
        assert.strictEqual((yield* Effect.flip(handle.pread(4, 0n))).code, "AccessDenied")
        assert.strictEqual((yield* Effect.flip(handle.pwrite(bytes("edit"), 0n))).code, "AccessDenied")
        yield* owner.rename("/outside/moved", "/tenant/child")
        assert.strictEqual(text((yield* handle.pread(4, 0n)).bytes), "deep")
        assert.strictEqual(yield* handle.pwrite(bytes("edit"), 0n), 4)
        assert.strictEqual(text(yield* caller.readFile(`${nested}/file`)), "edit")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("sees directories created earlier in the same path walk", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture

        for (const [active, prefix] of [[owner, "/tenant/ordinary"], [caller, "/confined"]] as const) {
          yield* active.mkdir(`${prefix}/child/../../${prefix.split("/").at(-1)}/sibling`, { recursive: true })
          assert.strictEqual((yield* active.stat(`${prefix}/child`)).kind, "directory")
          assert.strictEqual((yield* active.stat(`${prefix}/sibling`)).kind, "directory")
        }
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("confines recursive creation and preserves raw-byte names", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture
        yield* caller.mkdir("new/../../created/deep", { recursive: true })
        assert.strictEqual((yield* owner.stat("/tenant/created/deep")).kind, "directory")
        assert.strictEqual((yield* Effect.flip(owner.stat("/created"))).code, "NotFound")
        const rawName = new Uint8Array([0xff, 0xfe])
        const root = yield* caller.root
        yield* caller.writeFile(Vfs.Entry(root, rawName), bytes("raw"), writeOptions)
        assert.strictEqual(text(yield* caller.readFile(yield* caller.lookup(Vfs.Entry(root, rawName)))), "raw")
        assert.isTrue((yield* caller.readDirectory("/")).value.some((entry) =>
          entry.name.length === 2 && entry.name[0] === 0xff && entry.name[1] === 0xfe
        ))
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("rejects outside references, handles, path bases, and entry directories", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture
        const directory = (yield* owner.mkdir("/outside/subdir")).reference
        const base = yield* owner.openDirectory(directory)
        const file = yield* owner.lookup("/outside/file")
        const handle = yield* owner.open("/outside/file", { access: "read" })
        assert.strictEqual((yield* Effect.flip(caller.stat(file))).code, "AccessDenied")
        assert.strictEqual((yield* Effect.flip(caller.stat(handle))).code, "AccessDenied")
        assert.strictEqual(
          (yield* Effect.flip(caller.stat(Vfs.Target.Path({ path: "..", relativeTo: base })))).code,
          "AccessDenied"
        )
        assert.strictEqual((yield* Effect.flip(caller.mkdir(Vfs.Entry(directory, bytes("new"))))).code, "AccessDenied")
        assert.deepStrictEqual(entryNames(yield* owner.readDirectory(directory)), [])
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("follows root identity through rename and permanently invalidates deletion", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture
        const handle = yield* caller.open("/file", { access: "read" })
        yield* owner.rename("/tenant", "/relocated")
        assert.strictEqual(text(yield* caller.readFile("/file")), "inside")
        assert.strictEqual(yield* pathText(yield* caller.realPath("/child")), "/child")
        yield* owner.remove("/relocated", { recursive: true })
        yield* owner.mkdir("/tenant")
        assert.strictEqual((yield* Effect.flip(caller.root)).code, "ClosedCaller")
        assert.strictEqual((yield* Effect.flip(caller.readFile("/file"))).code, "ClosedCaller")
        assert.strictEqual((yield* Effect.flip(handle.read(1))).code, "InvalidHandle")
        yield* handle.close
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("revokes live references and direct handles outside the root and restores them on return", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture
        yield* caller.writeFile("/child/data", bytes("content"), writeOptions)
        const reference = yield* caller.lookup("/child/data")
        const handle = yield* caller.open(reference, { access: "readWrite" })
        const directory = yield* caller.openDirectory("/child")
        yield* owner.rename("/tenant/child", "/outside/child")
        assert.strictEqual((yield* Effect.flip(caller.stat(reference))).code, "AccessDenied")

        for (
          const operation of [handle.stat, handle.sync, handle.read(1), handle.seek(0n, "start"), handle.truncate(0n)]
        ) {
          assert.strictEqual((yield* Effect.flip(operation)).code, "AccessDenied")
        }

        assert.strictEqual((yield* Effect.flip(directory.stat)).code, "AccessDenied")
        yield* owner.rename("/outside/child", "/tenant/returned")
        assert.strictEqual(text((yield* handle.pread(20, 0n)).bytes), "content")
        assert.strictEqual((yield* caller.stat(reference)).kind, "file")
        assert.strictEqual((yield* directory.stat).kind, "directory")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("resolves directory handles through visible ancestors after restore and rename", () =>
      Effect.gen(function*() {
        const original = yield* Vfs.make()
        const source = yield* original.caller()
        yield* source.mkdir("/removed")
        yield* source.mkdir("/tenant/parent/child", { recursive: true })
        yield* source.rmdir("/removed")
        const volume = yield* Vfs.fromSnapshot(yield* original.snapshot)
        const owner = yield* volume.caller()
        const guest = yield* volume.caller({ identity: { uid: 9, gid: 9, groups: [], privileged: false } })
        const confined = yield* guest.withRoot("/tenant")
        const root = yield* confined.openDirectory("/")
        const child = yield* owner.openDirectory("/tenant/parent/child")
        const parent = yield* confined.openDirectory("/parent")
        assert.strictEqual(yield* pathText(yield* confined.realPath(root)), "/")
        yield* owner.chmod("/tenant/parent/child", 0)
        assert.strictEqual(yield* pathText(yield* confined.realPath(child)), "/parent/child")
        yield* owner.chmod("/tenant/parent", 0)
        assert.strictEqual((yield* Effect.flip(confined.realPath(child))).code, "AccessDenied")
        yield* owner.chmod("/tenant/parent", 0o755)
        yield* owner.rename("/tenant/parent", "/outside")
        assert.strictEqual((yield* Effect.flip(confined.realPath(child))).code, "AccessDenied")
        assert.strictEqual((yield* Effect.flip(owner.realPath(parent))).code, "AccessDenied")
        yield* owner.rename("/outside", "/tenant/returned")
        assert.strictEqual(yield* pathText(yield* confined.realPath(child)), "/returned/child")
        yield* owner.rmdir("/tenant/returned/child")
        assert.strictEqual((yield* Effect.flip(owner.realPath(child))).code, "NotFound")
        assert.strictEqual((yield* Effect.flip(confined.realPath(child))).code, "AccessDenied")
        assert.strictEqual((yield* Effect.flip(source.realPath(child))).code, "ForeignHandle")
        yield* child.close
        assert.strictEqual((yield* Effect.flip(owner.realPath(child))).code, "InvalidHandle")
      }))

    it.effect("retains imported handle restrictions even for an unrestricted caller", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture
        const handle = yield* caller.open("/file", { access: "read" })
        yield* owner.rename("/tenant/file", "/outside/moved")
        assert.strictEqual((yield* Effect.flip(owner.readFile(handle))).code, "AccessDenied")
        yield* handle.close
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("preserves imported handle authority when opening another handle from it", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture
        const original = yield* caller.open("/file", { access: "read" })
        const reopened = yield* owner.open(original, { access: "read" })
        yield* owner.rename("/tenant/file", "/outside/moved")
        assert.strictEqual((yield* Effect.flip(reopened.read(1))).code, "AccessDenied")
        yield* owner.rename("/outside/moved", "/tenant/returned")
        assert.strictEqual(text(yield* reopened.read(20)), "inside")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("preserves imported directory authority when deriving a caller", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture
        yield* caller.writeFile("/child/data", bytes("inside"), writeOptions)
        const original = yield* caller.openDirectory("/child")
        const derived = yield* owner.withDirectory(original)
        yield* owner.rename("/tenant/child", "/outside/moved")
        assert.strictEqual((yield* Effect.flip(derived.readFile("data"))).code, "AccessDenied")
        yield* owner.rename("/outside/moved", "/tenant/returned")
        assert.strictEqual(text(yield* derived.readFile("data")), "inside")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("selects the narrower visible root when deriving through an imported directory handle", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture
        yield* caller.writeFile("/child/file", bytes("child"), writeOptions)
        const narrower = yield* owner.withRoot("/tenant/child")
        const handle = yield* narrower.openDirectory("/")
        const derived = yield* caller.withDirectory(handle)
        assert.deepStrictEqual(yield* derived.root, yield* narrower.root)
        assert.strictEqual(text(yield* derived.readFile("/file")), "child")
        assert.strictEqual(text(yield* derived.readFile("../file")), "child")
        assert.deepStrictEqual(yield* derived.parent("/"), yield* derived.root)
        assert.strictEqual(yield* pathText(yield* derived.realPath("/file")), "/file")
        yield* owner.rename("/tenant/child", "/outside/moved")
        assert.strictEqual((yield* Effect.flip(derived.root)).code, "AccessDenied")
        yield* owner.rename("/outside/moved", "/tenant/returned")
        assert.strictEqual(text(yield* derived.readFile("/file")), "child")
        yield* owner.remove("/tenant", { recursive: true })
        assert.strictEqual((yield* Effect.flip(derived.root)).code, "ClosedCaller")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("retains imported ancestor boundaries when deriving a root and directory handle", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture
        yield* caller.writeFile("/child/data", bytes("inside"), writeOptions)
        const original = yield* caller.openDirectory("/child")
        const derivedRoot = yield* owner.withRoot(original)
        const reopened = yield* owner.openDirectory(original)
        yield* owner.rename("/tenant/child", "/outside/moved")
        assert.strictEqual((yield* Effect.flip(derivedRoot.readFile("/data"))).code, "AccessDenied")
        assert.strictEqual((yield* Effect.flip(reopened.stat)).code, "AccessDenied")
        yield* owner.rename("/outside/moved", "/tenant/returned")
        assert.strictEqual(text(yield* derivedRoot.readFile("/data")), "inside")
        assert.strictEqual((yield* reopened.stat).kind, "directory")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("rejects an outside path base even when an absolute path selects the confined root", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture
        const outside = yield* owner.openDirectory("/outside")
        assert.strictEqual(
          (yield* Effect.flip(caller.readFile(Vfs.Target.Path({ path: "/file", relativeTo: outside })))).code,
          "AccessDenied"
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("rejects traversal outside an imported base boundary before reading or creating", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture
        const base = yield* caller.openDirectory("/child")
        const escape = Vfs.Target.Path({ path: "../../outside/file", relativeTo: base })
        assert.strictEqual((yield* Effect.flip(owner.readFile(escape))).code, "AccessDenied")
        assert.strictEqual((yield* Effect.flip(owner.realPath(escape))).code, "AccessDenied")
        assert.strictEqual(
          (yield* Effect.flip(owner.mkdir(Vfs.Target.Path({ path: "../../outside/new", relativeTo: base })))).code,
          "AccessDenied"
        )
        assert.strictEqual((yield* Effect.flip(owner.stat("/outside/new"))).code, "NotFound")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("retains base authority on independently scoped handles acquired by relative path", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture
        yield* caller.writeFile("/child/data", bytes("inside"), writeOptions)
        const baseScope = yield* Scope.make()
        const base = yield* caller.openDirectory("/child").pipe(Scope.provide(baseScope))
        const opened = yield* owner.open(Vfs.Target.Path({ path: "data", relativeTo: base }), { access: "read" })
        yield* Scope.close(baseScope, Exit.void)
        assert.strictEqual(text((yield* opened.pread(20, 0n)).bytes), "inside")
        yield* owner.rename("/tenant/child", "/outside/moved")
        assert.strictEqual((yield* Effect.flip(opened.read(1))).code, "AccessDenied")
        yield* owner.rename("/outside/moved", "/tenant/returned")
        assert.strictEqual(text((yield* opened.pread(20, 0n)).bytes), "inside")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("rechecks imported directory authority while consuming a walk", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture
        yield* caller.mkdir("/child/a")
        yield* caller.mkdir("/child/z")
        yield* caller.writeFile("/child/z/secret", bytes("inside"), writeOptions)
        const base = yield* caller.openDirectory("/child")
        const seen: Array<string> = []

        const error = yield* Effect.flip(Stream.runForEach(owner.walk(base), (entry) =>
          Effect.gen(function*() {
            seen.push(text(entry.name))

            if (text(entry.name) === "a") yield* owner.rename("/tenant/child", "/outside/moved")
          })))

        assert.strictEqual(error.code, "AccessDenied")
        assert.isFalse(seen.includes("secret"))
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("retains imported base authority for absolute paths", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture
        const base = yield* caller.openDirectory("/child")
        yield* owner.rename("/tenant/child", "/outside/moved")
        assert.strictEqual(
          (yield* Effect.flip(owner.readFile(Vfs.Target.Path({ path: "/outside/file", relativeTo: base })))).code,
          "AccessDenied"
        )
        assert.strictEqual(
          (yield* Effect.flip(caller.readFile(Vfs.Target.Path({ path: "/file", relativeTo: base })))).code,
          "AccessDenied"
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("authorizes shared hard-linked objects independently without authorizing outside names", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture
        yield* owner.link("/tenant/file", "/outside/shared")
        const other = yield* owner.withRoot("/outside")
        const handle = yield* caller.open("/file", { access: "read" })
        assert.strictEqual(text(yield* other.readFile(handle)), "inside")
        yield* owner.unlink("/tenant/file")
        assert.strictEqual((yield* Effect.flip(handle.read(1))).code, "AccessDenied")
        assert.strictEqual((yield* Effect.flip(other.readFile(handle))).code, "AccessDenied")
        assert.strictEqual(text(yield* other.readFile("/shared")), "inside")
        yield* owner.link("/outside/shared", "/tenant/restored")
        assert.strictEqual(text(yield* other.readFile(handle)), "inside")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("keeps both caller boundaries on a handle acquired from a shared imported handle", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture
        yield* owner.link("/tenant/file", "/outside/shared")
        const other = yield* owner.withRoot("/outside")
        const original = yield* caller.open("/file", { access: "read" })
        const reopened = yield* other.open(original, { access: "read" })
        yield* original.close
        assert.strictEqual(text((yield* reopened.pread(20, 0n)).bytes), "inside")
        yield* owner.unlink("/outside/shared")
        assert.strictEqual((yield* Effect.flip(reopened.read(1))).code, "AccessDenied")
        yield* owner.link("/tenant/file", "/outside/restored")
        assert.strictEqual(text((yield* reopened.pread(20, 0n)).bytes), "inside")
        yield* owner.unlink("/tenant/file")
        assert.strictEqual((yield* Effect.flip(reopened.read(1))).code, "AccessDenied")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("retains imported entry-directory boundaries while following symlinks", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture
        yield* owner.symlink("../outside/file", "/tenant/relative")
        yield* owner.symlink("/outside/file", "/tenant/absolute")
        yield* owner.symlink("../outside/new", "/tenant/missing")
        yield* owner.symlink("/outside/new", "/tenant/missing-absolute")
        yield* owner.symlink("file", "/tenant/allowed")
        const handle = yield* caller.openDirectory("/")

        const directories = [
          Vfs.Target.Handle({ handle }),
          Vfs.Target.Path({ path: ".", relativeTo: handle })
        ]

        for (const directory of directories) {
          for (const name of ["relative", "absolute"]) {
            const entry = { directory, name }
            assert.strictEqual((yield* Effect.flip(owner.open(entry, { access: "read" }))).code, "AccessDenied")
            assert.strictEqual(
              (yield* Effect.flip(owner.open(entry, { access: "write", truncate: true }))).code,
              "AccessDenied"
            )
            assert.strictEqual(text(yield* owner.readFile("/outside/file")), "outside")
            assert.strictEqual(
              (yield* Effect.flip(owner.writeFile(entry, bytes("replaced"), { access: "write", truncate: true }))).code,
              "AccessDenied"
            )
            assert.strictEqual(text(yield* owner.readFile("/outside/file")), "outside")
          }

          const allowed = yield* owner.open({ directory, name: "allowed" }, { access: "read" })
          assert.strictEqual(text((yield* allowed.handle.pread(6, 0n)).bytes), "inside")

          for (const name of ["missing", "missing-absolute"]) {
            assert.strictEqual(
              (yield* Effect.flip(owner.open({ directory, name }, {
                access: "write",
                create: "ifMissing"
              }))).code,
              "AccessDenied"
            )
            assert.strictEqual(
              (yield* Effect.flip(owner.writeFile({ directory, name }, bytes("created"), {
                access: "write",
                create: "ifMissing"
              }))).code,
              "AccessDenied"
            )
          }

          yield* owner.writeFile({ directory, name: "allowed" }, bytes("inside"), {
            access: "write",
            truncate: true
          })
          assert.strictEqual(text(yield* caller.readFile("/file")), "inside")
        }

        assert.strictEqual(text(yield* owner.readFile("/outside/file")), "outside")
        assert.strictEqual((yield* Effect.flip(owner.stat("/outside/new"))).code, "NotFound")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("keeps ancestor boundaries when deriving a nested root", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture
        const nested = yield* caller.withRoot("/child")
        yield* nested.writeFile("/data", bytes("nested"), writeOptions)
        const handle = yield* nested.open("/data", { access: "read" })
        yield* owner.rename("/tenant/child", "/outside/child")
        assert.strictEqual((yield* Effect.flip(nested.root)).code, "AccessDenied")
        assert.strictEqual((yield* Effect.flip(handle.read(1))).code, "AccessDenied")
        yield* owner.rename("/outside/child", "/tenant/restored")
        assert.strictEqual(text(yield* nested.readFile("/data")), "nested")
        assert.strictEqual(text(yield* handle.read(20)), "nested")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("preserves independently scoped callers and handles after the creating scope closes", () =>
      Effect.gen(function*() {
        const owner = yield* Vfs.Caller
        yield* owner.mkdir("/tenant")
        yield* owner.writeFile("/tenant/file", bytes("inside"), writeOptions)
        const creatingScope = yield* Scope.make()
        const caller = yield* owner.withRoot("/tenant").pipe(Scope.provide(creatingScope))
        const child = yield* caller.withDirectory("/")
        const handle = yield* caller.open("/file", { access: "read" })
        yield* Scope.close(creatingScope, Exit.void)
        assert.strictEqual((yield* Effect.flip(caller.root)).code, "ClosedCaller")
        assert.strictEqual(text(yield* child.readFile("/file")), "inside")
        assert.strictEqual(text(yield* handle.read(20)), "inside")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("protects its own root against every removal form and rename", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture

        for (
          const operation of [
            Effect.asVoid(caller.remove("/", { recursive: true })),
            Effect.asVoid(caller.remove("/", { force: true })),
            Effect.asVoid(caller.rmdir("/")),
            Effect.asVoid(caller.rename("/", "/renamed"))
          ]
        ) {
          assert.strictEqual((yield* Effect.flip(Effect.asVoid(operation))).code, "NotPermitted")
        }

        assert.strictEqual(text(yield* owner.readFile("/tenant/file")), "inside")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("protects its root when dot components resolve to it", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture
        const expected = yield* caller.root

        for (const path of ["/.", "/child/..", "/../../", "child/../."]) {
          for (
            const operation of [
              Effect.asVoid(caller.remove(path, { recursive: true })),
              Effect.asVoid(caller.remove(path, { expected, recursive: true })),
              Effect.asVoid(caller.remove(path, { expected, force: true })),
              Effect.asVoid(caller.rmdir(path)),
              Effect.asVoid(caller.rename(path, "/new"))
            ]
          ) assert.strictEqual((yield* Effect.flip(operation)).code, "NotPermitted")
        }

        assert.strictEqual(text(yield* owner.readFile("/tenant/file")), "inside")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("keeps confined authority and handle state intact when durable commits reject changes", () =>
      Effect.gen(function*() {
        let outcome: LiveVolume.CommitOutcome = "committed"

        const { volume } = yield* LiveVolume.openImage(
          yield* LiveVolume.prepareEmptyImage(),
          ByteSize.kilobytes(64),
          () => Effect.succeed(outcome)
        )

        const owner = yield* volume.caller()
        yield* owner.mkdir("/tenant")
        yield* owner.mkdir("/outside")
        yield* owner.writeFile("/tenant/file", bytes("inside"), writeOptions)
        const caller = yield* owner.withRoot("/tenant")
        const handle = yield* caller.open("/file", { access: "readWrite" })
        const before = yield* handle.stat
        outcome = "rejected"
        assert.strictEqual((yield* Effect.flip(owner.rename("/tenant/file", "/outside/moved"))).code, "StorageRejected")
        assert.strictEqual((yield* Effect.flip(handle.pwrite(bytes("changed"), 0n))).code, "StorageRejected")
        assert.strictEqual((yield* Effect.flip(caller.mkdir("/new"))).code, "StorageRejected")
        outcome = "committed"
        assert.strictEqual(text((yield* handle.pread(20, 0n)).bytes), "inside")
        assert.deepStrictEqual(yield* handle.stat, before)
        assert.strictEqual((yield* Effect.flip(caller.stat("/new"))).code, "NotFound")
        yield* owner.rename("/tenant/file", "/outside/moved")
        assert.strictEqual((yield* Effect.flip(handle.read(1))).code, "AccessDenied")
      }))

    it.effect("uses stale expected references as identity guards and leaves replacements untouched", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture
        const expected = (yield* caller.mkdir("/temporary")).reference
        yield* owner.remove("/tenant/temporary")
        assert.strictEqual((yield* Effect.flip(owner.stat(expected))).code, "StaleReference")
        yield* caller.mkdir("/temporary")
        yield* caller.writeFile("/temporary/keep", bytes("replacement"), writeOptions)
        assert.strictEqual(
          (yield* Effect.flip(caller.remove("/temporary", { expected, recursive: true, force: true }))).code,
          "VolumeBusy"
        )
        assert.strictEqual(text(yield* caller.readFile("/temporary/keep")), "replacement")
        assert.isUndefined(yield* caller.remove("/missing", { expected, force: true }))
        assert.strictEqual((yield* Effect.flip(caller.remove("/missing", { expected }))).code, "NotFound")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("checks directory search permission before comparing an expected removal identity", () =>
      Effect.gen(function*() {
        const { owner } = yield* fixture
        yield* owner.mkdir("/tenant/private", { mode: 0o700 })
        const expected = (yield* owner.mkdir("/tenant/private/temporary")).reference
        yield* owner.remove("/tenant/private/temporary")
        yield* owner.mkdir("/tenant/private/temporary")
        yield* owner.writeFile("/tenant/private/temporary/keep", bytes("replacement"), writeOptions)
        const guest = yield* Testing.callerAs({ uid: 9, gid: 9, groups: [], privileged: false })
        const confined = yield* guest.withRoot("/tenant")

        const error = yield* Effect.flip(
          confined.remove("/private/temporary", { expected, recursive: true, force: true })
        )

        assert.strictEqual(error.code, "AccessDenied")
        assert.strictEqual(text(yield* owner.readFile("/tenant/private/temporary/keep")), "replacement")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("rejects forged and foreign expected references even with force", () =>
      Effect.gen(function*() {
        const { caller } = yield* fixture
        const other = yield* (yield* Vfs.make()).caller()
        const foreign = yield* other.root
        // The public brand alone must not grant authenticity in the volume token registry.
        const forged: Vfs.ObjectReference = { [CallerModule.ObjectReferenceId]: true }

        for (const path of ["/file", "/missing"]) {
          assert.strictEqual(
            (yield* Effect.flip(caller.remove(path, { expected: foreign, force: true }))).code,
            "ForeignReference"
          )
          assert.strictEqual(
            (yield* Effect.flip(caller.remove(path, { expected: forged, force: true }))).code,
            "InvalidReference"
          )
        }

        assert.strictEqual(text(yield* caller.readFile("/file")), "inside")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("refuses a replaced removal target without touching its replacement", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture
        const expected = (yield* caller.mkdir("/temporary")).reference
        yield* owner.rename("/tenant/temporary", "/tenant/original")
        yield* caller.mkdir("/temporary")
        yield* caller.writeFile("/temporary/keep", bytes("keep"), writeOptions)
        assert.strictEqual(
          (yield* Effect.flip(caller.remove("/temporary", { expected, recursive: true, force: true }))).code,
          "VolumeBusy"
        )
        assert.strictEqual(text(yield* caller.readFile("/temporary/keep")), "keep")
        yield* caller.remove("/original", { expected, recursive: true })
        assert.strictEqual((yield* Effect.flip(caller.stat("/original"))).code, "NotFound")
        assert.deepStrictEqual(entryNames(yield* caller.readDirectory("/temporary")), ["keep"])
      }).pipe(Effect.provide(Testing.layer())))
  })
})

describe("confined watch delivery", () => {
  const bytes = (value: string) => new TextEncoder().encode(value)

  const options = { access: "write", create: "exclusive" } as const

  const rendered = (changes: ReadonlyArray<Vfs.Change>) =>
    Effect.forEach(changes, (change) => Effect.map(pathText(change.path), (path) => `${change._tag} ${path}`))

  const setup = Effect.gen(function*() {
    const owner = yield* Vfs.Caller
    yield* owner.mkdir("/tenant/dir", { recursive: true })
    yield* owner.mkdir("/outside")
    yield* owner.writeFile("/tenant/file", bytes("initial"), options)

    return { owner, caller: yield* owner.withRoot("/tenant") }
  })

  describe("caller watch", () => {
    it.layer(BunCrypto.layer)((it) => {
      it.effect("filters outside changes before bounded capacity and rebases inside names", () =>
        Effect.gen(function*() {
          const { owner, caller } = yield* setup
          const stream = yield* caller.watch("/")

          for (let index = 0; index < 12; index++) yield* owner.mkdir(`/outside/${index}`)
          yield* owner.mkdir("/tenant/visible")
          assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(Stream.take(stream, 1))), ["Create /visible"])
        }).pipe(Effect.provide(Testing.layer({ volume: { maxWatchEvents: 3 } }))))

      it.effect("rebases queued events at publication across a later root rename", () =>
        Effect.gen(function*() {
          const { owner, caller } = yield* setup
          const stream = yield* caller.watch("/")
          yield* owner.mkdir("/tenant/before")
          yield* owner.rename("/tenant", "/moved")
          yield* owner.mkdir("/moved/after")
          assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(Stream.take(stream, 2))), [
            "Create /before",
            "Create /after"
          ])
        }).pipe(Effect.provide(Testing.layer())))

      it.effect("reports all authorized file aliases while excluding outside hard links", () =>
        Effect.gen(function*() {
          const { owner, caller } = yield* setup
          yield* owner.link("/tenant/file", "/tenant/alias")
          yield* owner.link("/tenant/file", "/outside/alias")
          const stream = yield* caller.watch("/file")
          yield* owner.writeFile("/tenant/file", bytes("changed"), { access: "write" })
          assert.deepStrictEqual((yield* rendered(yield* Stream.runCollect(Stream.take(stream, 2)))).sort(), [
            "Update /alias",
            "Update /file"
          ])
        }).pipe(Effect.provide(Testing.layer())))

      it.effect("reports removal when one watched hard-link alias is replaced by rename", () =>
        Effect.gen(function*() {
          const { owner, caller } = yield* setup
          yield* owner.link("/tenant/file", "/tenant/alias")
          yield* owner.writeFile("/tenant/source", bytes("replacement"), options)
          const stream = yield* caller.watch("/file")
          const resolved = yield* caller.watch("/file", { alias: "resolved" })
          yield* owner.rename("/tenant/source", "/tenant/file")
          yield* owner.writeFile("/tenant/alias", bytes("changed"), { access: "write" })
          yield* owner.remove("/tenant/alias")
          assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(stream)), [
            "Remove /file",
            "Update /alias",
            "Remove /alias"
          ])
          assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(resolved)), ["Remove /file"])
        }).pipe(Effect.provide(Testing.layer())))

      it.effect("resolved watches follow the selected alias through rename and end on its unlink", () =>
        Effect.gen(function*() {
          const { owner, caller } = yield* setup
          yield* owner.link("/tenant/file", "/tenant/alias")
          const stream = yield* caller.watch("/file", { alias: "resolved" })
          yield* owner.rename("/tenant/file", "/tenant/renamed")
          yield* owner.writeFile("/tenant/alias", bytes("changed"), { access: "write" })
          yield* owner.remove("/tenant/renamed")
          assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(stream)), [
            "Remove /file",
            "Create /renamed",
            "Update /renamed",
            "Remove /renamed"
          ])
        }).pipe(Effect.provide(Testing.layer())))

      it.effect("resolved watches do not select another alias when the original name is unlinked", () =>
        Effect.gen(function*() {
          const { owner, caller } = yield* setup
          yield* owner.link("/tenant/file", "/tenant/alias")
          const stream = yield* caller.watch("/file", { alias: "resolved" })
          yield* owner.remove("/tenant/file")
          yield* owner.link("/tenant/alias", "/tenant/file")
          assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(stream)), ["Remove /file"])
        }).pipe(Effect.provide(Testing.layer())))

      it.effect("ends with the last confined name when the watched object moves outside", () =>
        Effect.gen(function*() {
          const { owner, caller } = yield* setup
          const stream = yield* caller.watch("/dir")
          yield* owner.mkdir("/tenant/dir/child")
          yield* owner.rename("/tenant/dir", "/outside/dir")
          yield* owner.rename("/outside/dir", "/tenant/returned")
          assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(stream)), [
            "Create /dir/child",
            "Remove /dir"
          ])
        }).pipe(Effect.provide(Testing.layer())))

      it.effect("drains already authorized events before root removal reports ClosedCaller", () =>
        Effect.gen(function*() {
          const { owner, caller } = yield* setup
          const stream = yield* caller.watch("/")
          yield* owner.mkdir("/tenant/queued")
          yield* owner.remove("/tenant", { recursive: true })
          const first = yield* Stream.runCollect(Stream.take(stream, 1))
          assert.deepStrictEqual(yield* rendered(first), ["Create /queued"])
          assert.strictEqual((yield* Effect.flip(Stream.runDrain(stream))).code, "ClosedCaller")
        }).pipe(Effect.provide(Testing.layer())))

      it.effect("fails nested watches when their root leaves the ancestor boundary", () =>
        Effect.gen(function*() {
          const { owner, caller } = yield* setup
          const nested = yield* caller.withRoot("/dir")
          const stream = yield* nested.watch("/")
          yield* owner.rename("/tenant/dir", "/outside/dir")
          assert.strictEqual((yield* Effect.flip(Stream.runDrain(stream))).code, "AccessDenied")
        }).pipe(Effect.provide(Testing.layer())))

      it.effect("bounds terminal hard-link alias removal with one Rescan", () =>
        Effect.gen(function*() {
          const { owner, caller } = yield* setup

          for (let index = 0; index < 8; index++) yield* owner.link("/tenant/file", `/tenant/dir/alias-${index}`)
          yield* owner.remove("/tenant/file")
          const stream = yield* caller.watch("/dir/alias-0")
          yield* owner.remove("/tenant/dir", { recursive: true })
          const events = yield* Stream.runCollect(stream)
          assert.strictEqual(events.length, 1)
          assert.strictEqual(events[0]!._tag, "Rescan")
          assert.strictEqual(yield* pathText(events[0]!.path), "/dir/alias-7")
        }).pipe(Effect.provide(Testing.layer({ volume: { maxWatchEvents: 3 } }))))

      it.effect("applies recursive depth to directory children at publication", () =>
        Effect.gen(function*() {
          const { owner, caller } = yield* setup
          const recursive = yield* caller.watch("/")
          const shallow = yield* caller.watch("/", { recursive: false })
          yield* owner.mkdir("/tenant/direct")
          yield* owner.mkdir("/tenant/dir/deep")
          yield* owner.remove("/tenant/dir", { recursive: true })
          assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(Stream.take(recursive, 4))), [
            "Create /direct",
            "Create /dir/deep",
            "Remove /dir/deep",
            "Remove /dir"
          ])
          assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(Stream.take(shallow, 2))), [
            "Create /direct",
            "Remove /dir"
          ])
        }).pipe(Effect.provide(Testing.layer())))

      it.effect("resolved file aliases follow ancestor identity through directory renames", () =>
        Effect.gen(function*() {
          const { owner, caller } = yield* setup
          yield* owner.rename("/tenant/file", "/tenant/dir/file")
          yield* owner.link("/tenant/dir/file", "/tenant/alias")
          const stream = yield* caller.watch("/dir/file", { alias: "resolved" })
          yield* owner.rename("/tenant/dir", "/tenant/renamed")
          yield* owner.writeFile("/tenant/alias", bytes("changed"), { access: "write" })
          yield* owner.remove("/tenant/renamed/file")
          assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(stream)), [
            "Update /renamed/file",
            "Remove /renamed/file"
          ])
        }).pipe(Effect.provide(Testing.layer())))

      it.effect("retains imported handle authority while publishing another caller's authorized alias", () =>
        Effect.gen(function*() {
          const { owner, caller } = yield* setup
          yield* owner.mkdir("/second")
          yield* owner.link("/tenant/file", "/second/file")
          const second = yield* owner.withRoot("/second")
          const handle = yield* caller.open("/file", { access: "read" })
          const stream = yield* second.watch(handle)
          yield* owner.writeFile("/tenant/file", bytes("changed"), { access: "write" })
          yield* owner.remove("/tenant/file")
          assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(stream)), [
            "Update /file",
            "Remove /file"
          ])
        }).pipe(Effect.provide(Testing.layer())))

      it.effect("reports imported ancestor boundary loss after queued events drain", () =>
        Effect.gen(function*() {
          const { owner, caller } = yield* setup
          yield* owner.mkdir("/second")
          yield* owner.rename("/tenant/file", "/tenant/dir/file")
          yield* owner.link("/tenant/dir/file", "/second/file")
          const nested = yield* caller.withRoot("/dir")
          const second = yield* owner.withRoot("/second")
          const handle = yield* nested.open("/file", { access: "read" })
          const stream = yield* second.watch(handle)
          yield* owner.writeFile("/tenant/dir/file", bytes("changed"), { access: "write" })
          yield* owner.rename("/tenant/dir", "/outside/dir")
          assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(Stream.take(stream, 1))), ["Update /file"])
          assert.strictEqual((yield* Effect.flip(Stream.runDrain(stream))).code, "AccessDenied")
        }).pipe(Effect.provide(Testing.layer())))

      it.effect("rejects resolved file references without a selected alias", () =>
        Effect.gen(function*() {
          const { caller } = yield* setup
          const reference = yield* caller.lookup("/file")
          assert.strictEqual(
            (yield* Effect.flip(caller.watch(reference, { alias: "resolved" }))).code,
            "InvalidArgument"
          )
        }).pipe(Effect.provide(Testing.layer())))
    })
  })
})

describe("namespace semantics", () => {
  // Pins the check order the public API decision fixed for every verb: search permission on a directory before
  // any name in it is looked up, then the name, trailing slashes and the structural rules, then write
  // permission. Each expectation was read from Linux (node:24-alpine) as an unprivileged uid.

  const GUEST = { uid: 1000, gid: 1000, groups: [], privileged: false } as const

  const encode = (value: string) => new TextEncoder().encode(value)

  // /ro (0o555, root) holds file x and directory d; /noexec (0o644, root) can be read but not searched and holds
  // file f; /gfile and /gdir belong to the guest; /hard1 and /hard2 are one file.
  const arrange = Effect.gen(function*() {
    const volume = yield* Vfs.Volume
    const admin = yield* Vfs.Caller

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
    const guest = yield* Testing.callerAs(GUEST)

    return { admin, guest, volume }
  })

  // The code an operation fails with, or "OK".
  const outcome = <A, E extends { readonly code: string }, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.match(effect, { onFailure: (error): string => error.code, onSuccess: (): string => "OK" })

  describe("directory search and structural checks", () => {
    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should hide existing and missing names when path or reference operations lack search permission",
        () =>
          Effect.gen(function*() {
            const { admin, guest } = yield* arrange
            const noexec = yield* admin.lookup("/noexec")
            const at = (name: string) => Vfs.Entry(noexec, name)

            assert.deepStrictEqual({
              mkdirExisting: yield* outcome(guest.mkdir("/noexec/f")),
              symlinkExisting: yield* outcome(guest.symlink("t", "/noexec/f")),
              linkExisting: yield* outcome(guest.link("/gfile", "/noexec/f")),
              rmdirMissing: yield* outcome(guest.rmdir("/noexec/missing")),
              unlinkMissing: yield* outcome(guest.unlink("/noexec/missing")),
              renameMissing: yield* outcome(guest.rename("/noexec/missing", "/gdir/x")),
              entryMkdirExisting: yield* outcome(guest.mkdir(at("f"))),
              entryMkdirMissing: yield* outcome(guest.mkdir(at("missing"))),
              entryRmdirMissing: yield* outcome(guest.rmdir(at("missing"))),
              entryUnlinkMissing: yield* outcome(guest.unlink(at("missing")))
            }, {
              mkdirExisting: "AccessDenied",
              symlinkExisting: "AccessDenied",
              linkExisting: "AccessDenied",
              rmdirMissing: "AccessDenied",
              unlinkMissing: "AccessDenied",
              renameMissing: "AccessDenied",
              entryMkdirExisting: "AccessDenied",
              entryMkdirMissing: "AccessDenied",
              entryRmdirMissing: "AccessDenied",
              entryUnlinkMissing: "AccessDenied"
            })
          }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } })))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should check trailing slashes and rename structure before write permission when a directory is read-only",
        () =>
          Effect.gen(function*() {
            const { guest } = yield* arrange

            assert.deepStrictEqual({
              unlinkFileSlash: yield* outcome(guest.unlink("/ro/x/")),
              unlinkDirectorySlash: yield* outcome(guest.unlink("/ro/d/")),
              linkOntoSlash: yield* outcome(guest.link("/gfile", "/ro/new/")),
              symlinkOntoSlash: yield* outcome(guest.symlink("t", "/ro/new/")),
              renameFileOntoSlash: yield* outcome(guest.rename("/gfile", "/ro/new/")),
              renameOntoItselfSlash: yield* outcome(guest.rename("/ro/x", "/ro/x/")),
              ontoItself: yield* outcome(guest.rename("/ro/x", "/ro/x")),
              acrossHardLinks: yield* outcome(guest.rename("/hard1", "/hard2")),
              intoOwnSubtree: yield* outcome(guest.rename("/ro/d", "/ro/d/sub"))
            }, {
              unlinkFileSlash: "NotDirectory",
              unlinkDirectorySlash: "IsDirectory",
              linkOntoSlash: "NotFound",
              symlinkOntoSlash: "NotFound",
              renameFileOntoSlash: "NotDirectory",
              renameOntoItselfSlash: "NotDirectory",
              ontoItself: "OK",
              acrossHardLinks: "OK",
              intoOwnSubtree: "InvalidArgument"
            })
          }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } })))
      )
    })
  })

  describe("a removed directory held by a handle", () => {
    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should reject child creation without leaked usage when a removed directory handle remains open",
        () =>
          Effect.gen(function*() {
            const volume = yield* Vfs.Volume
            const fs = yield* Vfs.Caller
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
          }).pipe(Effect.provide(Testing.layer()))
      )
    })
  })

  describe("entry names and no-follow targets", () => {
    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should reject invalid path encoding when an entry name contains a lone surrogate",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller

            assert.deepStrictEqual({
              viaPath: yield* outcome(fs.mkdir("/\uD800")),
              viaEntry: yield* outcome(fs.mkdir(Vfs.Entry("/", "\uD800"))),
              otherSurrogate: yield* outcome(fs.mkdir(Vfs.Entry("/", "\uDC00")))
            }, {
              viaPath: "InvalidPathEncoding",
              viaEntry: "InvalidPathEncoding",
              otherSurrogate: "InvalidPathEncoding"
            })
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should reject a final symlink when readFile and truncate are told not to follow it",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            yield* fs.writeFile("/f", encode("x"), { access: "write", create: "exclusive" })
            yield* fs.symlink("f", "/fl")
            const target = Vfs.Target.Path({ path: "/fl", followFinalSymlink: false })

            assert.deepStrictEqual({
              open: yield* outcome(Effect.scoped(fs.open(target, { access: "read" }))),
              readFile: yield* outcome(fs.readFile(target)),
              truncate: yield* outcome(fs.truncate(target, 0n))
            }, { open: "SymlinkLoop", readFile: "SymlinkLoop", truncate: "SymlinkLoop" })
          }).pipe(Effect.provide(Testing.layer()))
      )
    })
  })
})

describe("failure sequences", () => {
  const Slot = Schema.Literals([0, 1, 2])

  const Command = Schema.Struct({
    operation: Schema.Literals(["create", "open", "close", "rename", "link", "unlink", "write"]),
    from: Slot,
    to: Slot
  })

  type Command = typeof Command.Type

  const Script = Schema.Array(Command).check(Schema.isMaxLength(20))

  const path = (slot: number) => `/f${slot}`

  const bytes = (value: number) => new Uint8Array([value])

  interface ObjectState {
    readonly reference: Vfs.ObjectReference
    value: number
  }

  // Every run exercises path reuse and last unlink; generated commands compose further transitions.
  const identityMotif: ReadonlyArray<Command> = [
    { operation: "create", from: 0, to: 0 },
    { operation: "open", from: 0, to: 0 },
    { operation: "rename", from: 0, to: 1 },
    { operation: "create", from: 0, to: 0 },
    { operation: "write", from: 0, to: 1 },
    { operation: "link", from: 1, to: 2 },
    { operation: "unlink", from: 1, to: 0 },
    { operation: "unlink", from: 2, to: 0 }
  ]

  const runIdentity = Effect.fnUntraced(function*(script: ReadonlyArray<Command>) {
    const volume = yield* Vfs.make()
    const caller = yield* volume.caller()
    const names = new Map<number, ObjectState>()
    const objects: Array<ObjectState> = []
    const handles = new Map<number, { object: ObjectState; handle: Vfs.FileHandle }>()
    const commands = [...identityMotif, ...script, { operation: "close", from: 0, to: 0 } as const]

    for (const [index, command] of commands.entries()) {
      const object = names.get(command.from)
      const retained = handles.get(command.from)

      switch (command.operation) {
        case "create": {
          if (object !== undefined) break
          const value = objects.length + 1
          yield* caller.writeFile(path(command.from), bytes(value), { access: "write", create: "exclusive" })
          const created = { reference: yield* caller.lookup(path(command.from)), value }
          assert.isTrue(objects.every((previous) => previous.reference !== created.reference))
          objects.push(created)
          names.set(command.from, created)
          break
        }

        case "open": {
          if (object === undefined || handles.has(command.to)) break
          const handle = yield* caller.open(path(command.from), { access: "readWrite" })
          handles.set(command.to, { object, handle })
          break
        }

        case "close": {
          if (retained === undefined) break
          yield* retained.handle.close
          handles.delete(command.from)
          assert.strictEqual((yield* Effect.flip(retained.handle.read(1))).code, "InvalidHandle")
          break
        }

        case "rename":
        case "link": {
          if (object === undefined || names.has(command.to)) break
          yield* command.operation === "rename"
            ? caller.rename(path(command.from), path(command.to))
            : caller.link(path(command.from), path(command.to))
          names.set(command.to, object)

          if (command.operation === "rename") names.delete(command.from)
          break
        }

        case "unlink": {
          if (object === undefined) break
          yield* caller.unlink(path(command.from))
          names.delete(command.from)
          break
        }

        case "write": {
          if (retained === undefined) break
          const value = 40 + command.to
          assert.strictEqual(yield* retained.handle.pwrite(bytes(value), 0n), 1)
          retained.object.value = value
          break
        }
      }

      const context = `command ${index}: ${command.operation} ${command.from} ${command.to}`
      assert.deepStrictEqual(
        entryNames(yield* caller.readDirectory("/")).sort(),
        [...names.keys()].map((s) => `f${s}`).sort(),
        context
      )

      for (const slot of [0, 1, 2]) {
        const expected = names.get(slot)

        if (expected === undefined) {
          assert.strictEqual((yield* Effect.flip(caller.lookup(path(slot)))).code, "NotFound", context)
        } else {
          assert.strictEqual(yield* caller.lookup(path(slot)), expected.reference, context)
          assert.deepStrictEqual(yield* caller.readFile(path(slot)), bytes(expected.value), context)
        }
      }

      let alive = 0

      for (const expected of objects) {
        const links = [...names.values()].filter((value) => value === expected).length
        const held = [...handles.values()].filter((value) => value.object === expected)

        if (links === 0 && held.length === 0) {
          assert.strictEqual((yield* Effect.flip(caller.stat(expected.reference))).code, "StaleReference", context)
          continue
        }

        alive++
        assert.strictEqual((yield* caller.stat(expected.reference)).nlink, links, context)

        for (const { handle } of held) {
          assert.deepStrictEqual((yield* handle.pread(1, 0n)).bytes, bytes(expected.value), context)
        }

        if (links === 0) {
          assert.strictEqual(
            (yield* Effect.flip(caller.open(expected.reference, { access: "read" }))).code,
            "StaleReference",
            context
          )
        } else {
          assert.deepStrictEqual(yield* caller.readFile(expected.reference), bytes(expected.value), context)
        }
      }

      assert.deepStrictEqual(yield* volume.usage, { usedBytes: BigInt(alive), entries: names.size }, context)
    }

    for (const { handle } of handles.values()) yield* handle.close
    assert.deepStrictEqual(yield* volume.usage, {
      usedBytes: BigInt(new Set(names.values()).size),
      entries: names.size
    })
  })

  const Rejection = Schema.Literals(["create", "link", "rename", "chmod", "truncate", "write"])

  const Rejections = Schema.Array(Rejection).check(Schema.isMaxLength(24))

  const rejectionMotif: ReadonlyArray<typeof Rejection.Type> = [
    "create",
    "link",
    "rename",
    "chmod",
    "truncate",
    "write"
  ]

  const runRejections = Effect.fnUntraced(function*(script: ReadonlyArray<typeof Rejection.Type>) {
    // Freeze timestamps so equality detects mutation rather than elapsed test time.
    yield* TestClock.setTime(0)
    const volume = yield* Vfs.make({ maxBytes: ByteSize.bytes(2) })
    const caller = yield* volume.caller()
    yield* caller.writeFile("/f", new Uint8Array([1, 2]), { access: "write", create: "exclusive" })
    const handle = yield* caller.open("/f", { access: "readWrite" })
    yield* handle.seek(2n, "start")
    const root = yield* caller.root
    const reference = yield* caller.lookup("/f")

    const state = Effect.gen(function*() {
      const content = yield* caller.readFile("/f")
      const listing = yield* caller.readDirectory(root)

      return {
        content,
        listing,
        root: yield* caller.stat(root),
        file: yield* caller.stat(reference),
        cursor: yield* handle.seek(0n, "current"),
        usage: yield* volume.usage
      }
    })

    const rejected = {
      create: { effect: caller.open("/f", { access: "write", create: "exclusive" }), code: "AlreadyExists" },
      link: { effect: caller.link("/f", "/f"), code: "AlreadyExists" },
      rename: { effect: caller.rename("/missing", "/f"), code: "NotFound" },
      chmod: { effect: caller.chmod("/f", -1), code: "InvalidArgument" },
      truncate: { effect: handle.truncate(3n), code: "NoSpace" },
      write: { effect: handle.write(bytes(3)), code: "NoSpace" }
    }

    for (const [index, operation] of [...rejectionMotif, ...script].entries()) {
      yield* handle.pwrite(bytes(10 + index), 0n)
      yield* caller.chmod("/f", index % 2 === 0 ? 0o600 : 0o644)
      yield* Effect.scoped(Effect.gen(function*() {
        const watch = yield* volume.watch()
        const before = yield* state
        const { effect, code } = rejected[operation]
        const error = yield* Effect.flip(effect)
        const context = `command ${index}: ${operation}`
        assert.strictEqual(error.code, code, context)
        assert.deepStrictEqual(yield* state, before, context)
        // A later committed event makes an unexpected rejection event observable without a sleep.
        yield* caller.mkdir("/sentinel")
        const events = yield* Stream.runCollect(Stream.take(watch, 1))

        const rendered = yield* Effect.forEach(
          events,
          (event) => Effect.map(pathText(event.path), (path) => `${event._tag} ${path}`)
        )

        assert.deepStrictEqual(rendered, ["Create /sentinel"], context)
      }))
      yield* caller.rmdir("/sentinel")
    }

    yield* handle.close
  })

  // Each property runs 100 complete filesystem scenarios under one Vitest deadline.
  describe("v1 failure sequences", { timeout: 15_000 }, () => {
    it.layer(BunCrypto.layer)((it) => {
      it.effect.prop(
        "should preserve object identity and retained content when generated names and handles change",
        { script: Script },
        ({ script }) => runIdentity(script),
        { arbitrary: { runs: 100, seed: 27701 } }
      )
      it.effect.prop(
        "should preserve committed state and emit no events when generated mutations are rejected",
        { script: Rejections },
        ({ script }) => runRejections(script),
        { arbitrary: { runs: 100, seed: 27702 } }
      )
    })
  })
})

describe("directory ordering", () => {
  describe("directory insertion order", () => {
    it.layer(BunCrypto.layer)((it) => {
      it.effect("should preserve live order and captured contents when deleted slots are compacted", () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.make()
          const caller = yield* volume.caller()
          const names = Array.from({ length: 80 }, (_, i) => `f${i}`)
          const bytes = new Uint8Array([1])

          for (const name of names) yield* caller.writeFile(`/${name}`, bytes, { access: "write", create: "exclusive" })
          const snapshot = yield* volume.snapshot

          for (const name of names.slice(0, 60)) yield* caller.unlink(`/${name}`)
          yield* caller.writeFile("/f65", new Uint8Array([2]), { access: "write", create: "never" })
          yield* caller.writeFile("/f1", bytes, { access: "write", create: "exclusive" })
          const decoder = new TextDecoder()
          assert.deepStrictEqual(
            (yield* caller.readDirectory("/")).value.map((entry) => decoder.decode(entry.name)),
            [...names.slice(60), "f1"]
          )
          const restored = yield* (yield* Vfs.fromSnapshot(snapshot)).caller()
          assert.deepStrictEqual(
            (yield* restored.readDirectory("/")).value.map((entry) => decoder.decode(entry.name)),
            [...names].sort()
          )
          assert.deepStrictEqual(yield* restored.readFile("/f65"), bytes)
          assert.deepStrictEqual(yield* caller.readFile("/f65"), new Uint8Array([2]))
        }))
    })
  })
})

describe("tree traversal", () => {
  // /tree holds b/ (with deep/leaf), a (a file of 3 bytes), and c, a link to b that a walk must not follow.
  const arrange = Effect.gen(function*() {
    const fs = yield* Vfs.Caller
    yield* fs.mkdir("/tree")
    yield* fs.mkdir("/tree/b")
    yield* fs.mkdir("/tree/b/deep")
    yield* write(fs, "/tree/b/deep/leaf")
    yield* write(fs, "/tree/a", 3)
    yield* fs.symlink("b", "/tree/c")

    return fs
  })

  // Each entry as its kind, path and depth.
  const describeEntry = (entry: Vfs.WalkEntry) =>
    Effect.map(pathText(entry.path), (path) => `${entry.kind} ${path} ${entry.depth}`)

  const collect = <E>(stream: Stream.Stream<Vfs.WalkEntry, E>) =>
    Effect.flatMap(Stream.runCollect(stream), (entries) => Effect.forEach(entries, describeEntry))

  const failure = (error: Vfs.WalkFailure) =>
    Effect.map(pathText(error.path), (path) => [error.code, error.field, path] as const)

  describe("walk", () => {
    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should report each directory before its entries, in the byte order of their names when using pre-order traversal",
        () =>
          Effect.gen(function*() {
            const fs = yield* arrange

            assert.deepStrictEqual(yield* collect(fs.walk("/tree")), [
              "file a 1",
              "directory b 1",
              "directory b/deep 2",
              "file b/deep/leaf 3",
              "symlink c 1"
            ])
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should report each directory after its entries when walking in post-order",
        () =>
          Effect.gen(function*() {
            const fs = yield* arrange

            assert.deepStrictEqual(yield* collect(fs.walk("/tree", { order: "post" })), [
              "file a 1",
              "file b/deep/leaf 3",
              "directory b/deep 2",
              "directory b 1",
              "symlink c 1"
            ])
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should order names by their bytes, not their text when names have different byte and text order",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            const root = yield* fs.root

            for (const name of [new Uint8Array([0xff]), new TextEncoder().encode("b"), new TextEncoder().encode("B")]) {
              yield* fs.mkdir(Vfs.Entry(root, name))
            }

            const names = yield* Stream.runCollect(Stream.map(fs.walk(root), (entry) => Array.from(entry.name)))

            assert.deepStrictEqual(names, [[0x42], [0x62], [0xff]])
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should name each entry by a reference and the directory it was listed in when entries are listed from parent references",
        () =>
          Effect.gen(function*() {
            const fs = yield* arrange
            const entries = yield* Stream.runCollect(fs.walk("/tree"))
            const deep = entries.find((entry) => text(entry.name) === "deep")

            assert.isDefined(deep)
            assert.strictEqual(deep.reference, yield* fs.lookup("/tree/b/deep"))
            assert.strictEqual(deep.directory, yield* fs.lookup("/tree/b"))
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should walk from a reference with the same relative paths when a reference is the starting point",
        () =>
          Effect.gen(function*() {
            const fs = yield* arrange

            assert.deepStrictEqual(
              yield* collect(fs.walk(yield* fs.lookup("/tree/b"))),
              ["directory deep 1", "file deep/leaf 2"]
            )
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should follow a final symbolic link at the root, as a path does, and no link below it when the root is a symbolic link",
        () =>
          Effect.gen(function*() {
            const fs = yield* arrange

            assert.deepStrictEqual(yield* collect(fs.walk("/tree/c")), ["directory deep 1", "file deep/leaf 2"])

            const error = yield* Effect.flip(
              Stream.runDrain(fs.walk(Vfs.Target.Path({ path: "/tree/c", followFinalSymlink: false })))
            )

            assert.deepStrictEqual(yield* failure(error), ["NotDirectory", undefined, "/tree/c"])
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should fail once an entry lies deeper than maxDepth, naming it when an entry exceeds maxDepth",
        () =>
          Effect.gen(function*() {
            const fs = yield* arrange
            const entries: Array<string> = []

            const error = yield* Effect.flip(
              Stream.runForEach(fs.walk("/tree", { maxDepth: 2 }), (entry) =>
                Effect.map(describeEntry(entry), (line) => {
                  entries.push(line)
                }))
            )

            // The entries before the one that crossed the bound are all handed on.
            assert.deepStrictEqual(entries, ["file a 1", "directory b 1", "directory b/deep 2"])
            assert.deepStrictEqual(yield* failure(error), ["LimitExceeded", "maxDepth", "/tree/b/deep/leaf"])
            assert.strictEqual((yield* collect(fs.walk("/tree", { maxDepth: 3 }))).length, 5)
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should fail at the first entry past maxEntries or maxBytes when an entry exceeds maxEntries or maxBytes",
        () =>
          Effect.gen(function*() {
            const fs = yield* arrange

            const entries = yield* Effect.flip(Stream.runDrain(fs.walk("/tree", { maxEntries: 2 })))
            assert.deepStrictEqual(yield* failure(entries), ["LimitExceeded", "maxEntries", "/tree/b/deep"])

            // The file holds three bytes, the leaf one: the leaf is the fourth byte.
            const bytes = yield* Effect.flip(Stream.runDrain(fs.walk("/tree", { maxBytes: ByteSize.bytes(3) })))
            assert.deepStrictEqual(yield* failure(bytes), ["LimitExceeded", "maxBytes", "/tree/b/deep/leaf"])

            // The link's one-byte target counts as well.
            assert.strictEqual(
              (yield* collect(fs.walk("/tree", { maxEntries: 5, maxBytes: ByteSize.bytes(5) }))).length,
              5
            )
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should read no directory past maxDepth in a post-order walk when a post-order walk reaches maxDepth",
        () =>
          Effect.gen(function*() {
            const fs = yield* arrange
            const seen: Array<string> = []

            const error = yield* Effect.flip(
              Stream.runForEach(
                fs.walk("/tree", { order: "post", maxDepth: 1 }),
                (entry) =>
                  Effect.map(describeEntry(entry), (line) => {
                    seen.push(line)
                  })
              )
            )

            assert.deepStrictEqual(seen, ["file a 1"])
            assert.deepStrictEqual(yield* failure(error), ["LimitExceeded", "maxDepth", "/tree/b/deep"])

            // A directory past the bound that the caller may not read still fails on the bound, since it is never read.
            yield* fs.chmod("/tree/b/deep", 0o000)
            const guest = yield* Testing.callerAs(GUEST)
            const denied = yield* Effect.flip(Stream.runDrain(guest.walk("/tree", { order: "post", maxDepth: 1 })))
            assert.deepStrictEqual(yield* failure(denied), ["LimitExceeded", "maxDepth", "/tree/b/deep"])

            // Within the bound, the deepest directory is read and its entry is the first past it.
            const leaf = yield* Effect.flip(Stream.runDrain(fs.walk("/tree", { order: "post", maxDepth: 2 })))
            assert.deepStrictEqual(yield* failure(leaf), ["LimitExceeded", "maxDepth", "/tree/b/deep/leaf"])
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should fail at the first entry past maxEntries or maxBytes in a post-order walk when a post-order walk exceeds entry or byte limits",
        () =>
          Effect.gen(function*() {
            const fs = yield* arrange

            const entries = yield* Effect.flip(Stream.runDrain(fs.walk("/tree", { order: "post", maxEntries: 2 })))
            assert.deepStrictEqual(yield* failure(entries), ["LimitExceeded", "maxEntries", "/tree/b/deep"])

            const bytes = yield* Effect.flip(
              Stream.runDrain(fs.walk("/tree", { order: "post", maxBytes: ByteSize.bytes(3) }))
            )

            assert.deepStrictEqual(yield* failure(bytes), ["LimitExceeded", "maxBytes", "/tree/b/deep/leaf"])
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should reject malformed options when it runs", () =>
        Effect.gen(function*() {
          const fs = yield* arrange
          // A negative bound type-checks; the schema rejects it.
          const error = yield* Effect.flip(Stream.runDrain(fs.walk("/tree", { maxDepth: -1 })))

          assert.deepStrictEqual(yield* failure(error), ["InvalidArgument", undefined, "/tree"])
        }).pipe(Effect.provide(Testing.layer())))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should skip the entries of a directory that went away when it was listed",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            yield* fs.mkdir("/tree")
            yield* fs.mkdir("/tree/a")
            yield* write(fs, "/tree/a/x")
            yield* fs.mkdir("/tree/b")
            yield* write(fs, "/tree/b/y")
            const seen: Array<string> = []

            // Reading /tree/a ends the first pull, so /tree/b is removed before the walk reads it.
            yield* Stream.runForEach(fs.walk("/tree"), (entry) =>
              Effect.gen(function*() {
                seen.push(yield* describeEntry(entry))

                if (text(entry.name) === "a") {
                  yield* fs.unlink("/tree/b/y")
                  yield* fs.rmdir("/tree/b")
                }
              }))

            assert.deepStrictEqual(seen, ["directory a 1", "file a/x 2", "directory b 1"])
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should not follow a directory renamed out of the tree when it was listed",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            yield* fs.mkdir("/keep")
            yield* fs.mkdir("/work")
            yield* fs.mkdir("/work/a")
            yield* write(fs, "/work/a/x")
            yield* fs.mkdir("/work/z")
            yield* write(fs, "/work/z/k")
            const seen: Array<string> = []

            // Reading /work/a ends the first pull, so /work/z moves out before the walk reads it.
            yield* Stream.runForEach(fs.walk("/work"), (entry) =>
              Effect.gen(function*() {
                seen.push(yield* describeEntry(entry))

                if (text(entry.name) === "a") yield* fs.rename("/work/z", "/keep/z")
              }))

            assert.deepStrictEqual(seen, ["directory a 1", "file a/x 2", "directory z 1"])
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should not follow its root renamed away when it was listed", () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          yield* fs.mkdir("/work")
          yield* fs.mkdir("/work/a")
          yield* write(fs, "/work/a/x")
          yield* fs.mkdir("/work/b")
          yield* write(fs, "/work/b/y")
          const seen: Array<string> = []

          // Reading /work/a ends the first pull, so /work moves away before the walk reads /work/b, which the walk
          // reaches through the name /work and so no longer reaches.
          yield* Stream.runForEach(fs.walk("/work"), (entry) =>
            Effect.gen(function*() {
              seen.push(yield* describeEntry(entry))

              if (text(entry.name) === "a") yield* fs.rename("/work", "/keep")
            }))

          assert.deepStrictEqual(seen, ["directory a 1", "file a/x 2", "directory b 1"])
        }).pipe(Effect.provide(Testing.layer())))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should refuse to descend below a directory it may read but not search, as POSIX does when a caller can read but cannot search a directory",
        () =>
          Effect.gen(function*() {
            const fs = yield* arrange
            yield* fs.chmod("/tree/b", 0o444)
            const guest = yield* Testing.callerAs(GUEST)
            const seen: Array<string> = []

            const error = yield* Effect.flip(
              Stream.runForEach(guest.walk("/tree"), (entry) =>
                Effect.map(describeEntry(entry), (line) => {
                  seen.push(line)
                }))
            )

            // Listing /tree/b names its entries; reaching /tree/b/deep needs search permission on /tree/b.
            assert.deepStrictEqual(seen, ["file a 1", "directory b 1", "directory b/deep 2"])
            assert.deepStrictEqual(yield* failure(error), ["AccessDenied", undefined, "/tree/b/deep"])
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should fail on a directory it may not read, naming it under the root's path when a caller cannot read a directory",
        () =>
          Effect.gen(function*() {
            const fs = yield* arrange
            yield* fs.chmod("/tree/b", 0o311)
            const guest = yield* Testing.callerAs(GUEST)
            const seen: Array<string> = []

            const error = yield* Effect.flip(
              Stream.runForEach(guest.walk("/tree"), (entry) =>
                Effect.map(describeEntry(entry), (line) => {
                  seen.push(line)
                }))
            )

            assert.deepStrictEqual(seen, ["file a 1", "directory b 1"])
            assert.deepStrictEqual(yield* failure(error), ["AccessDenied", undefined, "/tree/b"])

            // A reference root names the path below it.
            const below = yield* Effect.flip(Stream.runDrain(guest.walk(yield* fs.lookup("/tree"))))
            assert.deepStrictEqual(yield* failure(below), ["AccessDenied", undefined, "b"])
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should refresh no access time when a walk observes directories", () =>
        Effect.gen(function*() {
          const fs = yield* arrange
          const before = yield* fs.stat("/tree/b")
          yield* TestClock.adjust("1 second")

          yield* Stream.runDrain(fs.walk("/tree"))
          assert.strictEqual((yield* fs.stat("/tree/b")).atimeNs, before.atimeNs)

          // A listing of the same directory would.
          yield* fs.readDirectory("/tree/b")
          assert.notStrictEqual((yield* fs.stat("/tree/b")).atimeNs, before.atimeNs)
        }).pipe(Effect.provide(Testing.layer())))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should report no entries or fail when the root is empty or missing", () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          yield* fs.mkdir("/empty")

          assert.deepStrictEqual(yield* collect(fs.walk("/empty")), [])
          assert.deepStrictEqual(
            yield* failure(yield* Effect.flip(Stream.runDrain(fs.walk("/missing")))),
            ["NotFound", undefined, "/missing"]
          )
        }).pipe(Effect.provide(Testing.layer())))
    })
  })
})

describe("mutation revisions", () => {
  const name = (value: string) => new TextEncoder().encode(value)

  describe("mutation revisions", () => {
    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should omit references and revisions when encoding snapshot version 1",
        () =>
          Effect.gen(function*() {
            const volume = yield* Vfs.Volume
            const fs = yield* Vfs.Caller
            const before = yield* Vfs.encodeSnapshot(yield* volume.snapshot)
            const root = yield* fs.root
            entryNames(yield* fs.readDirectory(root))
            yield* fs.stat(yield* fs.lookup(Vfs.Entry(root, name("f"))))
            const after = yield* Vfs.encodeSnapshot(yield* volume.snapshot)
            assert.deepStrictEqual(after, before)
            const encoded = new TextDecoder().decode(after)
            assert.isFalse(encoded.includes("revision"))
            assert.isFalse(encoded.includes("objectReference"))

            const restored = yield* Vfs.fromSnapshot(yield* volume.snapshot)
            const restoredFs = yield* restored.caller()
            const restoredRoot = yield* restoredFs.root
            assert.notStrictEqual(restoredRoot, root)
            assert.strictEqual((yield* Effect.flip(fs.stat(restoredRoot))).code, "ForeignReference")
            assert.strictEqual((yield* Effect.flip(restoredFs.stat(root))).code, "ForeignReference")
          }).pipe(
            Effect.provide(
              Testing.layer({ fixture: { entries: [{ kind: "file", path: "/f", bytes: new Uint8Array([1]) }] } })
            )
          )
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should distinguish content and metadata revisions when the clock is fixed",
        () =>
          Effect.gen(function*() {
            yield* TestClock.setTime(0)
            const fs = yield* Vfs.Caller
            const root = yield* fs.root
            const rootBefore = yield* fs.readDirectory(root)
            const file = yield* fs.open("/f", { access: "readWrite", create: "exclusive" })
            const reference = yield* fs.lookup(Vfs.Entry(root, name("f")))
            const created = yield* fs.stat(reference)
            assert.isTrue((yield* fs.readDirectory(root)).revision > rootBefore.revision)

            yield* file.write(new Uint8Array([1, 2]))
            const written = yield* fs.stat(reference)
            assert.isTrue(written.revision > created.revision)
            yield* file.pwrite(new Uint8Array([3, 4]), 0n)
            const sameSize = yield* fs.stat(reference)
            assert.isTrue(sameSize.revision > written.revision)
            yield* fs.chmod("/f", 0o600)
            const changedMode = yield* fs.stat(reference)
            assert.isTrue(changedMode.revision > sameSize.revision)
            yield* fs.truncate("/f", 1n)
            const truncated = yield* fs.stat(reference)
            assert.isTrue(truncated.revision > changedMode.revision)
            yield* fs.chown("/f", { uid: 7 })
            const changedOwner = yield* fs.stat(reference)
            assert.isTrue(changedOwner.revision > truncated.revision)
            yield* fs.utimes("/f", {
              access: { kind: "value", nanoseconds: 1n },
              modification: { kind: "value", nanoseconds: 2n }
            })
            const changedTimes = yield* fs.stat(reference)
            assert.isTrue(changedTimes.revision > changedOwner.revision)
            yield* fs.link("/f", "/alias")
            const alias = yield* fs.lookup(Vfs.Entry(root, name("alias")))
            assert.strictEqual(alias, reference)
            assert.isTrue((yield* fs.stat(alias)).revision > changedTimes.revision)
            yield* file.close
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should preserve revisions when reads, rejected mutations, or no-op branches occur",
        () =>
          Effect.gen(function*() {
            yield* TestClock.setTime(0)
            const fs = yield* Vfs.Caller
            yield* fs.writeFile("/f", new Uint8Array([1]), { access: "write", create: "exclusive" })
            const root = yield* fs.root
            const file = yield* fs.lookup(Vfs.Entry(root, name("f")))
            const before = yield* fs.stat(file)
            yield* fs.readFile("/f")
            assert.strictEqual((yield* fs.stat(file)).revision, before.revision)
            yield* fs.writeFile("/f", new Uint8Array(), { access: "write" })
            assert.strictEqual((yield* fs.stat(file)).revision, before.revision)
            yield* fs.chown("/f", {})
            assert.strictEqual((yield* fs.stat(file)).revision, before.revision)
            yield* fs.utimes("/f", { access: { kind: "omit" }, modification: { kind: "omit" } })
            assert.strictEqual((yield* fs.stat(file)).revision, before.revision)
            yield* Effect.flip(fs.chmod("/f", -1))
            assert.strictEqual((yield* fs.stat(file)).revision, before.revision)
            const directoryBefore = yield* fs.readDirectory(root)
            entryNames(yield* fs.readDirectory(root))
            assert.strictEqual((yield* fs.readDirectory(root)).revision, directoryBefore.revision)
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should advance both directories and the moved object when renaming across directories",
        () =>
          Effect.gen(function*() {
            yield* TestClock.setTime(0)
            const fs = yield* Vfs.Caller
            yield* fs.mkdir("/a")
            yield* fs.mkdir("/b")
            yield* fs.writeFile("/a/f", new Uint8Array([1]), { access: "write", create: "exclusive" })
            const root = yield* fs.root
            const a = yield* fs.lookup(Vfs.Entry(root, name("a")))
            const b = yield* fs.lookup(Vfs.Entry(root, name("b")))
            const file = yield* fs.lookup(Vfs.Entry(a, name("f")))
            const beforeA = yield* fs.readDirectory(a)
            const beforeB = yield* fs.readDirectory(b)
            const beforeFile = yield* fs.stat(file)
            yield* fs.rename("/a/f", "/b/f")
            assert.isTrue((yield* fs.readDirectory(a)).revision > beforeA.revision)
            assert.isTrue((yield* fs.readDirectory(b)).revision > beforeB.revision)
            assert.isTrue((yield* fs.stat(file)).revision > beforeFile.revision)
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should advance directory revisions when entries are created, removed, or replaced",
        () =>
          Effect.gen(function*() {
            yield* TestClock.setTime(0)
            const fs = yield* Vfs.Caller
            const root = yield* fs.root
            const initial = yield* fs.readDirectory(root)
            yield* fs.symlink("old", "/entry")
            const created = yield* fs.readDirectory(root)
            assert.isTrue(created.revision > initial.revision)
            const oldReference = yield* fs.lookup(Vfs.Entry(root, name("entry")))
            yield* fs.writeFile("/entry", new Uint8Array([1]), {
              access: "write",
              create: "ifMissing",
              replaceFinalSymlink: true
            })
            const replaced = yield* fs.readDirectory(root)
            assert.isTrue(replaced.revision > created.revision)
            assert.strictEqual((yield* Effect.flip(fs.stat(oldReference))).code, "StaleReference")
            yield* fs.unlink("/entry")
            assert.isTrue((yield* fs.readDirectory(root)).revision > replaced.revision)
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should advance parent and surviving object revisions when links change",
        () =>
          Effect.gen(function*() {
            yield* TestClock.setTime(0)
            const fs = yield* Vfs.Caller
            const root = yield* fs.root
            const beforeMkdir = yield* fs.readDirectory(root)
            yield* fs.mkdir("/directory")
            const afterMkdir = yield* fs.readDirectory(root)
            assert.isTrue(afterMkdir.revision > beforeMkdir.revision)

            yield* fs.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
            const file = yield* fs.lookup(Vfs.Entry(root, name("file")))
            const beforeLinkDirectory = yield* fs.readDirectory(root)
            const beforeLinkFile = yield* fs.stat(file)
            yield* fs.link("/file", "/alias")
            assert.isTrue((yield* fs.readDirectory(root)).revision > beforeLinkDirectory.revision)
            assert.isTrue((yield* fs.stat(file)).revision > beforeLinkFile.revision)

            const beforeUnlinkDirectory = yield* fs.readDirectory(root)
            const beforeUnlinkFile = yield* fs.stat(file)
            yield* fs.unlink("/file")
            assert.strictEqual(yield* fs.lookup(Vfs.Entry(root, name("alias"))), file)
            assert.isTrue((yield* fs.readDirectory(root)).revision > beforeUnlinkDirectory.revision)
            const surviving = yield* fs.stat(file)
            assert.isTrue(surviving.revision > beforeUnlinkFile.revision)
            assert.strictEqual(surviving.nlink, 1)
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should advance the parent revision when entry mutations share a directory",
        () =>
          Effect.gen(function*() {
            yield* TestClock.setTime(0)
            const fs = yield* Vfs.Caller
            yield* fs.mkdir("/p")
            yield* fs.mkdir("/p/d")
            yield* fs.writeFile("/p/sibling", new Uint8Array([1]), { access: "write", create: "exclusive" })
            const root = yield* fs.root
            const parent = yield* fs.lookup(Vfs.Entry(root, name("p")))
            const sibling = yield* fs.lookup(Vfs.Entry(parent, name("sibling")))
            const siblingRevision = (yield* fs.stat(sibling)).revision
            const parentRevision = () => Effect.map(fs.readDirectory(parent), (observation) => observation.revision)

            const beforeRmdir = yield* parentRevision()
            yield* fs.rmdir("/p/d")
            const afterRmdir = yield* parentRevision()
            assert.isTrue(afterRmdir > beforeRmdir)

            yield* fs.writeFile("/p/a", new Uint8Array([2]), { access: "write", create: "exclusive" })
            const afterWrite = yield* parentRevision()
            assert.isTrue(afterWrite > afterRmdir)

            const opened = yield* fs.open("/p/x", { access: "write", create: "exclusive" })
            yield* opened.close
            const afterOpen = yield* parentRevision()
            assert.isTrue(afterOpen > afterWrite)

            const moved = yield* fs.lookup(Vfs.Entry(parent, name("a")))
            const displaced = yield* fs.lookup(Vfs.Entry(parent, name("x")))
            const movedBefore = (yield* fs.stat(moved)).revision
            yield* fs.rename("/p/a", "/p/b")
            const afterRename = yield* parentRevision()
            assert.isTrue(afterRename > afterOpen)
            const movedAfterRename = (yield* fs.stat(moved)).revision
            assert.isTrue(movedAfterRename > movedBefore)
            assert.strictEqual(yield* fs.lookup(Vfs.Entry(parent, name("b"))), moved)

            yield* fs.rename("/p/b", "/p/x")
            assert.isTrue((yield* parentRevision()) > afterRename)
            assert.strictEqual(yield* fs.lookup(Vfs.Entry(parent, name("x"))), moved)
            assert.isTrue((yield* fs.stat(moved)).revision > movedAfterRename)
            assert.strictEqual((yield* Effect.flip(fs.stat(displaced))).code, "StaleReference")
            assert.strictEqual((yield* fs.stat(sibling)).revision, siblingRevision)
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should preserve a target revision when another hard-link name is unlinked",
        () =>
          Effect.gen(function*() {
            yield* TestClock.setTime(0)
            const fs = yield* Vfs.Caller
            yield* fs.writeFile("/f", new Uint8Array([1]), { access: "write", create: "exclusive" })
            yield* fs.link("/f", "/alias")
            const root = yield* fs.root
            const reference = yield* fs.lookup(Vfs.Entry(root, name("f")))
            assert.strictEqual(yield* fs.lookup(Vfs.Entry(root, name("alias"))), reference)
            const linked = yield* fs.stat(reference)
            assert.strictEqual(linked.nlink, 2)

            yield* fs.unlink("/alias")
            const unlinked = yield* fs.stat(reference)
            assert.isTrue(unlinked.revision > linked.revision)
            assert.strictEqual(unlinked.nlink, 1)
            assert.strictEqual(yield* fs.lookup(Vfs.Entry(root, name("f"))), reference)

            assert.deepStrictEqual(yield* fs.readFile("/f"), new Uint8Array([1]))
            assert.strictEqual((yield* fs.stat(reference)).revision, unlinked.revision)
            assert.strictEqual((yield* fs.stat(reference)).revision, unlinked.revision)
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should preserve revisions when a mutation fails", () =>
        Effect.gen(function*() {
          yield* TestClock.setTime(0)
          const fs = yield* Vfs.Caller
          yield* fs.mkdir("/p")
          yield* fs.mkdir("/p/existing")
          yield* fs.writeFile("/p/sibling", new Uint8Array([1]), { access: "write", create: "exclusive" })
          const root = yield* fs.root
          const parent = yield* fs.lookup(Vfs.Entry(root, name("p")))
          const sibling = yield* fs.lookup(Vfs.Entry(parent, name("sibling")))
          const parentBefore = (yield* fs.readDirectory(parent)).revision
          const siblingBefore = (yield* fs.stat(sibling)).revision
          const rootBefore = (yield* fs.readDirectory(root)).revision

          assert.strictEqual((yield* Effect.flip(fs.chmod("/p/missing", 0o600))).code, "NotFound")
          assert.strictEqual((yield* Effect.flip(fs.mkdir("/p/existing"))).code, "AlreadyExists")
          assert.strictEqual((yield* Effect.flip(fs.rename("/p/missing", "/p/moved"))).code, "NotFound")

          assert.strictEqual((yield* fs.readDirectory(parent)).revision, parentBefore)
          assert.strictEqual((yield* fs.stat(sibling)).revision, siblingBefore)
          assert.strictEqual((yield* fs.readDirectory(root)).revision, rootBefore)
          assert.strictEqual((yield* Effect.flip(fs.lookup(Vfs.Entry(parent, name("moved"))))).code, "NotFound")
        }).pipe(Effect.provide(Testing.layer())))
    })
  })
})

describe("path and reference operations", () => {
  // Path-addressed and reference-addressed verbs share one mutation body, but each family keeps its own
  // validation order and error codes. Each row pins what both families report for the same situation, so a
  // difference is recorded here instead of being lost or "fixed" when the bodies merge. A failure reads as its
  // code, followed by the path it names when it names one. Errors carry paths as bytes, so an unencodable
  // string input is named by its replacement encoding.

  const name = (value: string) => new TextEncoder().encode(value)

  type FsError = VfsErrorModule.VfsError

  type Execution = NonNullable<Vfs.VolumeOptions["execution"]>

  interface Fixture {
    readonly execution: Execution
    readonly admin: Vfs.Caller
    readonly guest: Vfs.Caller
    readonly root: Vfs.ObjectReference
    readonly dir: Vfs.ObjectReference
    readonly file: Vfs.ObjectReference
    // A directory that was removed after its reference was taken.
    readonly gone: Vfs.ObjectReference
    // World-writable and sticky, holding a file and an empty directory the guest does not own.
    readonly sticky: Vfs.ObjectReference
  }

  // Builds /dir, /dir/existing, /file, a removed /gone, and /sticky holding file and subdir. The root stays
  // 0o755 and owned by uid 0, so the guest can search it but not write it.
  const arrange = (execution: Execution) =>
    Effect.gen(function*() {
      const admin = yield* Vfs.Caller
      const guest = yield* Testing.callerAs(GUEST)
      const root = yield* admin.root
      const dir = (yield* admin.mkdir(Vfs.Entry(root, name("dir")))).reference
      yield* admin.mkdir(Vfs.Entry(dir, name("existing")))
      const file = yield* admin.open(Vfs.Entry(root, name("file")), { access: "write", create: "exclusive" })
      yield* file.handle.close
      const gone = (yield* admin.mkdir(Vfs.Entry(root, name("gone")))).reference
      yield* admin.rmdir(Vfs.Entry(root, name("gone")))
      const sticky = (yield* admin.mkdir(Vfs.Entry(root, name("sticky")), { mode: 0o1777 })).reference
      const owned = yield* admin.open(Vfs.Entry(sticky, name("file")), { access: "write", create: "exclusive" })
      yield* owned.handle.close
      yield* admin.mkdir(Vfs.Entry(sticky, name("subdir")))

      return { execution, admin, guest, root, dir, file: file.reference, gone, sticky } satisfies Fixture
    }).pipe(Effect.provide(Testing.layer({ volume: { execution }, caller: { umask: 0 } })))

  interface Row {
    readonly scenario: string
    // A row may build its own volume when the fixture's cannot express the situation.
    readonly path: (fixture: Fixture) => Effect.Effect<unknown, FsError, Digest.Digest | SecureRandom.SecureRandom>
    readonly reference: (fixture: Fixture) => Effect.Effect<unknown, FsError, Digest.Digest | SecureRandom.SecureRandom>
    // Confirms a successful operation took effect, on the fixture it ran against, for the family that ran.
    readonly check?: (
      fixture: Fixture,
      family: "path" | "reference"
    ) => Effect.Effect<unknown, FsError, Digest.Digest | SecureRandom.SecureRandom>
    readonly expected: { readonly path: string | number; readonly reference: string | number }
  }

  const report = (error: FsError): Effect.Effect<string> =>
    "path" in error
      ? Effect.map(pathText(error.path), (path) => `${error.code} at ${path ?? "<undefined>"}`)
      : Effect.succeed(error.code)

  // Checks for rows that succeed, each reading the entry the operation should have changed.
  const kindAt = (path: string, kind: Vfs.Metadata["kind"]) => ({ admin }: Fixture) =>
    Effect.map(
      admin.stat(Vfs.Target.Path({ path: path, followFinalSymlink: false })),
      (metadata) => assert.strictEqual(metadata.kind, kind)
    )

  const linksAt = (path: string, nlink: number) => ({ admin }: Fixture) =>
    Effect.map(
      admin.stat(Vfs.Target.Path({ path: path, followFinalSymlink: false })),
      (metadata) => assert.strictEqual(metadata.nlink, nlink)
    )

  const targetAt = (path: string, target: string) => ({ admin }: Fixture) =>
    Effect.map(admin.readLink(path), (actual) => assert.strictEqual(new TextDecoder().decode(actual), target))

  const missingAt = (path: string) => ({ admin }: Fixture) =>
    Effect.map(
      Effect.result(admin.stat(Vfs.Target.Path({ path: path, followFinalSymlink: false }))),
      (found) => assert.strictEqual(Result.isFailure(found) ? found.failure.code : "present", "NotFound")
    )

  const outcome = Effect.fnUntraced(function*(row: Row, family: "path" | "reference", execution: Execution) {
    const fixture = yield* arrange(execution)
    const acted = yield* Effect.result(row[family](fixture))

    if (Result.isFailure(acted)) return yield* report(acted.failure)

    if (Predicate.isNumber(row.expected[family])) return acted.success

    if (row.check === undefined) return "ok"
    const checked = yield* Effect.result(row.check(fixture, family))

    return Result.isFailure(checked) ? `ok, but the check failed with ${yield* report(checked.failure)}` : "ok"
  })

  const mkdirRows: ReadonlyArray<Row> = [
    {
      scenario: "creates a new entry",
      path: ({ admin }) => admin.mkdir("/dir/new"),
      reference: ({ admin, dir }) => admin.mkdir(Vfs.Entry(dir, name("new"))),
      check: kindAt("/dir/new", "directory"),
      expected: { path: "ok", reference: "ok" }
    },
    {
      scenario: "rejects an existing name",
      path: ({ admin }) => admin.mkdir("/dir/existing"),
      reference: ({ admin, dir }) => admin.mkdir(Vfs.Entry(dir, name("existing"))),
      expected: { path: "AlreadyExists at /dir/existing", reference: "AlreadyExists" }
    },
    {
      scenario: "treats a dot name as existing on paths but invalid on references",
      path: ({ admin }) => admin.mkdir("/dir/."),
      reference: ({ admin, dir }) => admin.mkdir(Vfs.Entry(dir, name("."))),
      expected: { path: "AlreadyExists at /dir/.", reference: "InvalidArgument" }
    },
    {
      scenario: "treats a dot-dot name as existing on paths but invalid on references",
      path: ({ admin }) => admin.mkdir("/dir/.."),
      reference: ({ admin, dir }) => admin.mkdir(Vfs.Entry(dir, name(".."))),
      expected: { path: "AlreadyExists at /dir/..", reference: "InvalidArgument" }
    },
    {
      scenario: "accepts a trailing slash on paths, where a reference name cannot hold one",
      path: ({ admin }) => admin.mkdir("/dir/new/"),
      reference: ({ admin, dir }) => admin.mkdir(Vfs.Entry(dir, name("new/"))),
      check: kindAt("/dir/new", "directory"),
      expected: { path: "ok", reference: "InvalidArgument" }
    },
    {
      scenario: "rejects a parent that is a file",
      path: ({ admin }) => admin.mkdir("/file/new"),
      reference: ({ admin, file }) => admin.mkdir(Vfs.Entry(file, name("new"))),
      expected: { path: "NotDirectory at /file/new", reference: "NotDirectory" }
    },
    {
      scenario: "reports a removed parent as missing on paths and stale on references",
      path: ({ admin }) => admin.mkdir("/gone/new"),
      reference: ({ admin, gone }) => admin.mkdir(Vfs.Entry(gone, name("new"))),
      expected: { path: "NotFound at /gone/new", reference: "StaleReference" }
    },
    {
      // #186 decision 8: the directory resolves before a reserved name is reported, on both families.
      scenario: "resolves the directory before a reserved name on both families",
      path: ({ admin }) => admin.mkdir("/gone/."),
      reference: ({ admin, gone }) => admin.mkdir(Vfs.Entry(gone, name("."))),
      expected: { path: "NotFound at /gone/.", reference: "StaleReference" }
    },
    {
      // #186 decision 5: an existing name is reported before write permission, as Linux does.
      scenario: "reports an existing name before an unwritable parent",
      path: ({ guest }) => guest.mkdir("/dir"),
      reference: ({ guest, root }) => guest.mkdir(Vfs.Entry(root, name("dir"))),
      expected: { path: "AlreadyExists at /dir", reference: "AlreadyExists" }
    },
    {
      // #186 decisions 5 and 7: a reserved name is reported before write permission, with each family's code.
      scenario: "reports a reserved name before an unwritable parent, as existing on paths and invalid on entries",
      path: ({ guest }) => guest.mkdir("/."),
      reference: ({ guest, root }) => guest.mkdir(Vfs.Entry(root, name("."))),
      expected: { path: "AlreadyExists at /.", reference: "InvalidArgument" }
    },
    {
      scenario: "rejects an invalid mode before an existing name",
      path: ({ admin }) => admin.mkdir("/dir/existing", { mode: -1 }),
      reference: ({ admin, dir }) => admin.mkdir(Vfs.Entry(dir, name("existing")), { mode: -1 }),
      expected: { path: "InvalidArgument at /dir/existing", reference: "InvalidArgument" }
    }
  ]

  // A recursive mkdir walks a path as path resolution does, so it creates what an entry cannot name: a missing
  // parent, or a dot name it treats as the directory it names.
  const mkdirRecursiveRows: ReadonlyArray<Row> = [
    {
      scenario: "creates missing parents on paths, where an entry names one child",
      path: ({ admin }) => admin.mkdir("/dir/a/b", { recursive: true }),
      reference: ({ admin, dir }) => admin.mkdir(Vfs.Entry(dir, name("a")), { recursive: true }),
      check: (fixture, family) => kindAt(family === "path" ? "/dir/a/b" : "/dir/a", "directory")(fixture),
      expected: { path: "ok", reference: "ok" }
    },
    {
      scenario: "accepts an existing directory, even in an unwritable parent",
      path: ({ guest }) => guest.mkdir("/dir", { recursive: true }),
      reference: ({ guest, root }) => guest.mkdir(Vfs.Entry(root, name("dir")), { recursive: true }),
      expected: { path: "ok", reference: "ok" }
    },
    {
      scenario: "walks a dot name on paths but rejects it on references",
      path: ({ admin }) => admin.mkdir("/dir/.", { recursive: true }),
      reference: ({ admin, dir }) => admin.mkdir(Vfs.Entry(dir, name(".")), { recursive: true }),
      expected: { path: "ok", reference: "InvalidArgument" }
    },
    {
      scenario: "rejects an existing file",
      path: ({ admin }) => admin.mkdir("/file", { recursive: true }),
      reference: ({ admin, root }) => admin.mkdir(Vfs.Entry(root, name("file")), { recursive: true }),
      expected: { path: "AlreadyExists at /file", reference: "AlreadyExists" }
    },
    {
      scenario: "rejects a parent that is a file",
      path: ({ admin }) => admin.mkdir("/file/x", { recursive: true }),
      reference: ({ admin, file }) => admin.mkdir(Vfs.Entry(file, name("x")), { recursive: true }),
      expected: { path: "NotDirectory at /file/x", reference: "NotDirectory" }
    },
    {
      scenario: "recreates a removed parent on paths, where its reference is stale",
      path: ({ admin }) => admin.mkdir("/gone/x", { recursive: true }),
      reference: ({ admin, gone }) => admin.mkdir(Vfs.Entry(gone, name("x")), { recursive: true }),
      check: kindAt("/gone/x", "directory"),
      expected: { path: "ok", reference: "StaleReference" }
    },
    {
      scenario: "denies a missing directory in an unwritable parent",
      path: ({ guest }) => guest.mkdir("/new", { recursive: true }),
      reference: ({ guest, root }) => guest.mkdir(Vfs.Entry(root, name("new")), { recursive: true }),
      expected: { path: "AccessDenied at /new", reference: "AccessDenied" }
    }
  ]

  const linkRows: ReadonlyArray<Row> = [
    {
      scenario: "links a file under a new name",
      path: ({ admin }) => admin.link("/file", "/dir/new"),
      reference: ({ admin, file, dir }) => admin.link(file, Vfs.Entry(dir, name("new"))),
      check: linksAt("/file", 2),
      expected: { path: "ok", reference: "ok" }
    },
    {
      scenario: "rejects a directory source",
      path: ({ admin }) => admin.link("/dir", "/new"),
      reference: ({ admin, dir, root }) => admin.link(dir, Vfs.Entry(root, name("new"))),
      expected: { path: "IsDirectory at /dir", reference: "IsDirectory" }
    },
    {
      scenario: "rejects an existing destination",
      path: ({ admin }) => admin.link("/file", "/dir/existing"),
      reference: ({ admin, file, dir }) => admin.link(file, Vfs.Entry(dir, name("existing"))),
      expected: { path: "AlreadyExists at /dir/existing", reference: "AlreadyExists" }
    },
    {
      scenario: "treats a dot destination as existing on paths but invalid on references",
      path: ({ admin }) => admin.link("/file", "/dir/."),
      reference: ({ admin, file, dir }) => admin.link(file, Vfs.Entry(dir, name("."))),
      expected: { path: "AlreadyExists at /dir/.", reference: "InvalidArgument" }
    },
    {
      // #186 decision 9: a trailing slash on a missing destination asks for a directory that does not exist.
      scenario: "reports a slashed missing destination as missing on paths and invalid on entries",
      path: ({ admin }) => admin.link("/file", "/dir/new/"),
      reference: ({ admin, file, dir }) => admin.link(file, Vfs.Entry(dir, name("new/"))),
      expected: { path: "NotFound at /dir/new/", reference: "InvalidArgument" }
    },
    {
      scenario: "reports an unlinked source as missing on paths and stale on references",
      path: Effect.fnUntraced(function*({ admin }) {
        yield* admin.unlink("/file")
        yield* admin.link("/file", "/dir/new")
      }),
      reference: ({ admin, root, file, dir }) =>
        Effect.scoped(Effect.gen(function*() {
          // An open handle keeps the unlinked file alive, so only the link count says it is gone.
          yield* admin.open(file, { access: "read" })
          yield* admin.unlink(Vfs.Entry(root, name("file")))
          yield* admin.link(file, Vfs.Entry(dir, name("new")))
        })),
      expected: { path: "NotFound at /file", reference: "StaleReference" }
    },
    {
      // #186 decision 8: the source resolves before the destination name on both families.
      scenario: "checks the source before the destination name on both families",
      path: ({ admin }) => admin.link("/dir", "/dir/."),
      reference: ({ admin, dir }) => admin.link(dir, Vfs.Entry(dir, name("."))),
      expected: { path: "IsDirectory at /dir", reference: "IsDirectory" }
    },
    {
      scenario: "denies an unwritable destination directory",
      path: ({ guest }) => guest.link("/file", "/new"),
      reference: ({ guest, file, root }) => guest.link(file, Vfs.Entry(root, name("new"))),
      expected: { path: "AccessDenied at /new", reference: "AccessDenied" }
    }
  ]

  // Its byte limit sits below an eight-byte link target.
  const smallVolume = (execution: Execution) =>
    Vfs.Caller.pipe(
      Effect.provide(Testing.layer({ volume: { execution, maxBytes: ByteSize.bytes(4) } })),
      Effect.orDie
    )

  const symlinkRows: ReadonlyArray<Row> = [
    {
      scenario: "creates a link to any target",
      path: ({ admin }) => admin.symlink("/missing", "/dir/new"),
      reference: ({ admin, dir }) => admin.symlink("/missing", Vfs.Entry(dir, name("new"))),
      check: targetAt("/dir/new", "/missing"),
      expected: { path: "ok", reference: "ok" }
    },
    {
      scenario: "rejects an existing name",
      path: ({ admin }) => admin.symlink("/missing", "/dir/existing"),
      reference: ({ admin, dir }) => admin.symlink("/missing", Vfs.Entry(dir, name("existing"))),
      expected: { path: "AlreadyExists at /dir/existing", reference: "AlreadyExists" }
    },
    {
      scenario: "treats a dot name as existing on paths but invalid on references",
      path: ({ admin }) => admin.symlink("/missing", "/dir/."),
      reference: ({ admin, dir }) => admin.symlink("/missing", Vfs.Entry(dir, name("."))),
      expected: { path: "AlreadyExists at /dir/.", reference: "InvalidArgument" }
    },
    {
      // #186 decision 9: a trailing slash on a missing name asks for a directory that does not exist.
      scenario: "reports a slashed missing name as missing on paths and invalid on entries",
      path: ({ admin }) => admin.symlink("/missing", "/dir/new/"),
      reference: ({ admin, dir }) => admin.symlink("/missing", Vfs.Entry(dir, name("new/"))),
      expected: { path: "NotFound at /dir/new/", reference: "InvalidArgument" }
    },
    {
      // #186 decision 6: a bad symbolic link target is named on both families, since the target is the argument that failed.
      // An error names only a path a BytePath can hold, and none holds a NUL.
      scenario: "rejects a target holding a NUL byte, naming no path on either family",
      path: ({ admin }) => admin.symlink("a\0", "/dir/new"),
      reference: ({ admin, dir }) => admin.symlink("a\0", Vfs.Entry(dir, name("new"))),
      expected: { path: "InvalidArgument", reference: "InvalidArgument" }
    },
    {
      // #186 decision 8: the target is checked before coordination on both families, so it outranks a reserved name
      // and a stale directory alike.
      scenario: "checks the target before the directory and the name on both families",
      // A lone surrogate cannot be encoded, which only the target check reports.
      path: ({ admin }) => admin.symlink("\uD800", "/gone/new"),
      reference: ({ admin, gone }) => admin.symlink("\uD800", Vfs.Entry(gone, name("."))),
      expected: { path: "InvalidPathEncoding at \uFFFD", reference: "InvalidPathEncoding at \uFFFD" }
    },
    {
      // #186 decisions 5 and 7: a reserved name is reported before write permission, with each family's code.
      scenario: "reports a reserved name before an unwritable parent, as existing on paths and invalid on entries",
      path: ({ guest }) => guest.symlink("/missing", "/."),
      reference: ({ guest, root }) => guest.symlink("/missing", Vfs.Entry(root, name("."))),
      expected: { path: "AlreadyExists at /.", reference: "InvalidArgument" }
    },
    {
      scenario: "reports a removed parent as missing on paths and stale on references",
      path: ({ admin }) => admin.symlink("/missing", "/gone/new"),
      reference: ({ admin, gone }) => admin.symlink("/missing", Vfs.Entry(gone, name("new"))),
      expected: { path: "NotFound at /gone/new", reference: "StaleReference" }
    },
    {
      scenario: "reports an existing name before a path's trailing slash",
      path: ({ admin }) => admin.symlink("/missing", "/dir/existing/"),
      reference: ({ admin, dir }) => admin.symlink("/missing", Vfs.Entry(dir, name("existing/"))),
      expected: { path: "AlreadyExists at /dir/existing/", reference: "InvalidArgument" }
    },
    {
      scenario: "charges the target bytes against the volume limit",
      path: ({ execution }) => Effect.flatMap(smallVolume(execution), (fs) => fs.symlink("/missing", "/new")),
      reference: ({ execution }) =>
        Effect.flatMap(
          smallVolume(execution),
          (fs) => Effect.flatMap(fs.root, (root) => fs.symlink("/missing", Vfs.Entry(root, name("new"))))
        ),
      expected: { path: "NoSpace at /new", reference: "NoSpace" }
    }
  ]

  const unlinkRows: ReadonlyArray<Row> = [
    {
      scenario: "removes a file",
      path: ({ admin }) => admin.unlink("/file"),
      reference: ({ admin, root }) => admin.unlink(Vfs.Entry(root, name("file"))),
      check: missingAt("/file"),
      expected: { path: "ok", reference: "ok" }
    },
    {
      scenario: "rejects a missing name",
      path: ({ admin }) => admin.unlink("/dir/missing"),
      reference: ({ admin, dir }) => admin.unlink(Vfs.Entry(dir, name("missing"))),
      expected: { path: "NotFound at /dir/missing", reference: "NotFound" }
    },
    {
      scenario: "rejects a directory",
      path: ({ admin }) => admin.unlink("/dir/existing"),
      reference: ({ admin, dir }) => admin.unlink(Vfs.Entry(dir, name("existing"))),
      expected: { path: "IsDirectory at /dir/existing", reference: "IsDirectory" }
    },
    {
      scenario: "treats a dot name as a directory on paths but invalid on references",
      path: ({ admin }) => admin.unlink("/dir/."),
      reference: ({ admin, dir }) => admin.unlink(Vfs.Entry(dir, name("."))),
      expected: { path: "IsDirectory at /dir/.", reference: "InvalidArgument" }
    },
    {
      scenario: "rejects a trailing slash on a path to a file",
      path: ({ admin }) => admin.unlink("/file/"),
      reference: ({ admin, root }) => admin.unlink(Vfs.Entry(root, name("file/"))),
      expected: { path: "NotDirectory at /file/", reference: "InvalidArgument" }
    },
    {
      // #186 decisions 5 and 7: a reserved name is reported before write permission, with each family's code.
      scenario: "reports a reserved name before an unwritable parent, as a directory on paths and invalid on entries",
      path: ({ guest }) => guest.unlink("/."),
      reference: ({ guest, root }) => guest.unlink(Vfs.Entry(root, name("."))),
      expected: { path: "IsDirectory at /.", reference: "InvalidArgument" }
    },
    {
      scenario: "denies removing another owner's file from a sticky directory",
      path: ({ guest }) => guest.unlink("/sticky/file"),
      reference: ({ guest, sticky }) => guest.unlink(Vfs.Entry(sticky, name("file"))),
      expected: { path: "NotPermitted at /sticky/file", reference: "NotPermitted" }
    },
    {
      scenario: "reports a directory before the sticky-directory check",
      path: ({ guest }) => guest.unlink("/sticky/subdir"),
      reference: ({ guest, sticky }) => guest.unlink(Vfs.Entry(sticky, name("subdir"))),
      expected: { path: "IsDirectory at /sticky/subdir", reference: "IsDirectory" }
    },
    {
      scenario: "reports a directory before a path's trailing slash",
      path: ({ admin }) => admin.unlink("/dir/existing/"),
      reference: ({ admin, dir }) => admin.unlink(Vfs.Entry(dir, name("existing/"))),
      expected: { path: "IsDirectory at /dir/existing/", reference: "InvalidArgument" }
    }
  ]

  const rmdirRows: ReadonlyArray<Row> = [
    {
      scenario: "removes an empty directory",
      path: ({ admin }) => admin.rmdir("/dir/existing"),
      reference: ({ admin, dir }) => admin.rmdir(Vfs.Entry(dir, name("existing"))),
      check: missingAt("/dir/existing"),
      expected: { path: "ok", reference: "ok" }
    },
    {
      scenario: "rejects a missing name",
      path: ({ admin }) => admin.rmdir("/dir/missing"),
      reference: ({ admin, dir }) => admin.rmdir(Vfs.Entry(dir, name("missing"))),
      expected: { path: "NotFound at /dir/missing", reference: "NotFound" }
    },
    {
      scenario: "rejects a directory with entries",
      path: ({ admin }) => admin.rmdir("/dir"),
      reference: ({ admin, root }) => admin.rmdir(Vfs.Entry(root, name("dir"))),
      expected: { path: "NotEmpty at /dir", reference: "NotEmpty" }
    },
    {
      scenario: "rejects a file",
      path: ({ admin }) => admin.rmdir("/file"),
      reference: ({ admin, root }) => admin.rmdir(Vfs.Entry(root, name("file"))),
      expected: { path: "NotDirectory at /file", reference: "NotDirectory" }
    },
    {
      scenario: "rejects a dot name on both families",
      path: ({ admin }) => admin.rmdir("/dir/."),
      reference: ({ admin, dir }) => admin.rmdir(Vfs.Entry(dir, name("."))),
      expected: { path: "InvalidArgument at /dir/.", reference: "InvalidArgument" }
    },
    {
      scenario: "ignores a trailing slash on paths, where a reference name cannot hold one",
      path: ({ admin }) => admin.rmdir("/dir/existing/"),
      reference: ({ admin, dir }) => admin.rmdir(Vfs.Entry(dir, name("existing/"))),
      check: missingAt("/dir/existing"),
      expected: { path: "ok", reference: "InvalidArgument" }
    },
    {
      // #186 decision 5: a missing name is reported before write permission, as Linux does.
      scenario: "reports a missing name before an unwritable parent",
      path: ({ guest }) => guest.rmdir("/missing"),
      reference: ({ guest, root }) => guest.rmdir(Vfs.Entry(root, name("missing"))),
      expected: { path: "NotFound at /missing", reference: "NotFound" }
    },
    {
      scenario: "applies the sticky-directory check before the kind check",
      path: ({ guest }) => guest.rmdir("/sticky/file"),
      reference: ({ guest, sticky }) => guest.rmdir(Vfs.Entry(sticky, name("file"))),
      expected: { path: "NotPermitted at /sticky/file", reference: "NotPermitted" }
    }
  ]

  // A recursive remove judges its target as remove does, then empties a directory entry by entry; `force` forgives
  // the target going missing on either family, but a stale directory reference is not a missing name.
  const removeRecursiveRows: ReadonlyArray<Row> = [
    {
      scenario: "removes a directory with entries",
      path: ({ admin }) => admin.remove("/dir", { recursive: true }),
      reference: ({ admin, root }) => admin.remove(Vfs.Entry(root, name("dir")), { recursive: true }),
      check: missingAt("/dir"),
      expected: { path: "ok", reference: "ok" }
    },
    {
      scenario: "forgives a missing name with force",
      path: ({ admin }) => admin.remove("/dir/missing", { recursive: true, force: true }),
      reference: ({ admin, dir }) => admin.remove(Vfs.Entry(dir, name("missing")), { recursive: true, force: true }),
      expected: { path: "ok", reference: "ok" }
    },
    {
      scenario: "forgives a removed parent with force on paths, where its reference is stale",
      path: ({ admin }) => admin.remove("/gone/x", { recursive: true, force: true }),
      reference: ({ admin, gone }) => admin.remove(Vfs.Entry(gone, name("x")), { recursive: true, force: true }),
      expected: { path: "ok", reference: "StaleReference" }
    },
    {
      scenario: "rejects a dot name on both families",
      path: ({ admin }) => admin.remove("/dir/.", { recursive: true }),
      reference: ({ admin, dir }) => admin.remove(Vfs.Entry(dir, name(".")), { recursive: true }),
      expected: { path: "InvalidArgument at /dir/.", reference: "InvalidArgument" }
    },
    {
      scenario: "rejects a trailing slash on a path to a file",
      path: ({ admin }) => admin.remove("/file/", { recursive: true }),
      reference: ({ admin, root }) => admin.remove(Vfs.Entry(root, name("file/")), { recursive: true }),
      expected: { path: "NotDirectory at /file/", reference: "InvalidArgument" }
    },
    {
      scenario: "denies removing another owner's directory from a sticky directory",
      path: ({ guest }) => guest.remove("/sticky/subdir", { recursive: true }),
      reference: ({ guest, sticky }) => guest.remove(Vfs.Entry(sticky, name("subdir")), { recursive: true }),
      expected: { path: "NotPermitted at /sticky/subdir", reference: "NotPermitted" }
    }
  ]

  const renameRows: ReadonlyArray<Row> = [
    {
      scenario: "moves an entry to a new name",
      path: ({ admin }) => admin.rename("/file", "/dir/moved"),
      reference: ({ admin, root, dir }) => admin.rename(Vfs.Entry(root, name("file")), Vfs.Entry(dir, name("moved"))),
      check: kindAt("/dir/moved", "file"),
      expected: { path: "ok", reference: "ok" }
    },
    {
      scenario: "rejects a missing source",
      path: ({ admin }) => admin.rename("/missing", "/moved"),
      reference: ({ admin, root }) => admin.rename(Vfs.Entry(root, name("missing")), Vfs.Entry(root, name("moved"))),
      expected: { path: "NotFound at /missing", reference: "NotFound" }
    },
    {
      scenario: "accepts a rename onto the same entry",
      path: ({ admin }) => admin.rename("/file", "/file"),
      reference: ({ admin, root }) => admin.rename(Vfs.Entry(root, name("file")), Vfs.Entry(root, name("file"))),
      check: kindAt("/file", "file"),
      expected: { path: "ok", reference: "ok" }
    },
    {
      scenario: "skips the sticky-directory check for a rename onto the same entry",
      path: ({ guest }) => guest.rename("/sticky/file", "/sticky/file"),
      reference: ({ guest, sticky }) => guest.rename(Vfs.Entry(sticky, name("file")), Vfs.Entry(sticky, name("file"))),
      check: kindAt("/sticky/file", "file"),
      expected: { path: "ok", reference: "ok" }
    },
    {
      scenario: "denies moving another owner's entry out of a sticky directory",
      path: ({ guest }) => guest.rename("/sticky/file", "/sticky/moved"),
      reference: ({ guest, sticky }) => guest.rename(Vfs.Entry(sticky, name("file")), Vfs.Entry(sticky, name("moved"))),
      expected: { path: "NotPermitted at /sticky/file", reference: "NotPermitted" }
    },
    {
      scenario: "rejects a dot source name",
      path: ({ admin }) => admin.rename("/dir/.", "/moved"),
      reference: ({ admin, dir, root }) => admin.rename(Vfs.Entry(dir, name(".")), Vfs.Entry(root, name("moved"))),
      expected: { path: "InvalidArgument at /dir/.", reference: "InvalidArgument" }
    },
    {
      scenario: "rejects a dot destination name",
      path: ({ admin }) => admin.rename("/file", "/dir/.."),
      reference: ({ admin, root, dir }) => admin.rename(Vfs.Entry(root, name("file")), Vfs.Entry(dir, name(".."))),
      expected: { path: "InvalidArgument at /file", reference: "InvalidArgument" }
    },
    {
      scenario: "rejects replacing a directory with a file",
      path: ({ admin }) => admin.rename("/file", "/dir/existing"),
      reference: ({ admin, root, dir }) =>
        admin.rename(Vfs.Entry(root, name("file")), Vfs.Entry(dir, name("existing"))),
      expected: { path: "IsDirectory at /dir/existing", reference: "IsDirectory" }
    },
    {
      scenario: "rejects replacing a file with a directory",
      path: ({ admin }) => admin.rename("/dir/existing", "/file"),
      reference: ({ admin, dir, root }) =>
        admin.rename(Vfs.Entry(dir, name("existing")), Vfs.Entry(root, name("file"))),
      expected: { path: "NotDirectory at /file", reference: "NotDirectory" }
    },
    {
      scenario: "rejects replacing a directory that has entries",
      path: ({ admin }) => admin.rename("/sticky/subdir", "/dir"),
      reference: ({ admin, sticky, root }) =>
        admin.rename(Vfs.Entry(sticky, name("subdir")), Vfs.Entry(root, name("dir"))),
      expected: { path: "NotEmpty at /dir", reference: "NotEmpty" }
    },
    {
      scenario: "rejects moving a directory into itself",
      path: ({ admin }) => admin.rename("/dir", "/dir/existing/inner"),
      reference: Effect.fnUntraced(function*({ admin, root, dir }) {
        const existing = yield* admin.lookup(Vfs.Entry(dir, name("existing")))
        yield* admin.rename(Vfs.Entry(root, name("dir")), Vfs.Entry(existing, name("inner")))
      }),
      expected: { path: "InvalidArgument at /dir/existing/inner", reference: "InvalidArgument" }
    },
    {
      // #186 decision 9: a directory may move to a missing name with a trailing slash, as on Linux.
      scenario: "moves a directory to a missing path destination with a trailing slash",
      path: ({ admin }) => admin.rename("/dir/existing", "/moved/"),
      reference: ({ admin, dir, root }) =>
        admin.rename(Vfs.Entry(dir, name("existing")), Vfs.Entry(root, name("moved/"))),
      check: kindAt("/moved", "directory"),
      expected: { path: "ok", reference: "InvalidArgument" }
    },
    {
      scenario: "rejects a trailing slash on a path source that is a file",
      path: ({ admin }) => admin.rename("/file/", "/moved"),
      reference: ({ admin, root }) => admin.rename(Vfs.Entry(root, name("file/")), Vfs.Entry(root, name("moved"))),
      expected: { path: "NotDirectory at /file/", reference: "InvalidArgument" }
    },
    {
      scenario: "reports a removed source parent as missing on paths and stale on references",
      path: ({ admin }) => admin.rename("/gone/entry", "/moved"),
      reference: ({ admin, gone, root }) =>
        admin.rename(Vfs.Entry(gone, name("entry")), Vfs.Entry(root, name("moved"))),
      expected: { path: "NotFound at /gone/entry", reference: "StaleReference" }
    },
    {
      // #186 decision 8: the source directory resolves before a reserved destination name on both families.
      scenario: "resolves the source directory before a reserved destination name",
      path: ({ admin }) => admin.rename("/gone/entry", "/dir/."),
      reference: ({ admin, gone, dir }) => admin.rename(Vfs.Entry(gone, name("entry")), Vfs.Entry(dir, name("."))),
      expected: { path: "NotFound at /gone/entry", reference: "StaleReference" }
    },
    {
      scenario: "prepares both paths before locating either parent",
      path: ({ admin }) => admin.rename("/gone/entry", "\uD800"),
      reference: ({ admin, gone, root }) =>
        admin.rename(Vfs.Entry(gone, name("entry")), Vfs.Entry(root, name("moved"))),
      expected: { path: "InvalidPathEncoding at \uFFFD", reference: "StaleReference" }
    }
  ]

  const openRows: ReadonlyArray<Row> = [
    {
      scenario: "creates a missing file",
      path: ({ admin }) => Effect.scoped(admin.open("/dir/new", { access: "write", create: "ifMissing" })),
      reference: ({ admin, dir }) =>
        Effect.scoped(admin.open(Vfs.Entry(dir, name("new")), { access: "write", create: "ifMissing" })),
      check: kindAt("/dir/new", "file"),
      expected: { path: "ok", reference: "ok" }
    },
    {
      scenario: "opens an existing file",
      path: ({ admin }) => Effect.scoped(admin.open("/file", { access: "read" })),
      reference: ({ admin, root }) => Effect.scoped(admin.open(Vfs.Entry(root, name("file")), { access: "read" })),
      expected: { path: "ok", reference: "ok" }
    },
    {
      scenario: "rejects a missing file without create",
      path: ({ admin }) => Effect.scoped(admin.open("/dir/missing", { access: "read" })),
      reference: ({ admin, dir }) => Effect.scoped(admin.open(Vfs.Entry(dir, name("missing")), { access: "read" })),
      expected: { path: "NotFound at /dir/missing", reference: "NotFound" }
    },
    {
      scenario: "rejects an existing file for an exclusive create",
      path: ({ admin }) => Effect.scoped(admin.open("/file", { access: "write", create: "exclusive" })),
      reference: ({ admin, root }) =>
        Effect.scoped(admin.open(Vfs.Entry(root, name("file")), { access: "write", create: "exclusive" })),
      expected: { path: "AlreadyExists at /file", reference: "AlreadyExists" }
    },
    {
      scenario: "rejects a dangling symbolic link for an exclusive create",
      path: Effect.fnUntraced(function*({ admin }) {
        yield* admin.symlink("/missing", "/dangling")
        yield* Effect.scoped(admin.open("/dangling", { access: "write", create: "exclusive" }))
      }),
      reference: Effect.fnUntraced(function*({ admin, root }) {
        yield* admin.symlink("/missing", "/dangling")
        yield* Effect.scoped(
          admin.open(Vfs.Entry(root, name("dangling")), { access: "write", create: "exclusive" })
        )
      }),
      expected: { path: "AlreadyExists at /dangling", reference: "AlreadyExists" }
    },
    {
      scenario: "creates the target of a dangling symbolic link",
      path: Effect.fnUntraced(function*({ admin }) {
        yield* admin.symlink("/dir/target", "/link")
        yield* Effect.scoped(admin.open("/link", { access: "write", create: "ifMissing" }))
      }),
      reference: Effect.fnUntraced(function*({ admin, root }) {
        yield* admin.symlink("/dir/target", "/link")
        yield* Effect.scoped(admin.open(Vfs.Entry(root, name("link")), { access: "write", create: "ifMissing" }))
      }),
      check: kindAt("/dir/target", "file"),
      expected: { path: "ok", reference: "ok" }
    },
    {
      scenario: "rejects a symbolic link loop",
      path: Effect.fnUntraced(function*({ admin }) {
        yield* admin.symlink("/loop", "/loop")
        yield* Effect.scoped(admin.open("/loop", { access: "read" }))
      }),
      reference: Effect.fnUntraced(function*({ admin, root }) {
        yield* admin.symlink("/loop", "/loop")
        yield* Effect.scoped(admin.open(Vfs.Entry(root, name("loop")), { access: "read" }))
      }),
      expected: { path: "SymlinkLoop at /loop", reference: "SymlinkLoop at loop" }
    },
    {
      scenario: "rejects a directory",
      path: ({ admin }) => Effect.scoped(admin.open("/dir", { access: "read" })),
      reference: ({ admin, root }) => Effect.scoped(admin.open(Vfs.Entry(root, name("dir")), { access: "read" })),
      expected: { path: "IsDirectory at /dir", reference: "IsDirectory" }
    },
    {
      scenario: "treats a dot name as a directory on paths but invalid on references",
      path: ({ admin }) => Effect.scoped(admin.open("/dir/.", { access: "read" })),
      reference: ({ admin, dir }) => Effect.scoped(admin.open(Vfs.Entry(dir, name(".")), { access: "read" })),
      expected: { path: "IsDirectory at /dir/.", reference: "InvalidArgument" }
    },
    {
      // #186 decision 9: a create through a trailing slash asks for a directory, as Linux reports.
      scenario: "will not create through a trailing slash",
      path: ({ admin }) => Effect.scoped(admin.open("/dir/new/", { access: "write", create: "ifMissing" })),
      reference: ({ admin, dir }) =>
        Effect.scoped(admin.open(Vfs.Entry(dir, name("new/")), { access: "write", create: "ifMissing" })),
      expected: { path: "IsDirectory at /dir/new/", reference: "InvalidArgument" }
    },
    {
      scenario: "rejects a trailing slash on an existing file",
      path: ({ admin }) => Effect.scoped(admin.open("/file/", { access: "read" })),
      reference: ({ admin, root }) => Effect.scoped(admin.open(Vfs.Entry(root, name("file/")), { access: "read" })),
      expected: { path: "NotDirectory at /file/", reference: "InvalidArgument" }
    },
    {
      scenario: "rejects truncating a read-only open",
      path: ({ admin }) => Effect.scoped(admin.open("/file", { access: "read", truncate: true })),
      reference: ({ admin, root }) =>
        Effect.scoped(admin.open(Vfs.Entry(root, name("file")), { access: "read", truncate: true })),
      expected: { path: "InvalidArgument at /file", reference: "InvalidArgument" }
    },
    {
      scenario: "rejects a mode without create",
      path: ({ admin }) => Effect.scoped(admin.open("/file", { access: "read", mode: 0o600 })),
      reference: ({ admin, root }) =>
        Effect.scoped(admin.open(Vfs.Entry(root, name("file")), { access: "read", mode: 0o600 })),
      expected: { path: "InvalidArgument at /file", reference: "InvalidArgument" }
    },
    {
      scenario: "denies creating in an unwritable directory",
      path: ({ guest }) => Effect.scoped(guest.open("/new", { access: "write", create: "ifMissing" })),
      reference: ({ guest, root }) =>
        Effect.scoped(guest.open(Vfs.Entry(root, name("new")), { access: "write", create: "ifMissing" })),
      expected: { path: "AccessDenied at /new", reference: "AccessDenied" }
    },
    {
      scenario: "reports a removed parent as missing on paths and stale on references",
      path: ({ admin }) => Effect.scoped(admin.open("/gone/new", { access: "write", create: "ifMissing" })),
      reference: ({ admin, gone }) =>
        Effect.scoped(admin.open(Vfs.Entry(gone, name("new")), { access: "write", create: "ifMissing" })),
      expected: { path: "NotFound at /gone/new", reference: "StaleReference" }
    }
  ]

  const EXPLICIT_TIMES = {
    access: { kind: "value", nanoseconds: 1n },
    modification: { kind: "value", nanoseconds: 1n }
  } as const

  const NOW_TIMES = { access: { kind: "now" }, modification: { kind: "now" } } as const

  const chmodRows: ReadonlyArray<Row> = [
    {
      scenario: "changes the mode",
      path: ({ admin }) => admin.chmod("/file", 0o600),
      reference: ({ admin, file }) => admin.chmod(file, 0o600),
      check: ({ admin }) =>
        Effect.map(
          admin.stat(Vfs.Target.Path({ path: "/file", followFinalSymlink: false })),
          (metadata) => assert.strictEqual(metadata.mode, 0o600)
        ),
      expected: { path: "ok", reference: "ok" }
    },
    {
      scenario: "rejects an invalid mode",
      path: ({ admin }) => admin.chmod("/file", -1),
      reference: ({ admin, file }) => admin.chmod(file, -1),
      expected: { path: "InvalidArgument", reference: "InvalidArgument" }
    },
    {
      scenario: "rejects an invalid mode before resolving the target",
      path: ({ admin }) => admin.chmod("/gone", -1),
      reference: ({ admin, gone }) => admin.chmod(gone, -1),
      expected: { path: "InvalidArgument", reference: "InvalidArgument" }
    },
    {
      scenario: "denies a caller that does not own the target",
      path: ({ guest }) => guest.chmod("/file", 0o600),
      reference: ({ guest, file }) => guest.chmod(file, 0o600),
      expected: { path: "NotPermitted at /file", reference: "NotPermitted" }
    },
    {
      scenario: "reports a removed target as missing on paths and stale on references",
      path: ({ admin }) => admin.chmod("/gone", 0o700),
      reference: ({ admin, gone }) => admin.chmod(gone, 0o700),
      expected: { path: "NotFound at /gone", reference: "StaleReference" }
    }
  ]

  const chownRows: ReadonlyArray<Row> = [
    {
      scenario: "changes the owner",
      path: ({ admin }) => admin.chown("/file", { uid: 9 }),
      reference: ({ admin, file }) => admin.chown(file, { uid: 9 }),
      check: ({ admin }) =>
        Effect.map(
          admin.stat(Vfs.Target.Path({ path: "/file", followFinalSymlink: false })),
          (metadata) => assert.strictEqual(metadata.uid, 9)
        ),
      expected: { path: "ok", reference: "ok" }
    },
    {
      scenario: "rejects an invalid owner",
      path: ({ admin }) => admin.chown("/file", { uid: -1 }),
      reference: ({ admin, file }) => admin.chown(file, { uid: -1 }),
      expected: { path: "InvalidArgument", reference: "InvalidArgument" }
    },
    {
      scenario: "denies a caller that does not own the target",
      path: ({ guest }) => guest.chown("/file", { gid: 9 }),
      reference: ({ guest, file }) => guest.chown(file, { gid: 9 }),
      expected: { path: "NotPermitted at /file", reference: "NotPermitted" }
    },
    {
      scenario: "reports a removed target as missing on paths and stale on references",
      path: ({ admin }) => admin.chown("/gone", { uid: 9 }),
      reference: ({ admin, gone }) => admin.chown(gone, { uid: 9 }),
      expected: { path: "NotFound at /gone", reference: "StaleReference" }
    }
  ]

  const utimesRows: ReadonlyArray<Row> = [
    {
      scenario: "sets explicit times",
      path: ({ admin }) => admin.utimes("/file", EXPLICIT_TIMES),
      reference: ({ admin, file }) => admin.utimes(file, EXPLICIT_TIMES),
      check: ({ admin }) =>
        Effect.map(
          admin.stat(Vfs.Target.Path({ path: "/file", followFinalSymlink: false })),
          (metadata) => assert.strictEqual(metadata.mtimeNs, 1n)
        ),
      expected: { path: "ok", reference: "ok" }
    },
    {
      scenario: "denies explicit times to a caller that does not own the target",
      path: ({ guest }) => guest.utimes("/file", EXPLICIT_TIMES),
      reference: ({ guest, file }) => guest.utimes(file, EXPLICIT_TIMES),
      expected: { path: "NotPermitted at /file", reference: "NotPermitted" }
    },
    {
      scenario: "lets a caller with write access set both times to now",
      path: ({ guest }) => guest.utimes("/file", NOW_TIMES),
      reference: ({ guest, file }) => guest.utimes(file, NOW_TIMES),
      expected: { path: "ok", reference: "ok" }
    },
    {
      scenario: "denies setting times to now without write access",
      path: ({ guest }) => guest.utimes("/", NOW_TIMES),
      reference: ({ guest, root }) => guest.utimes(root, NOW_TIMES),
      expected: { path: "AccessDenied at /", reference: "AccessDenied" }
    },
    {
      scenario: "reports a removed target as missing on paths and stale on references",
      path: ({ admin }) => admin.utimes("/gone", EXPLICIT_TIMES),
      reference: ({ admin, gone }) => admin.utimes(gone, EXPLICIT_TIMES),
      expected: { path: "NotFound at /gone", reference: "StaleReference" }
    }
  ]

  const accessRows: ReadonlyArray<Row> = [
    {
      scenario: "grants a permitted check",
      path: ({ guest }) => guest.access("/file", 4),
      reference: ({ guest, file }) => guest.access(file, 4),
      expected: { path: 4, reference: 4 }
    },
    {
      scenario: "rejects invalid bits",
      path: ({ admin }) => admin.access("/file", 8),
      reference: ({ admin, file }) => admin.access(file, 8),
      expected: { path: "InvalidArgument at /file", reference: "InvalidArgument" }
    },
    {
      // #186 decision 16: access answers with the granted bits instead of failing.
      scenario: "grants no execute on a file without any execute bit, even to an administrator",
      path: ({ admin }) => admin.access("/file", 1),
      reference: ({ admin, file }) => admin.access(file, 1),
      expected: { path: 0, reference: 0 }
    },
    {
      // #186 decision 16: access answers with the granted bits instead of failing.
      scenario: "grants nothing for a missing permission",
      path: ({ guest }) => guest.access("/", 2),
      reference: ({ guest, root }) => guest.access(root, 2),
      expected: { path: 0, reference: 0 }
    },
    {
      scenario: "reports a removed target as missing on paths and stale on references",
      path: ({ admin }) => admin.access("/gone"),
      reference: ({ admin, gone }) => admin.access(gone),
      expected: { path: "NotFound at /gone", reference: "StaleReference" }
    }
  ]

  const truncateRows: ReadonlyArray<Row> = [
    {
      scenario: "resizes a file",
      path: ({ admin }) => admin.truncate("/file", 4n),
      reference: ({ admin, file }) => admin.truncate(file, 4n),
      check: ({ admin }) =>
        Effect.map(
          admin.stat(Vfs.Target.Path({ path: "/file", followFinalSymlink: false })),
          (metadata) => assert.strictEqual(metadata.size, 4n)
        ),
      expected: { path: "ok", reference: "ok" }
    },
    {
      scenario: "rejects a directory",
      path: ({ admin }) => admin.truncate("/dir", 0n),
      reference: ({ admin, dir }) => admin.truncate(dir, 0n),
      expected: { path: "IsDirectory at /dir", reference: "IsDirectory" }
    },
    {
      scenario: "rejects a directory before checking write access",
      path: ({ guest }) => guest.truncate("/", 0n),
      reference: ({ guest, root }) => guest.truncate(root, 0n),
      expected: { path: "IsDirectory at /", reference: "IsDirectory" }
    },
    {
      scenario: "rejects a negative length",
      path: ({ admin }) => admin.truncate("/file", -1n),
      reference: ({ admin, file }) => admin.truncate(file, -1n),
      expected: { path: "InvalidArgument", reference: "InvalidArgument" }
    },
    {
      scenario: "rejects a negative length before resolving the target",
      path: ({ admin }) => admin.truncate("/gone", -1n),
      reference: ({ admin, gone }) => admin.truncate(gone, -1n),
      expected: { path: "InvalidArgument", reference: "InvalidArgument" }
    },
    {
      scenario: "reports a removed target as missing on paths and stale on references",
      path: ({ admin }) => admin.truncate("/gone", 0n),
      reference: ({ admin, gone }) => admin.truncate(gone, 0n),
      expected: { path: "NotFound at /gone", reference: "StaleReference" }
    }
  ]

  // Takes write access on /file away from the guest, so a size or a now-time change needs more than the mode.
  const readOnlyFile = ({ admin }: Fixture) => admin.chmod("/file", 0o644)

  const metadataAt = <A>(path: string, select: (metadata: Vfs.Metadata) => A, expected: A) => ({ admin }: Fixture) =>
    Effect.map(
      admin.stat(Vfs.Target.Path({ path: path, followFinalSymlink: false })),
      (metadata) => assert.deepStrictEqual(select(metadata), expected)
    )

  // #209: every argument validates first, then the path resolves, then ownership (NotPermitted) for mode, owner and
  // explicit times, then write permission (AccessDenied) for size and now-times. The first failure wins.
  const setattrRows: ReadonlyArray<Row> = [
    {
      scenario: "changes every attribute in one call",
      path: ({ admin }) => admin.setattr("/file", { size: 4n, mode: 0o600, owner: { uid: 9 }, times: EXPLICIT_TIMES }),
      reference: ({ admin, file }) =>
        admin.setattr(file, { size: 4n, mode: 0o600, owner: { uid: 9 }, times: EXPLICIT_TIMES }),
      check: metadataAt("/file", ({ mode, mtimeNs, size, uid }) => ({ size, mode, uid, mtimeNs }), {
        size: 4n,
        mode: 0o600,
        uid: 9,
        mtimeNs: 1n
      }),
      expected: { path: "ok", reference: "ok" }
    },
    {
      scenario: "rejects an invalid attribute before resolving the target",
      path: ({ admin }) => admin.setattr("/gone", { mode: -1 }),
      reference: ({ admin, gone }) => admin.setattr(gone, { mode: -1 }),
      expected: { path: "InvalidArgument", reference: "InvalidArgument" }
    },
    {
      scenario: "rejects an invalid attribute before checking ownership",
      path: ({ guest }) => guest.setattr("/file", { mode: 0o600, size: -1n }),
      reference: ({ guest, file }) => guest.setattr(file, { mode: 0o600, size: -1n }),
      expected: { path: "InvalidArgument", reference: "InvalidArgument" }
    },
    {
      scenario: "reports a removed target as missing on paths and stale on references",
      path: ({ guest }) => guest.setattr("/gone", { mode: 0o700 }),
      reference: ({ guest, gone }) => guest.setattr(gone, { mode: 0o700 }),
      expected: { path: "NotFound at /gone", reference: "StaleReference" }
    },
    {
      scenario: "rejects a size on a directory before checking ownership",
      path: ({ guest }) => guest.setattr("/dir", { size: 0n, mode: 0o700 }),
      reference: ({ guest, dir }) => guest.setattr(dir, { size: 0n, mode: 0o700 }),
      expected: { path: "IsDirectory at /dir", reference: "IsDirectory" }
    },
    {
      scenario: "rejects a size on a symbolic link",
      path: ({ admin }) =>
        Effect.andThen(
          admin.symlink("/file", "/link"),
          admin.setattr(Vfs.Target.Path({ path: "/link", followFinalSymlink: false }), { size: 0n })
        ),
      reference: ({ admin, root }) =>
        Effect.flatMap(
          admin.symlink("/file", Vfs.Entry(root, name("link"))),
          (link) => admin.setattr(link.reference, { size: 0n })
        ),
      expected: { path: "SymlinkLoop at /link", reference: "SymlinkLoop" }
    },
    {
      scenario: "denies a mode to a caller that does not own the target",
      path: ({ guest }) => guest.setattr("/file", { mode: 0o600 }),
      reference: ({ guest, file }) => guest.setattr(file, { mode: 0o600 }),
      expected: { path: "NotPermitted at /file", reference: "NotPermitted" }
    },
    {
      scenario: "denies an owner to a caller that does not own the target",
      path: ({ guest }) => guest.setattr("/file", { owner: { gid: 9 } }),
      reference: ({ guest, file }) => guest.setattr(file, { owner: { gid: 9 } }),
      expected: { path: "NotPermitted at /file", reference: "NotPermitted" }
    },
    {
      scenario: "denies explicit times to a caller that does not own the target",
      path: ({ guest }) => guest.setattr("/file", { times: EXPLICIT_TIMES }),
      reference: ({ guest, file }) => guest.setattr(file, { times: EXPLICIT_TIMES }),
      expected: { path: "NotPermitted at /file", reference: "NotPermitted" }
    },
    {
      scenario: "checks ownership before write permission",
      path: (fixture) =>
        Effect.andThen(readOnlyFile(fixture), fixture.guest.setattr("/file", { size: 0n, times: EXPLICIT_TIMES })),
      reference: (fixture) =>
        Effect.andThen(readOnlyFile(fixture), fixture.guest.setattr(fixture.file, { size: 0n, times: EXPLICIT_TIMES })),
      expected: { path: "NotPermitted at /file", reference: "NotPermitted" }
    },
    {
      scenario: "denies a size without write access",
      path: (fixture) => Effect.andThen(readOnlyFile(fixture), fixture.guest.setattr("/file", { size: 0n })),
      reference: (fixture) => Effect.andThen(readOnlyFile(fixture), fixture.guest.setattr(fixture.file, { size: 0n })),
      expected: { path: "AccessDenied at /file", reference: "AccessDenied" }
    },
    {
      scenario: "checks write permission before the size limits",
      path: (fixture) => Effect.andThen(readOnlyFile(fixture), fixture.guest.setattr("/file", { size: 2n ** 60n })),
      reference: (fixture) =>
        Effect.andThen(readOnlyFile(fixture), fixture.guest.setattr(fixture.file, { size: 2n ** 60n })),
      expected: { path: "AccessDenied at /file", reference: "AccessDenied" }
    },
    {
      scenario: "rejects a size over the file limit at apply",
      path: ({ admin }) => admin.setattr("/file", { size: 2n ** 60n }),
      reference: ({ admin, file }) => admin.setattr(file, { size: 2n ** 60n }),
      expected: { path: "FileTooLarge", reference: "FileTooLarge" }
    },
    {
      scenario: "charges a larger size against the volume limit at apply",
      path: ({ execution }) =>
        Effect.flatMap(
          smallVolume(execution),
          (fs) =>
            Effect.andThen(
              fs.writeFile("/f", new Uint8Array(), { access: "write", create: "exclusive" }),
              fs.setattr("/f", { size: 8n })
            )
        ),
      reference: ({ execution }) =>
        Effect.flatMap(smallVolume(execution), (fs) =>
          Effect.flatMap(fs.root, (root) =>
            Effect.flatMap(
              Effect.scoped(fs.open(Vfs.Entry(root, name("f")), { access: "write", create: "exclusive" })),
              (opened) => fs.setattr(opened.reference, { size: 8n })
            ))),
      expected: { path: "NoSpace", reference: "NoSpace" }
    },
    {
      scenario: "denies setting times to now without write access",
      path: ({ guest }) => guest.setattr("/", { times: NOW_TIMES }),
      reference: ({ guest, root }) => guest.setattr(root, { times: NOW_TIMES }),
      expected: { path: "AccessDenied at /", reference: "AccessDenied" }
    },
    {
      scenario: "lets a caller with write access set a size and both times to now",
      path: ({ guest }) =>
        Effect.andThen(TestClock.setTime(1_000), guest.setattr("/file", { size: 2n, times: NOW_TIMES })),
      reference: ({ guest, file }) =>
        Effect.andThen(TestClock.setTime(1_000), guest.setattr(file, { size: 2n, times: NOW_TIMES })),
      check: metadataAt("/file", ({ atimeNs, mtimeNs, size }) => ({ atimeNs, mtimeNs, size }), {
        atimeNs: 1_000_000_000n,
        mtimeNs: 1_000_000_000n,
        size: 2n
      }),
      expected: { path: "ok", reference: "ok" }
    },
    {
      scenario: "keeps a requested setuid mode across the owner change that would clear it",
      path: ({ admin }) => admin.setattr("/file", { mode: 0o4755, owner: { uid: 9 } }),
      reference: ({ admin, file }) => admin.setattr(file, { mode: 0o4755, owner: { uid: 9 } }),
      check: metadataAt("/file", ({ mode, uid }) => ({ mode, uid }), { mode: 0o4755, uid: 9 }),
      expected: { path: "ok", reference: "ok" }
    },
    {
      // Linux notify_change returns early when no attribute is valid, so nothing is checked or changed.
      scenario: "checks and changes nothing without attributes",
      path: ({ guest }) => guest.setattr("/file", {}),
      reference: ({ guest, file }) => guest.setattr(file, {}),
      check: metadataAt("/file", ({ mode, uid }) => ({ mode, uid }), { mode: 0o666, uid: 0 }),
      expected: { path: "ok", reference: "ok" }
    }
  ]

  const TABLE: ReadonlyArray<readonly [verb: string, rows: ReadonlyArray<Row>]> = [
    ["mkdir", mkdirRows],
    ["mkdir recursive", mkdirRecursiveRows],
    ["link", linkRows],
    ["symlink", symlinkRows],
    ["unlink", unlinkRows],
    ["rmdir", rmdirRows],
    ["remove recursive", removeRecursiveRows],
    ["rename", renameRows],
    ["open", openRows],
    ["chmod", chmodRows],
    ["chown", chownRows],
    ["utimes", utimesRows],
    ["access", accessRows],
    ["truncate", truncateRows],
    ["setattr", setattrRows]
  ]

  for (const execution of ["cooperative", "sync"] as const) {
    describe(`operation families (${execution})`, () => {
      for (const [verb, rows] of TABLE) {
        describe(verb, () => {
          for (const row of rows) {
            it.layer(BunCrypto.layer)((it) => {
              it.effect(
                `should report the expected path and reference outcomes when ${verb} ${row.scenario}`,
                () =>
                  Effect.gen(function*() {
                    const path = yield* outcome(row, "path", execution)
                    const reference = yield* outcome(row, "reference", execution)

                    assert.deepStrictEqual({ path, reference }, row.expected)
                  })
              )
            })
          }
        })
      }
    })
  }
})

describe("root permissions", () => {
  const text = new TextEncoder()

  it.effect("should enforce independent permissions and lookup rules when a caller derives a confined root", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const owner = yield* volume.caller({ umask: 0 })
      yield* owner.mkdir("/work", { mode: 0o777 })

      const user = yield* volume.caller({
        identity: { uid: 1000, gid: 1000, groups: [], privileged: false },
        umask: 0o027
      })

      const rooted = yield* user.withRoot("/work")
      yield* rooted.writeFile("/data", text.encode("private"), {
        access: "write",
        create: "exclusive",
        mode: 0o666
      })
      assert.strictEqual((yield* owner.stat("/work/data")).mode, 0o640)
      yield* owner.symlink("data", "/work/link")
      assert.strictEqual(
        (yield* rooted.stat({ _tag: "Path", path: "/link", followFinalSymlink: false })).kind,
        "symlink"
      )
      yield* owner.chmod("/work/data", 0o000)
      assert.strictEqual((yield* Effect.flip(rooted.readFile("/data"))).code, "AccessDenied")
      assert.strictEqual((yield* Effect.flip(rooted.stat("/../outside"))).code, "NotFound")
    }).pipe(Effect.provide(NodeCrypto.layer)))
})

describe("call styles", () => {
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
})

describe("recursive removal during namespace changes", () => {
  const pauseRemoval = Effect.fnUntraced(function*() {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let pause = false

    const volume = yield* LiveVolume.open({ volume: {}, maxImageBytes: ByteSize.kibibytes(64) }).pipe(
      Effect.provideService(LiveVolume.LiveImageStore, {
        loadOrCreate: Effect.succeed,
        commit: () => {
          if (!pause) return Effect.succeed("committed" as const)
          pause = false

          return Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as("committed" as const)
          )
        }
      })
    )

    return {
      owner: yield* volume.caller(),
      entered: Deferred.await(entered),
      release: Deferred.succeed(release, undefined),
      arm: Effect.sync(() => {
        pause = true
      })
    }
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("denies recursive removal when the imported directory leaves its confined root", () =>
      Effect.gen(function*() {
        const gate = yield* pauseRemoval()
        const { owner } = gate
        yield* owner.mkdir("/tenant/child/work", { recursive: true })
        yield* owner.mkdir("/outside")
        yield* owner.writeFile("/tenant/child/work/a", Uint8Array.of(1), writeOptions)
        yield* owner.writeFile("/tenant/child/work/z", Uint8Array.of(2), writeOptions)
        const confined = yield* owner.withRoot("/tenant")
        const base = yield* confined.openDirectory("/child")
        yield* gate.arm

        const removal = yield* owner.remove(Vfs.Entry(base, new TextEncoder().encode("work")), { recursive: true })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }))

        yield* gate.entered

        const move = yield* owner.rename("/tenant/child", "/outside/moved")
          .pipe(Effect.forkChild({ startImmediately: true }))

        yield* gate.release
        yield* Fiber.join(move)

        assert.strictEqual((yield* Fiber.join(removal)).code, "AccessDenied")
        assert.strictEqual((yield* Effect.flip(owner.stat("/outside/moved/work/a"))).code, "NotFound")
        assert.deepStrictEqual(yield* owner.readFile("/outside/moved/work/z"), Uint8Array.of(2))
      }))

    it.effect("preserves the original and replacement when the guarded target changes between stages", () =>
      Effect.gen(function*() {
        const gate = yield* pauseRemoval()
        const { owner } = gate
        yield* owner.mkdir("/work")
        yield* owner.mkdir("/replacement")
        yield* owner.writeFile("/work/a", Uint8Array.of(1), writeOptions)
        yield* owner.writeFile("/work/z", Uint8Array.of(2), writeOptions)
        yield* owner.writeFile("/replacement/z", Uint8Array.of(3), writeOptions)
        const expected = yield* owner.lookup("/work")
        yield* gate.arm

        const removal = yield* owner.remove("/work", { recursive: true, expected, force: true })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }))

        yield* gate.entered
        const move = yield* owner.rename("/work", "/original").pipe(Effect.forkChild({ startImmediately: true }))
        const replace = yield* owner.rename("/replacement", "/work").pipe(Effect.forkChild({ startImmediately: true }))
        yield* gate.release
        yield* Fiber.join(move)
        yield* Fiber.join(replace)

        assert.strictEqual((yield* Fiber.join(removal)).code, "VolumeBusy")
        assert.strictEqual((yield* Effect.flip(owner.stat("/original/a"))).code, "NotFound")
        assert.deepStrictEqual(yield* owner.readFile("/original/z"), Uint8Array.of(2))
        assert.deepStrictEqual(yield* owner.readFile("/work/z"), Uint8Array.of(3))
      }))

    for (const force of [false, true]) {
      it.effect(`handles a guarded target renamed away between stages with force=${force}`, () =>
        Effect.gen(function*() {
          const gate = yield* pauseRemoval()
          const { owner } = gate
          yield* owner.mkdir("/work")
          yield* owner.writeFile("/work/a", Uint8Array.of(1), writeOptions)
          yield* owner.writeFile("/work/z", Uint8Array.of(2), writeOptions)
          const expected = yield* owner.lookup("/work")
          yield* gate.arm

          const removal = yield* owner.remove("/work", { recursive: true, expected, force })
            .pipe(Effect.result, Effect.forkChild({ startImmediately: true }))

          yield* gate.entered
          const move = yield* owner.rename("/work", "/moved").pipe(Effect.forkChild({ startImmediately: true }))
          yield* gate.release
          yield* Fiber.join(move)

          const result = yield* Fiber.join(removal)

          if (force) assert.isTrue(Result.isSuccess(result))
          else assert.strictEqual(Result.isFailure(result) && result.failure.code, "NotFound")
          assert.strictEqual((yield* Effect.flip(owner.stat("/moved/a"))).code, "NotFound")
          assert.deepStrictEqual(yield* owner.readFile("/moved/z"), Uint8Array.of(2))
        }))
    }

    it.effect("reports a missing listed child during forced recursive removal", () =>
      Effect.gen(function*() {
        const gate = yield* pauseRemoval()
        const caller = gate.owner
        yield* caller.mkdir("/work")
        yield* caller.writeFile("/work/a", Uint8Array.of(1), writeOptions)
        yield* caller.writeFile("/work/z", Uint8Array.of(2), writeOptions)
        const expected = yield* caller.lookup("/work")
        yield* gate.arm

        const removal = yield* caller.remove("/work", { recursive: true, expected, force: true }).pipe(
          Effect.flip,
          Effect.forkChild({ startImmediately: true })
        )

        yield* gate.entered

        const unlink = yield* caller.unlink("/work/z").pipe(Effect.forkChild({ startImmediately: true }))

        yield* gate.release
        yield* Fiber.join(unlink)

        assert.strictEqual((yield* Fiber.join(removal)).code, "NotFound")
        assert.strictEqual((yield* caller.stat("/work")).kind, "directory")
        assert.deepStrictEqual((yield* caller.readDirectory("/work")).value, [])
      }))

    it.effect("preserves a replacement installed after the parent directory was listed", () =>
      Effect.gen(function*() {
        const gate = yield* pauseRemoval()
        const caller = gate.owner
        yield* caller.mkdir("/work")
        yield* caller.writeFile("/work/a", Uint8Array.of(1), writeOptions)
        yield* caller.writeFile("/work/z", Uint8Array.of(2), writeOptions)
        yield* caller.writeFile("/replacement", Uint8Array.of(3), writeOptions)
        const expected = yield* caller.lookup("/work")
        yield* gate.arm

        const removal = yield* caller.remove("/work", { recursive: true, expected }).pipe(
          Effect.flip,
          Effect.forkChild({ startImmediately: true })
        )

        yield* gate.entered

        const replacement = yield* caller.rename("/replacement", "/work/z").pipe(
          Effect.forkChild({ startImmediately: true })
        )

        yield* gate.release
        yield* Fiber.join(replacement)

        assert.strictEqual((yield* Fiber.join(removal)).code, "NotFound")
        assert.strictEqual((yield* Effect.flip(caller.stat("/work/a"))).code, "NotFound")
        assert.deepStrictEqual(yield* caller.readFile("/work/z"), Uint8Array.of(3))
      }))
  })
})
