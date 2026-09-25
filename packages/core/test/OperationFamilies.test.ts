import { assert, describe } from "@effect/vitest"
import { ByteSize, Effect, Result } from "effect"
import type * as Crypto from "effect/Crypto"
import { VirtualFileSystem as Vfs, type VirtualFileSystemError } from "../src/index.js"
import * as InternalBytePath from "../src/internal/bytePath.js"
import { it } from "./TestEffect.js"

// Path-addressed and reference-addressed verbs share one mutation body, but each family keeps its own
// validation order and error codes. Each row pins what both families report for the same situation, so a
// difference is recorded here instead of being lost or "fixed" when the bodies merge. A failure reads as its
// code, followed by the path it names when it names one.

const name = (value: string) => new TextEncoder().encode(value)

const GUEST = { uid: 9, gid: 9, groups: [], privileged: false } as const

type FsError = VirtualFileSystemError.FsError

interface Fixture {
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
const arrange = Effect.gen(function*() {
  const volume = yield* Vfs.make()
  const admin = yield* volume.caller({ umask: 0 })
  const guest = yield* volume.caller({ identity: GUEST })
  const root = yield* admin.rootReference
  const dir = (yield* admin.mkdirReference(root, name("dir"))).reference
  yield* admin.mkdirReference(dir, name("existing"))
  const file = yield* admin.openChildReference(root, name("file"), { access: "write", create: "exclusive" })
  yield* file.handle.close
  const gone = (yield* admin.mkdirReference(root, name("gone"))).reference
  yield* admin.rmdirReference(root, name("gone"))
  const sticky = (yield* admin.mkdirReference(root, name("sticky"), { mode: 0o1777 })).reference
  const owned = yield* admin.openChildReference(sticky, name("file"), { access: "write", create: "exclusive" })
  yield* owned.handle.close
  yield* admin.mkdirReference(sticky, name("subdir"))

  return { admin, guest, root, dir, file: file.reference, gone, sticky } satisfies Fixture
})

interface Row {
  readonly scenario: string
  // A row may build its own volume when the fixture's cannot express the situation.
  readonly path: (fixture: Fixture) => Effect.Effect<unknown, FsError, Crypto.Crypto>
  readonly reference: (fixture: Fixture) => Effect.Effect<unknown, FsError, Crypto.Crypto>
  // Confirms a successful operation took effect, on the fixture it ran against.
  readonly check?: (fixture: Fixture) => Effect.Effect<unknown, FsError>
  readonly expected: { readonly path: string; readonly reference: string }
}

const printable = (path: Vfs.PathInput | undefined): string => {
  if (path === undefined) return "<undefined>"

  if (!InternalBytePath.isBytePath(path)) return path
  const bytes = InternalBytePath.getBytes(path)

  return bytes === undefined ? "<detached>" : new TextDecoder().decode(bytes)
}

const report = (error: FsError) => "path" in error ? `${error.code} at ${printable(error.path)}` : error.code

// Checks for rows that succeed, each reading the entry the operation should have changed.
const kindAt = (path: string, kind: Vfs.Metadata["kind"]) => ({ admin }: Fixture) =>
  Effect.map(admin.lstat(path), (metadata) => assert.strictEqual(metadata.kind, kind))

const linksAt = (path: string, nlink: number) => ({ admin }: Fixture) =>
  Effect.map(admin.lstat(path), (metadata) => assert.strictEqual(metadata.nlink, nlink))

const targetAt = (path: string, target: string) => ({ admin }: Fixture) =>
  Effect.map(admin.readLink(path), (actual) => assert.strictEqual(actual, target))

const missingAt = (path: string) => ({ admin }: Fixture) =>
  Effect.map(
    Effect.result(admin.lstat(path)),
    (found) => assert.strictEqual(Result.isFailure(found) ? found.failure.code : "present", "NotFound")
  )

const outcome = Effect.fnUntraced(function*(row: Row, family: "path" | "reference") {
  const fixture = yield* arrange
  const acted = yield* Effect.result(row[family](fixture))

  if (Result.isFailure(acted)) return report(acted.failure)

  if (row.check === undefined) return "ok"
  const checked = yield* Effect.result(row.check(fixture))

  return Result.isFailure(checked) ? `ok, but the check failed with ${report(checked.failure)}` : "ok"
})

const mkdirRows: ReadonlyArray<Row> = [
  {
    scenario: "creates a new entry",
    path: ({ admin }) => admin.mkdir("/dir/new"),
    reference: ({ admin, dir }) => admin.mkdirReference(dir, name("new")),
    check: kindAt("/dir/new", "directory"),
    expected: { path: "ok", reference: "ok" }
  },
  {
    scenario: "rejects an existing name",
    path: ({ admin }) => admin.mkdir("/dir/existing"),
    reference: ({ admin, dir }) => admin.mkdirReference(dir, name("existing")),
    expected: { path: "AlreadyExists at /dir/existing", reference: "AlreadyExists" }
  },
  {
    scenario: "treats a dot name as existing on paths but invalid on references",
    path: ({ admin }) => admin.mkdir("/dir/."),
    reference: ({ admin, dir }) => admin.mkdirReference(dir, name(".")),
    expected: { path: "AlreadyExists at /dir/.", reference: "InvalidArgument" }
  },
  {
    scenario: "treats a dot-dot name as existing on paths but invalid on references",
    path: ({ admin }) => admin.mkdir("/dir/.."),
    reference: ({ admin, dir }) => admin.mkdirReference(dir, name("..")),
    expected: { path: "AlreadyExists at /dir/..", reference: "InvalidArgument" }
  },
  {
    scenario: "accepts a trailing slash on paths, where a reference name cannot hold one",
    path: ({ admin }) => admin.mkdir("/dir/new/"),
    reference: ({ admin, dir }) => admin.mkdirReference(dir, name("new/")),
    check: kindAt("/dir/new", "directory"),
    expected: { path: "ok", reference: "InvalidArgument" }
  },
  {
    scenario: "rejects a parent that is a file",
    path: ({ admin }) => admin.mkdir("/file/new"),
    reference: ({ admin, file }) => admin.mkdirReference(file, name("new")),
    expected: { path: "NotDirectory at /file/new", reference: "NotDirectory" }
  },
  {
    scenario: "reports a removed parent as missing on paths and stale on references",
    path: ({ admin }) => admin.mkdir("/gone/new"),
    reference: ({ admin, gone }) => admin.mkdirReference(gone, name("new")),
    expected: { path: "NotFound at /gone/new", reference: "StaleReference" }
  },
  {
    scenario: "checks a reference name before the parent reference",
    path: ({ admin }) => admin.mkdir("/gone/."),
    reference: ({ admin, gone }) => admin.mkdirReference(gone, name(".")),
    expected: { path: "NotFound at /gone/.", reference: "InvalidArgument" }
  },
  {
    scenario: "denies an unwritable parent before checking an existing name",
    path: ({ guest }) => guest.mkdir("/dir"),
    reference: ({ guest, root }) => guest.mkdirReference(root, name("dir")),
    expected: { path: "AccessDenied at /dir", reference: "AccessDenied" }
  },
  {
    scenario: "denies an unwritable parent before a path dot name but after a reference dot name",
    path: ({ guest }) => guest.mkdir("/."),
    reference: ({ guest, root }) => guest.mkdirReference(root, name(".")),
    expected: { path: "AccessDenied at /.", reference: "InvalidArgument" }
  },
  {
    scenario: "rejects an invalid mode before an existing name",
    path: ({ admin }) => admin.mkdir("/dir/existing", { mode: -1 }),
    reference: ({ admin, dir }) => admin.mkdirReference(dir, name("existing"), { mode: -1 }),
    expected: { path: "InvalidArgument at /dir/existing", reference: "InvalidArgument" }
  }
]

const linkRows: ReadonlyArray<Row> = [
  {
    scenario: "links a file under a new name",
    path: ({ admin }) => admin.link("/file", "/dir/new"),
    reference: ({ admin, file, dir }) => admin.linkReference(file, dir, name("new")),
    check: linksAt("/file", 2),
    expected: { path: "ok", reference: "ok" }
  },
  {
    scenario: "rejects a directory source",
    path: ({ admin }) => admin.link("/dir", "/new"),
    reference: ({ admin, dir, root }) => admin.linkReference(dir, root, name("new")),
    expected: { path: "IsDirectory at /dir", reference: "IsDirectory" }
  },
  {
    scenario: "rejects an existing destination",
    path: ({ admin }) => admin.link("/file", "/dir/existing"),
    reference: ({ admin, file, dir }) => admin.linkReference(file, dir, name("existing")),
    expected: { path: "AlreadyExists at /dir/existing", reference: "AlreadyExists" }
  },
  {
    scenario: "treats a dot destination as existing on paths but invalid on references",
    path: ({ admin }) => admin.link("/file", "/dir/."),
    reference: ({ admin, file, dir }) => admin.linkReference(file, dir, name(".")),
    expected: { path: "AlreadyExists at /dir/.", reference: "InvalidArgument" }
  },
  {
    scenario: "rejects a trailing slash on a path destination",
    path: ({ admin }) => admin.link("/file", "/dir/new/"),
    reference: ({ admin, file, dir }) => admin.linkReference(file, dir, name("new/")),
    expected: { path: "NotDirectory at /dir/new/", reference: "InvalidArgument" }
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
        yield* admin.openReference(file, { access: "read" })
        yield* admin.unlinkReference(root, name("file"))
        yield* admin.linkReference(file, dir, name("new"))
      })),
    expected: { path: "NotFound at /file", reference: "StaleReference" }
  },
  {
    scenario: "checks a reference destination name before the source",
    path: ({ admin }) => admin.link("/dir", "/dir/."),
    reference: ({ admin, dir }) => admin.linkReference(dir, dir, name(".")),
    expected: { path: "IsDirectory at /dir", reference: "InvalidArgument" }
  },
  {
    scenario: "denies an unwritable destination directory",
    path: ({ guest }) => guest.link("/file", "/new"),
    reference: ({ guest, file, root }) => guest.linkReference(file, root, name("new")),
    expected: { path: "AccessDenied at /new", reference: "AccessDenied" }
  }
]

// Its byte limit sits below an eight-byte link target.
const smallVolume = Vfs.make({ maxBytes: ByteSize.bytes(4) }).pipe(
  Effect.flatMap((volume) => volume.caller()),
  Effect.orDie
)

const symlinkRows: ReadonlyArray<Row> = [
  {
    scenario: "creates a link to any target",
    path: ({ admin }) => admin.symlink("/missing", "/dir/new"),
    reference: ({ admin, dir }) => admin.symlinkReference("/missing", dir, name("new")),
    check: targetAt("/dir/new", "/missing"),
    expected: { path: "ok", reference: "ok" }
  },
  {
    scenario: "rejects an existing name",
    path: ({ admin }) => admin.symlink("/missing", "/dir/existing"),
    reference: ({ admin, dir }) => admin.symlinkReference("/missing", dir, name("existing")),
    expected: { path: "AlreadyExists at /dir/existing", reference: "AlreadyExists" }
  },
  {
    scenario: "treats a dot name as existing on paths but invalid on references",
    path: ({ admin }) => admin.symlink("/missing", "/dir/."),
    reference: ({ admin, dir }) => admin.symlinkReference("/missing", dir, name(".")),
    expected: { path: "AlreadyExists at /dir/.", reference: "InvalidArgument" }
  },
  {
    scenario: "rejects a trailing slash on a path",
    path: ({ admin }) => admin.symlink("/missing", "/dir/new/"),
    reference: ({ admin, dir }) => admin.symlinkReference("/missing", dir, name("new/")),
    expected: { path: "NotDirectory at /dir/new/", reference: "InvalidArgument" }
  },
  {
    scenario: "rejects a target holding a NUL byte",
    path: ({ admin }) => admin.symlink("a\0", "/dir/new"),
    reference: ({ admin, dir }) => admin.symlinkReference("a\0", dir, name("new")),
    expected: { path: "InvalidArgument at a\0", reference: "InvalidArgument" }
  },
  {
    scenario: "checks the target before a path's parent but after a reference's name",
    // A lone surrogate cannot be encoded, which only the target check reports.
    path: ({ admin }) => admin.symlink("\uD800", "/gone/new"),
    reference: ({ admin, gone }) => admin.symlinkReference("\uD800", gone, name(".")),
    expected: { path: "InvalidPathEncoding at \uD800", reference: "InvalidArgument" }
  },
  {
    scenario: "denies an unwritable parent before a path dot name but after a reference dot name",
    path: ({ guest }) => guest.symlink("/missing", "/."),
    reference: ({ guest, root }) => guest.symlinkReference("/missing", root, name(".")),
    expected: { path: "AccessDenied at /.", reference: "InvalidArgument" }
  },
  {
    scenario: "reports a removed parent as missing on paths and stale on references",
    path: ({ admin }) => admin.symlink("/missing", "/gone/new"),
    reference: ({ admin, gone }) => admin.symlinkReference("/missing", gone, name("new")),
    expected: { path: "NotFound at /gone/new", reference: "StaleReference" }
  },
  {
    scenario: "reports an existing name before a path's trailing slash",
    path: ({ admin }) => admin.symlink("/missing", "/dir/existing/"),
    reference: ({ admin, dir }) => admin.symlinkReference("/missing", dir, name("existing/")),
    expected: { path: "AlreadyExists at /dir/existing/", reference: "InvalidArgument" }
  },
  {
    scenario: "charges the target bytes against the volume limit",
    path: () => Effect.flatMap(smallVolume, (fs) => fs.symlink("/missing", "/new")),
    reference: () =>
      Effect.flatMap(
        smallVolume,
        (fs) => Effect.flatMap(fs.rootReference, (root) => fs.symlinkReference("/missing", root, name("new")))
      ),
    expected: { path: "NoSpace at /new", reference: "NoSpace" }
  }
]

const unlinkRows: ReadonlyArray<Row> = [
  {
    scenario: "removes a file",
    path: ({ admin }) => admin.unlink("/file"),
    reference: ({ admin, root }) => admin.unlinkReference(root, name("file")),
    check: missingAt("/file"),
    expected: { path: "ok", reference: "ok" }
  },
  {
    scenario: "rejects a missing name",
    path: ({ admin }) => admin.unlink("/dir/missing"),
    reference: ({ admin, dir }) => admin.unlinkReference(dir, name("missing")),
    expected: { path: "NotFound at /dir/missing", reference: "NotFound" }
  },
  {
    scenario: "rejects a directory",
    path: ({ admin }) => admin.unlink("/dir/existing"),
    reference: ({ admin, dir }) => admin.unlinkReference(dir, name("existing")),
    expected: { path: "IsDirectory at /dir/existing", reference: "IsDirectory" }
  },
  {
    scenario: "treats a dot name as a directory on paths but invalid on references",
    path: ({ admin }) => admin.unlink("/dir/."),
    reference: ({ admin, dir }) => admin.unlinkReference(dir, name(".")),
    expected: { path: "IsDirectory at /dir/.", reference: "InvalidArgument" }
  },
  {
    scenario: "rejects a trailing slash on a path to a file",
    path: ({ admin }) => admin.unlink("/file/"),
    reference: ({ admin, root }) => admin.unlinkReference(root, name("file/")),
    expected: { path: "NotDirectory at /file/", reference: "InvalidArgument" }
  },
  {
    scenario: "denies an unwritable parent before a path dot name but after a reference dot name",
    path: ({ guest }) => guest.unlink("/."),
    reference: ({ guest, root }) => guest.unlinkReference(root, name(".")),
    expected: { path: "AccessDenied at /.", reference: "InvalidArgument" }
  },
  {
    scenario: "denies removing another owner's file from a sticky directory",
    path: ({ guest }) => guest.unlink("/sticky/file"),
    reference: ({ guest, sticky }) => guest.unlinkReference(sticky, name("file")),
    expected: { path: "AccessDenied at /sticky/file", reference: "AccessDenied" }
  },
  {
    scenario: "reports a directory before the sticky-directory check",
    path: ({ guest }) => guest.unlink("/sticky/subdir"),
    reference: ({ guest, sticky }) => guest.unlinkReference(sticky, name("subdir")),
    expected: { path: "IsDirectory at /sticky/subdir", reference: "IsDirectory" }
  },
  {
    scenario: "reports a directory before a path's trailing slash",
    path: ({ admin }) => admin.unlink("/dir/existing/"),
    reference: ({ admin, dir }) => admin.unlinkReference(dir, name("existing/")),
    expected: { path: "IsDirectory at /dir/existing/", reference: "InvalidArgument" }
  }
]

const rmdirRows: ReadonlyArray<Row> = [
  {
    scenario: "removes an empty directory",
    path: ({ admin }) => admin.rmdir("/dir/existing"),
    reference: ({ admin, dir }) => admin.rmdirReference(dir, name("existing")),
    check: missingAt("/dir/existing"),
    expected: { path: "ok", reference: "ok" }
  },
  {
    scenario: "rejects a missing name",
    path: ({ admin }) => admin.rmdir("/dir/missing"),
    reference: ({ admin, dir }) => admin.rmdirReference(dir, name("missing")),
    expected: { path: "NotFound at /dir/missing", reference: "NotFound" }
  },
  {
    scenario: "rejects a directory with entries",
    path: ({ admin }) => admin.rmdir("/dir"),
    reference: ({ admin, root }) => admin.rmdirReference(root, name("dir")),
    expected: { path: "NotEmpty at /dir", reference: "NotEmpty" }
  },
  {
    scenario: "rejects a file",
    path: ({ admin }) => admin.rmdir("/file"),
    reference: ({ admin, root }) => admin.rmdirReference(root, name("file")),
    expected: { path: "NotDirectory at /file", reference: "NotDirectory" }
  },
  {
    scenario: "rejects a dot name on both families",
    path: ({ admin }) => admin.rmdir("/dir/."),
    reference: ({ admin, dir }) => admin.rmdirReference(dir, name(".")),
    expected: { path: "InvalidArgument at /dir/.", reference: "InvalidArgument" }
  },
  {
    scenario: "ignores a trailing slash on paths, where a reference name cannot hold one",
    path: ({ admin }) => admin.rmdir("/dir/existing/"),
    reference: ({ admin, dir }) => admin.rmdirReference(dir, name("existing/")),
    check: missingAt("/dir/existing"),
    expected: { path: "ok", reference: "InvalidArgument" }
  },
  {
    scenario: "denies an unwritable parent before looking up the name",
    path: ({ guest }) => guest.rmdir("/missing"),
    reference: ({ guest, root }) => guest.rmdirReference(root, name("missing")),
    expected: { path: "AccessDenied at /missing", reference: "AccessDenied" }
  },
  {
    scenario: "applies the sticky-directory check before the kind check",
    path: ({ guest }) => guest.rmdir("/sticky/file"),
    reference: ({ guest, sticky }) => guest.rmdirReference(sticky, name("file")),
    expected: { path: "AccessDenied at /sticky/file", reference: "AccessDenied" }
  }
]

const renameRows: ReadonlyArray<Row> = [
  {
    scenario: "moves an entry to a new name",
    path: ({ admin }) => admin.rename("/file", "/dir/moved"),
    reference: ({ admin, root, dir }) => admin.renameReference(root, name("file"), dir, name("moved")),
    check: kindAt("/dir/moved", "file"),
    expected: { path: "ok", reference: "ok" }
  },
  {
    scenario: "rejects a missing source",
    path: ({ admin }) => admin.rename("/missing", "/moved"),
    reference: ({ admin, root }) => admin.renameReference(root, name("missing"), root, name("moved")),
    expected: { path: "NotFound at /missing", reference: "NotFound" }
  },
  {
    scenario: "accepts a rename onto the same entry",
    path: ({ admin }) => admin.rename("/file", "/file"),
    reference: ({ admin, root }) => admin.renameReference(root, name("file"), root, name("file")),
    check: kindAt("/file", "file"),
    expected: { path: "ok", reference: "ok" }
  },
  {
    scenario: "skips the sticky-directory check for a rename onto the same entry",
    path: ({ guest }) => guest.rename("/sticky/file", "/sticky/file"),
    reference: ({ guest, sticky }) => guest.renameReference(sticky, name("file"), sticky, name("file")),
    check: kindAt("/sticky/file", "file"),
    expected: { path: "ok", reference: "ok" }
  },
  {
    scenario: "denies moving another owner's entry out of a sticky directory",
    path: ({ guest }) => guest.rename("/sticky/file", "/sticky/moved"),
    reference: ({ guest, sticky }) => guest.renameReference(sticky, name("file"), sticky, name("moved")),
    expected: { path: "AccessDenied at /sticky/file", reference: "AccessDenied" }
  },
  {
    scenario: "rejects a dot source name",
    path: ({ admin }) => admin.rename("/dir/.", "/moved"),
    reference: ({ admin, dir, root }) => admin.renameReference(dir, name("."), root, name("moved")),
    expected: { path: "InvalidArgument at /dir/.", reference: "InvalidArgument" }
  },
  {
    scenario: "rejects a dot destination name",
    path: ({ admin }) => admin.rename("/file", "/dir/.."),
    reference: ({ admin, root, dir }) => admin.renameReference(root, name("file"), dir, name("..")),
    expected: { path: "InvalidArgument at /file", reference: "InvalidArgument" }
  },
  {
    scenario: "rejects replacing a directory with a file",
    path: ({ admin }) => admin.rename("/file", "/dir/existing"),
    reference: ({ admin, root, dir }) => admin.renameReference(root, name("file"), dir, name("existing")),
    expected: { path: "IsDirectory at /dir/existing", reference: "IsDirectory" }
  },
  {
    scenario: "rejects replacing a file with a directory",
    path: ({ admin }) => admin.rename("/dir/existing", "/file"),
    reference: ({ admin, dir, root }) => admin.renameReference(dir, name("existing"), root, name("file")),
    expected: { path: "NotDirectory at /file", reference: "NotDirectory" }
  },
  {
    scenario: "rejects replacing a directory that has entries",
    path: ({ admin }) => admin.rename("/sticky/subdir", "/dir"),
    reference: ({ admin, sticky, root }) => admin.renameReference(sticky, name("subdir"), root, name("dir")),
    expected: { path: "NotEmpty at /dir", reference: "NotEmpty" }
  },
  {
    scenario: "rejects moving a directory into itself",
    path: ({ admin }) => admin.rename("/dir", "/dir/existing/inner"),
    reference: Effect.fnUntraced(function*({ admin, root, dir }) {
      const existing = yield* admin.lookupReference(dir, name("existing"))
      yield* admin.renameReference(root, name("dir"), existing, name("inner"))
    }),
    expected: { path: "InvalidArgument at /dir/existing/inner", reference: "InvalidArgument" }
  },
  {
    scenario: "requires a path destination with a trailing slash to exist",
    path: ({ admin }) => admin.rename("/dir/existing", "/moved/"),
    reference: ({ admin, dir, root }) => admin.renameReference(dir, name("existing"), root, name("moved/")),
    expected: { path: "NotFound at /moved/", reference: "InvalidArgument" }
  },
  {
    scenario: "rejects a trailing slash on a path source that is a file",
    path: ({ admin }) => admin.rename("/file/", "/moved"),
    reference: ({ admin, root }) => admin.renameReference(root, name("file/"), root, name("moved")),
    expected: { path: "NotDirectory at /file/", reference: "InvalidArgument" }
  },
  {
    scenario: "reports a removed source parent as missing on paths and stale on references",
    path: ({ admin }) => admin.rename("/gone/entry", "/moved"),
    reference: ({ admin, gone, root }) => admin.renameReference(gone, name("entry"), root, name("moved")),
    expected: { path: "NotFound at /gone/entry", reference: "StaleReference" }
  },
  {
    scenario: "checks reference names before either directory",
    path: ({ admin }) => admin.rename("/gone/entry", "/dir/."),
    reference: ({ admin, gone, dir }) => admin.renameReference(gone, name("entry"), dir, name(".")),
    expected: { path: "NotFound at /gone/entry", reference: "InvalidArgument" }
  },
  {
    scenario: "prepares both paths before locating either parent",
    path: ({ admin }) => admin.rename("/gone/entry", "\uD800"),
    reference: ({ admin, gone, root }) => admin.renameReference(gone, name("entry"), root, name("moved")),
    expected: { path: "InvalidPathEncoding at \uD800", reference: "StaleReference" }
  }
]

const openRows: ReadonlyArray<Row> = [
  {
    scenario: "creates a missing file",
    path: ({ admin }) => Effect.scoped(admin.open("/dir/new", { access: "write", create: "ifMissing" })),
    reference: ({ admin, dir }) =>
      Effect.scoped(admin.openChildReference(dir, name("new"), { access: "write", create: "ifMissing" })),
    check: kindAt("/dir/new", "file"),
    expected: { path: "ok", reference: "ok" }
  },
  {
    scenario: "opens an existing file",
    path: ({ admin }) => Effect.scoped(admin.open("/file", { access: "read" })),
    reference: ({ admin, root }) => Effect.scoped(admin.openChildReference(root, name("file"), { access: "read" })),
    expected: { path: "ok", reference: "ok" }
  },
  {
    scenario: "rejects a missing file without create",
    path: ({ admin }) => Effect.scoped(admin.open("/dir/missing", { access: "read" })),
    reference: ({ admin, dir }) => Effect.scoped(admin.openChildReference(dir, name("missing"), { access: "read" })),
    expected: { path: "NotFound at /dir/missing", reference: "NotFound" }
  },
  {
    scenario: "rejects an existing file for an exclusive create",
    path: ({ admin }) => Effect.scoped(admin.open("/file", { access: "write", create: "exclusive" })),
    reference: ({ admin, root }) =>
      Effect.scoped(admin.openChildReference(root, name("file"), { access: "write", create: "exclusive" })),
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
        admin.openChildReference(root, name("dangling"), { access: "write", create: "exclusive" })
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
      yield* Effect.scoped(admin.openChildReference(root, name("link"), { access: "write", create: "ifMissing" }))
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
      yield* Effect.scoped(admin.openChildReference(root, name("loop"), { access: "read" }))
    }),
    expected: { path: "SymlinkLoop at /loop", reference: "SymlinkLoop at loop" }
  },
  {
    scenario: "rejects a directory",
    path: ({ admin }) => Effect.scoped(admin.open("/dir", { access: "read" })),
    reference: ({ admin, root }) => Effect.scoped(admin.openChildReference(root, name("dir"), { access: "read" })),
    expected: { path: "IsDirectory at /dir", reference: "IsDirectory" }
  },
  {
    scenario: "treats a dot name as a directory on paths but invalid on references",
    path: ({ admin }) => Effect.scoped(admin.open("/dir/.", { access: "read" })),
    reference: ({ admin, dir }) => Effect.scoped(admin.openChildReference(dir, name("."), { access: "read" })),
    expected: { path: "IsDirectory at /dir/.", reference: "InvalidArgument" }
  },
  {
    scenario: "will not create through a trailing slash",
    path: ({ admin }) => Effect.scoped(admin.open("/dir/new/", { access: "write", create: "ifMissing" })),
    reference: ({ admin, dir }) =>
      Effect.scoped(admin.openChildReference(dir, name("new/"), { access: "write", create: "ifMissing" })),
    expected: { path: "NotFound at /dir/new/", reference: "InvalidArgument" }
  },
  {
    scenario: "rejects a trailing slash on an existing file",
    path: ({ admin }) => Effect.scoped(admin.open("/file/", { access: "read" })),
    reference: ({ admin, root }) => Effect.scoped(admin.openChildReference(root, name("file/"), { access: "read" })),
    expected: { path: "NotDirectory at /file/", reference: "InvalidArgument" }
  },
  {
    scenario: "rejects truncating a read-only open",
    path: ({ admin }) => Effect.scoped(admin.open("/file", { access: "read", truncate: true })),
    reference: ({ admin, root }) =>
      Effect.scoped(admin.openChildReference(root, name("file"), { access: "read", truncate: true })),
    expected: { path: "InvalidArgument at /file", reference: "InvalidArgument" }
  },
  {
    scenario: "rejects a mode without create",
    path: ({ admin }) => Effect.scoped(admin.open("/file", { access: "read", mode: 0o600 })),
    reference: ({ admin, root }) =>
      Effect.scoped(admin.openChildReference(root, name("file"), { access: "read", mode: 0o600 })),
    expected: { path: "InvalidArgument at /file", reference: "InvalidArgument" }
  },
  {
    scenario: "denies creating in an unwritable directory",
    path: ({ guest }) => Effect.scoped(guest.open("/new", { access: "write", create: "ifMissing" })),
    reference: ({ guest, root }) =>
      Effect.scoped(guest.openChildReference(root, name("new"), { access: "write", create: "ifMissing" })),
    expected: { path: "AccessDenied at /new", reference: "AccessDenied" }
  },
  {
    scenario: "reports a removed parent as missing on paths and stale on references",
    path: ({ admin }) => Effect.scoped(admin.open("/gone/new", { access: "write", create: "ifMissing" })),
    reference: ({ admin, gone }) =>
      Effect.scoped(admin.openChildReference(gone, name("new"), { access: "write", create: "ifMissing" })),
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
    reference: ({ admin, file }) => admin.chmodReference(file, 0o600),
    check: ({ admin }) => Effect.map(admin.lstat("/file"), (metadata) => assert.strictEqual(metadata.mode, 0o600)),
    expected: { path: "ok", reference: "ok" }
  },
  {
    scenario: "rejects an invalid mode",
    path: ({ admin }) => admin.chmod("/file", -1),
    reference: ({ admin, file }) => admin.chmodReference(file, -1),
    expected: { path: "InvalidArgument", reference: "InvalidArgument" }
  },
  {
    scenario: "rejects an invalid mode before resolving the target",
    path: ({ admin }) => admin.chmod("/gone", -1),
    reference: ({ admin, gone }) => admin.chmodReference(gone, -1),
    expected: { path: "InvalidArgument", reference: "InvalidArgument" }
  },
  {
    scenario: "denies a caller that does not own the target",
    path: ({ guest }) => guest.chmod("/file", 0o600),
    reference: ({ guest, file }) => guest.chmodReference(file, 0o600),
    expected: { path: "AccessDenied", reference: "AccessDenied" }
  },
  {
    scenario: "reports a removed target as missing on paths and stale on references",
    path: ({ admin }) => admin.chmod("/gone", 0o700),
    reference: ({ admin, gone }) => admin.chmodReference(gone, 0o700),
    expected: { path: "NotFound at /gone", reference: "StaleReference" }
  }
]

const chownRows: ReadonlyArray<Row> = [
  {
    scenario: "changes the owner",
    path: ({ admin }) => admin.chown("/file", { uid: 9 }),
    reference: ({ admin, file }) => admin.chownReference(file, { uid: 9 }),
    check: ({ admin }) => Effect.map(admin.lstat("/file"), (metadata) => assert.strictEqual(metadata.uid, 9)),
    expected: { path: "ok", reference: "ok" }
  },
  {
    scenario: "rejects an invalid owner",
    path: ({ admin }) => admin.chown("/file", { uid: -1 }),
    reference: ({ admin, file }) => admin.chownReference(file, { uid: -1 }),
    expected: { path: "InvalidArgument", reference: "InvalidArgument" }
  },
  {
    scenario: "denies a caller that does not own the target",
    path: ({ guest }) => guest.chown("/file", { gid: 9 }),
    reference: ({ guest, file }) => guest.chownReference(file, { gid: 9 }),
    expected: { path: "AccessDenied", reference: "AccessDenied" }
  },
  {
    scenario: "reports a removed target as missing on paths and stale on references",
    path: ({ admin }) => admin.chown("/gone", { uid: 9 }),
    reference: ({ admin, gone }) => admin.chownReference(gone, { uid: 9 }),
    expected: { path: "NotFound at /gone", reference: "StaleReference" }
  }
]

const utimesRows: ReadonlyArray<Row> = [
  {
    scenario: "sets explicit times",
    path: ({ admin }) => admin.utimes("/file", EXPLICIT_TIMES),
    reference: ({ admin, file }) => admin.utimesReference(file, EXPLICIT_TIMES),
    check: ({ admin }) => Effect.map(admin.lstat("/file"), (metadata) => assert.strictEqual(metadata.mtimeNs, 1n)),
    expected: { path: "ok", reference: "ok" }
  },
  {
    scenario: "denies explicit times to a caller that does not own the target",
    path: ({ guest }) => guest.utimes("/file", EXPLICIT_TIMES),
    reference: ({ guest, file }) => guest.utimesReference(file, EXPLICIT_TIMES),
    expected: { path: "AccessDenied at /file", reference: "AccessDenied" }
  },
  {
    scenario: "lets a caller with write access set both times to now",
    path: ({ guest }) => guest.utimes("/file", NOW_TIMES),
    reference: ({ guest, file }) => guest.utimesReference(file, NOW_TIMES),
    expected: { path: "ok", reference: "ok" }
  },
  {
    scenario: "denies setting times to now without write access",
    path: ({ guest }) => guest.utimes("/", NOW_TIMES),
    reference: ({ guest, root }) => guest.utimesReference(root, NOW_TIMES),
    expected: { path: "AccessDenied at /", reference: "AccessDenied" }
  },
  {
    scenario: "reports a removed target as missing on paths and stale on references",
    path: ({ admin }) => admin.utimes("/gone", EXPLICIT_TIMES),
    reference: ({ admin, gone }) => admin.utimesReference(gone, EXPLICIT_TIMES),
    expected: { path: "NotFound at /gone", reference: "StaleReference" }
  }
]

const accessRows: ReadonlyArray<Row> = [
  {
    scenario: "grants a permitted check",
    path: ({ guest }) => guest.access("/file", 4),
    reference: ({ guest, file }) => guest.accessReference(file, 4),
    expected: { path: "ok", reference: "ok" }
  },
  {
    scenario: "rejects invalid bits",
    path: ({ admin }) => admin.access("/file", 8),
    reference: ({ admin, file }) => admin.accessReference(file, 8),
    expected: { path: "InvalidArgument at /file", reference: "InvalidArgument" }
  },
  {
    scenario: "denies execute on a file without any execute bit, even to an administrator",
    path: ({ admin }) => admin.access("/file", 1),
    reference: ({ admin, file }) => admin.accessReference(file, 1),
    expected: { path: "AccessDenied at /file", reference: "AccessDenied" }
  },
  {
    scenario: "denies a missing permission",
    path: ({ guest }) => guest.access("/", 2),
    reference: ({ guest, root }) => guest.accessReference(root, 2),
    expected: { path: "AccessDenied at /", reference: "AccessDenied" }
  },
  {
    scenario: "reports a removed target as missing on paths and stale on references",
    path: ({ admin }) => admin.access("/gone"),
    reference: ({ admin, gone }) => admin.accessReference(gone),
    expected: { path: "NotFound at /gone", reference: "StaleReference" }
  }
]

const truncateRows: ReadonlyArray<Row> = [
  {
    scenario: "resizes a file",
    path: ({ admin }) => admin.truncate("/file", 4n),
    reference: ({ admin, file }) => admin.truncateReference(file, 4n),
    check: ({ admin }) => Effect.map(admin.lstat("/file"), (metadata) => assert.strictEqual(metadata.size, 4n)),
    expected: { path: "ok", reference: "ok" }
  },
  {
    scenario: "rejects a directory",
    path: ({ admin }) => admin.truncate("/dir", 0n),
    reference: ({ admin, dir }) => admin.truncateReference(dir, 0n),
    expected: { path: "IsDirectory at /dir", reference: "IsDirectory" }
  },
  {
    scenario: "rejects a directory before checking write access",
    path: ({ guest }) => guest.truncate("/", 0n),
    reference: ({ guest, root }) => guest.truncateReference(root, 0n),
    expected: { path: "IsDirectory at /", reference: "IsDirectory" }
  },
  {
    scenario: "rejects a negative length",
    path: ({ admin }) => admin.truncate("/file", -1n),
    reference: ({ admin, file }) => admin.truncateReference(file, -1n),
    expected: { path: "InvalidArgument", reference: "InvalidArgument" }
  },
  {
    scenario: "reports a removed target as missing on paths and stale on references",
    path: ({ admin }) => admin.truncate("/gone", 0n),
    reference: ({ admin, gone }) => admin.truncateReference(gone, 0n),
    expected: { path: "NotFound at /gone", reference: "StaleReference" }
  }
]

const TABLE: ReadonlyArray<readonly [verb: string, rows: ReadonlyArray<Row>]> = [
  ["mkdir", mkdirRows],
  ["link", linkRows],
  ["symlink", symlinkRows],
  ["unlink", unlinkRows],
  ["rmdir", rmdirRows],
  ["rename", renameRows],
  ["open", openRows],
  ["chmod", chmodRows],
  ["chown", chownRows],
  ["utimes", utimesRows],
  ["access", accessRows],
  ["truncate", truncateRows]
]

describe("operation families", () => {
  for (const [verb, rows] of TABLE) {
    describe(verb, () => {
      for (const row of rows) {
        it.effect(row.scenario, () =>
          Effect.gen(function*() {
            const path = yield* outcome(row, "path")
            const reference = yield* outcome(row, "reference")

            assert.deepStrictEqual({ path, reference }, row.expected)
          }))
      }
    })
  }
})
