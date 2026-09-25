import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import { assert, it } from "@effect/vitest"
import { ByteSize, Effect, Layer } from "effect"
import { CheckpointStore } from "../src/index.js"

const limits = {
  maxEncodedBytes: ByteSize.kilobytes(100),
  maxRecords: 100,
  maxEntries: 100,
  maxDecodedBytes: ByteSize.kilobytes(10)
}

// A migrated in-memory database. The suite shares one.
const migrated = Layer.effectDiscard(CheckpointStore.migrate).pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }))
)

it.layer(migrated)("overlay checkpoints", (it) => {
  it.effect("should round trip a complete capture and give restoration a new empty baseline", () =>
    Effect.gen(function*() {
      const store = yield* CheckpointStore.make(limits)
      const raw = yield* Vfs.pathFromBytes(new Uint8Array([47, 255]))

      const source = yield* Vfs.fromFixture({
        rootMetadata: { mode: 0o751, uid: 7, gid: 11 },
        entries: [
          { kind: "file", path: raw, bytes: new Uint8Array([0, 255, 1]), metadata: { mode: 0o640 } },
          { kind: "hardLink", path: "/alias", target: raw },
          { kind: "symlink", path: "/link", target: raw, metadata: { mode: 0o777 } },
          { kind: "hardLink", path: "/link-alias", target: "/link" }
        ]
      })

      const overlay = yield* Vfs.makeOverlay(yield* source.snapshot)
      const fs = yield* overlay.caller()
      yield* fs.writeFile("/alias", new Uint8Array([9, 8, 7]), { access: "write", truncate: true })
      const captured = yield* overlay.capture({ includeTimestamps: true })
      yield* store.save("overlay", captured.snapshot)

      const loaded = yield* store.load("overlay")
      const restored = yield* Vfs.fromSnapshot(loaded)
      const restoredFs = yield* restored.caller()
      assert.deepStrictEqual(yield* restoredFs.readFile(raw), new Uint8Array([9, 8, 7]))
      assert.strictEqual((yield* restoredFs.stat(raw)).ino, (yield* restoredFs.stat("/alias")).ino)
      assert.strictEqual((yield* restoredFs.stat(raw)).mode, 0o640)
      assert.deepStrictEqual(yield* restoredFs.readLink("/link"), new Uint8Array([47, 255]))
      assert.strictEqual(
        (yield* restoredFs.stat(Vfs.Target.Path({ path: "/link", followFinalSymlink: false }))).ino,
        (yield* restoredFs.stat(Vfs.Target.Path({ path: "/link-alias", followFinalSymlink: false }))).ino
      )
      assert.strictEqual(
        (yield* restoredFs.stat(Vfs.Target.Path({ path: "/link", followFinalSymlink: false }))).nlink,
        2
      )
      assert.strictEqual((yield* restoredFs.stat("/")).mode, 0o751)
      assert.strictEqual((yield* restoredFs.stat("/")).uid, 7)
      assert.strictEqual((yield* restoredFs.stat("/")).gid, 11)

      const next = yield* Vfs.makeOverlay(loaded)
      assert.deepStrictEqual(yield* next.changes(), [])
      assert.deepStrictEqual(yield* (yield* next.caller()).readFile("/alias"), new Uint8Array([9, 8, 7]))
      assert.deepStrictEqual(yield* (yield* next.caller()).readLink("/link-alias"), new Uint8Array([47, 255]))
    }))
})
