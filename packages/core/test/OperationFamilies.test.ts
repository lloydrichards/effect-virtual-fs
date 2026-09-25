import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, Result } from "effect"
import { Testing, type VfsError as VfsErrorModule, VirtualFileSystem as Vfs } from "../src/index.js"
import { pathText } from "./support/text.js"

// Path-addressed and reference-addressed verbs share one mutation body, but each family keeps its own
// validation order and error codes. Each row pins what both families report for the same situation, so a
// difference is recorded here instead of being lost or "fixed" when the bodies merge. A failure reads as its
// code, followed by the path it names when it names one. Errors carry paths as bytes, so an unencodable
// string input is named by its replacement encoding.

const name = (value: string) => new TextEncoder().encode(value)

const GUEST = { uid: 9, gid: 9, groups: [], privileged: false } as const

type FsError = VfsErrorModule.VfsError

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

  return { admin, guest, root, dir, file: file.reference, gone, sticky } satisfies Fixture
}).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } })))

interface Row {
  readonly scenario: string
  // A row may build its own volume when the fixture's cannot express the situation.
  readonly path: (fixture: Fixture) => Effect.Effect<unknown, FsError>
  readonly reference: (fixture: Fixture) => Effect.Effect<unknown, FsError>
  // Confirms a successful operation took effect, on the fixture it ran against.
  readonly check?: (fixture: Fixture) => Effect.Effect<unknown, FsError>
  readonly expected: { readonly path: string; readonly reference: string }
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

const outcome = Effect.fnUntraced(function*(row: Row, family: "path" | "reference") {
  const fixture = yield* arrange
  const acted = yield* Effect.result(row[family](fixture))

  if (Result.isFailure(acted)) return yield* report(acted.failure)

  if (row.check === undefined) return "ok"
  const checked = yield* Effect.result(row.check(fixture))

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
const smallVolume = Vfs.Caller.pipe(
  Effect.provide(Testing.layer({ volume: { maxBytes: ByteSize.bytes(4) } })),
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
    path: () => Effect.flatMap(smallVolume, (fs) => fs.symlink("/missing", "/new")),
    reference: () =>
      Effect.flatMap(
        smallVolume,
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
    reference: ({ admin, root, dir }) => admin.rename(Vfs.Entry(root, name("file")), Vfs.Entry(dir, name("existing"))),
    expected: { path: "IsDirectory at /dir/existing", reference: "IsDirectory" }
  },
  {
    scenario: "rejects replacing a file with a directory",
    path: ({ admin }) => admin.rename("/dir/existing", "/file"),
    reference: ({ admin, dir, root }) => admin.rename(Vfs.Entry(dir, name("existing")), Vfs.Entry(root, name("file"))),
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
    reference: ({ admin, gone, root }) => admin.rename(Vfs.Entry(gone, name("entry")), Vfs.Entry(root, name("moved"))),
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
    reference: ({ admin, gone, root }) => admin.rename(Vfs.Entry(gone, name("entry")), Vfs.Entry(root, name("moved"))),
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
    expected: { path: "ok", reference: "ok" }
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
    check: ({ admin }) => Effect.map(admin.access("/file", 1), (granted) => assert.strictEqual(granted, 0)),
    expected: { path: "ok", reference: "ok" }
  },
  {
    // #186 decision 16: access answers with the granted bits instead of failing.
    scenario: "grants nothing for a missing permission",
    path: ({ guest }) => guest.access("/", 2),
    reference: ({ guest, root }) => guest.access(root, 2),
    check: ({ guest }) => Effect.map(guest.access("/", 2), (granted) => assert.strictEqual(granted, 0)),
    expected: { path: "ok", reference: "ok" }
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
    path: () =>
      Effect.flatMap(
        smallVolume,
        (fs) =>
          Effect.andThen(
            fs.writeFile("/f", new Uint8Array(), { access: "write", create: "exclusive" }),
            fs.setattr("/f", { size: 8n })
          )
      ),
    reference: () =>
      Effect.flatMap(smallVolume, (fs) =>
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
    path: ({ guest }) => guest.setattr("/file", { size: 2n, times: NOW_TIMES }),
    reference: ({ guest, file }) => guest.setattr(file, { size: 2n, times: NOW_TIMES }),
    check: metadataAt("/file", ({ size }) => size, 2n),
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
  ["truncate", truncateRows],
  ["setattr", setattrRows]
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
