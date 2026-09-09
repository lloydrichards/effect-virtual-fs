import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { CheckpointStore } from "@effect-vfs/persistence"
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import { Effect } from "effect"
import * as assert from "node:assert/strict"

const mode = process.argv[2]
const filename = process.argv[3]
if (filename === undefined || (mode !== "save" && mode !== "restore")) {
  throw new Error("Expected save or restore and a database filename")
}

const limits = { maxEncodedBytes: 100_000, maxRecords: 20, maxEntries: 20, maxDecodedBytes: 1_000 }
const metadata = { uid: 7, gid: 11, mode: 0o640, atimeNs: 13n, mtimeNs: 17n, ctimeNs: 19n, birthtimeNs: 23n }
const content = new Uint8Array([0, 255, 128, 1])

const program = Effect.gen(function*() {
  yield* CheckpointStore.migrate
  const store = yield* CheckpointStore.make(limits)
  const binaryPath = yield* Vfs.pathFromBytes(new Uint8Array([47, 100, 105, 114, 47, 255]))
  const rawTarget = yield* Vfs.pathFromBytes(new Uint8Array([254, 47, 120]))

  if (mode === "save") {
    const volume = yield* Vfs.fromFixture({
      rootMetadata: { mode: 0o751 },
      entries: [
        { kind: "directory", path: "/dir", metadata: { mode: 0o750 } },
        { kind: "file", path: binaryPath, bytes: content, metadata },
        { kind: "hardLink", path: "/alias", target: binaryPath },
        { kind: "symlink", path: "/link", target: rawTarget, metadata },
        { kind: "hardLink", path: "/link-alias", target: "/link" }
      ]
    })
    yield* store.save("before", yield* volume.snapshot)
    const caller = yield* volume.caller()
    yield* caller.writeFile("/alias", new Uint8Array([9]), { access: "write", truncate: true })
    yield* caller.unlink("/link")
    yield* Effect.log("saved")
    return
  }

  const snapshot = yield* store.load("before")
  const caller = yield* (yield* Vfs.fromSnapshot(snapshot)).caller()
  assert.equal((yield* caller.stat("/")).mode, 0o751)
  assert.equal((yield* caller.stat("/dir")).mode, 0o750)
  const file = yield* caller.stat(binaryPath)
  for (const field of ["uid", "gid", "mode", "atimeNs", "mtimeNs", "ctimeNs", "birthtimeNs"] as const) {
    assert.equal(file[field], metadata[field])
  }
  assert.equal(file.ino, (yield* caller.stat("/alias")).ino)
  assert.equal(file.nlink, 2)
  assert.deepEqual(yield* caller.readFile(binaryPath), content)
  const link = yield* caller.lstat("/link")
  assert.equal(link.kind, "symlink")
  assert.equal(link.ino, (yield* caller.lstat("/link-alias")).ino)
  assert.equal(link.nlink, 2)
  assert.deepEqual(yield* caller.readLinkBytes("/link"), new Uint8Array([254, 47, 120]))

  yield* caller.writeFile("/alias", new Uint8Array([8]), { access: "write", truncate: true })
  assert.deepEqual(yield* caller.readFile(binaryPath), new Uint8Array([8]))
  const independent = yield* (yield* Vfs.fromSnapshot(yield* store.load("before"))).caller()
  assert.deepEqual(yield* independent.readFile("/alias"), content)
  const failure = yield* Effect.flip(Vfs.fromSnapshot(snapshot, { maxBytes: 3 }))
  assert.ok(failure instanceof Vfs.ImageError)
  assert.equal(failure.code, "LimitExceeded")
  yield* Effect.log("restored")
})

await Effect.runPromise(program.pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
