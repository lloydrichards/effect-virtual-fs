import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, Exit, Scope, Stream } from "effect"
import { Caller as CallerModule, LiveVolume, Testing, VirtualFileSystem as Vfs } from "../src/index.js"
import { withVolumeTestSeams } from "../src/internal/testSeams.js"
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

        for (const path of ["/.", "/child/..", "/../../", "child/../."]) {
          for (
            const operation of [
              Effect.asVoid(caller.remove(path, { recursive: true })),
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

    it.effect("rechecks imported entry-directory authority between recursive removal stages", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture
        yield* caller.mkdir("/child/temporary")
        yield* caller.writeFile("/child/temporary/a", bytes("a"), writeOptions)
        yield* caller.writeFile("/child/temporary/b", bytes("b"), writeOptions)
        const base = yield* caller.openDirectory("/child")
        let stages = 0

        const beforeTreeRemoval = Effect.suspend(() =>
          ++stages === 2
            ? Effect.orDie(owner.rename("/tenant/child", "/outside/moved"))
            : Effect.void
        )

        const error = yield* Effect.flip(
          owner.remove(Vfs.Entry(base, bytes("temporary")), { recursive: true })
            .pipe(withVolumeTestSeams({ beforeTreeRemoval }))
        )

        assert.strictEqual(error.code, "AccessDenied")
        assert.strictEqual(text(yield* owner.readFile("/outside/moved/temporary/b")), "b")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("rechecks expected identity before each recursive removal stage", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* fixture
        const expected = (yield* caller.mkdir("/temporary")).reference
        yield* caller.writeFile("/temporary/a", bytes("a"), writeOptions)
        yield* caller.writeFile("/temporary/b", bytes("b"), writeOptions)
        let stages = 0

        const beforeTreeRemoval = Effect.suspend(() =>
          ++stages === 2
            ? Effect.orDie(Effect.gen(function*() {
              yield* owner.rename("/tenant/temporary", "/tenant/original")
              yield* owner.mkdir("/tenant/temporary")
              yield* owner.writeFile("/tenant/temporary/b", bytes("replacement"), writeOptions)
            }))
            : Effect.void
        )

        const error = yield* Effect.flip(
          caller.remove("/temporary", { expected, recursive: true, force: true })
            .pipe(withVolumeTestSeams({ beforeTreeRemoval }))
        )

        assert.strictEqual(error.code, "VolumeBusy")
        assert.strictEqual(text(yield* caller.readFile("/temporary/b")), "replacement")
        assert.strictEqual(text(yield* caller.readFile("/original/b")), "b")
        assert.strictEqual((yield* Effect.flip(caller.stat("/original/a"))).code, "NotFound")
      }).pipe(Effect.provide(Testing.layer())))

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
