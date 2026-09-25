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
}

// Builds /dir, /dir/existing, /file and a removed /gone. The root stays 0o755 and owned by uid 0, so the
// guest can search it but not write it.
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

  return { admin, guest, root, dir, file: file.reference, gone } satisfies Fixture
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

const TABLE: ReadonlyArray<readonly [verb: string, rows: ReadonlyArray<Row>]> = [
  ["mkdir", mkdirRows]
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
