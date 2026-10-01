import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import { assert, it } from "@effect/vitest"
import { ByteSize, Effect, FileSystem, Layer, Path, Result, Stream } from "effect"
import type * as Crypto from "effect/Crypto"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { SafeIntegers, SqlClient } from "effect/sql/SqlClient"
import { CheckpointError, CheckpointStore } from "../src/index.js"

const limits = {
  maxEncodedBytes: ByteSize.kilobytes(100),
  maxRecords: 100,
  maxEntries: 100,
  maxDecodedBytes: ByteSize.kilobytes(10)
}

const snapshot = Effect.gen(function*() {
  const volume = yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/f", bytes: new Uint8Array([0, 255, 1]) }] })

  return yield* volume.snapshot
})

// A migrated in-memory database. The suite shares one.
const migrated = Layer.effectDiscard(CheckpointStore.migrate).pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  Layer.provideMerge(NodeCrypto.layer)
)

// A test that alters the table or its migration state takes a database of its own. `Layer.fresh` keeps it from
// reusing the suite's database through the shared memo map.
const freshDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient | Crypto.Crypto>) =>
  effect.pipe(Effect.provide(Layer.fresh(migrated)))

const unmigratedDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient | Crypto.Crypto>) =>
  effect.pipe(Effect.provide(Layer.fresh(SqliteClient.layer({ filename: ":memory:" }))))

const files = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const platform = Layer.mergeAll(files, NodeChildProcessSpawner.layer.pipe(Layer.provide(files)))

it.layer(migrated)("SQLite checkpoints", (it) => {
  it.effect("should preserve a checkpoint when another save uses its name", () =>
    Effect.gen(function*() {
      const store = yield* CheckpointStore.make(limits)
      const original = yield* snapshot
      yield* store.save("run", original)
      const empty = yield* (yield* Vfs.make()).snapshot
      const error = yield* Effect.flip(store.save("run", empty))
      assert.instanceOf(error, CheckpointError)
      assert.deepStrictEqual([error.code, error.operation], ["AlreadyExists", "CheckpointStore.save"])
      const restored = yield* (yield* Vfs.fromSnapshot(yield* store.load("run"))).caller()
      assert.deepStrictEqual(yield* restored.readFile("/f"), new Uint8Array([0, 255, 1]))
    }))

  it.effect("should allow one save to claim a name when saves compete", () =>
    Effect.gen(function*() {
      const store = yield* CheckpointStore.make(limits)
      const a = yield* snapshot
      const b = yield* (yield* Vfs.make()).snapshot

      const results = yield* Effect.forEach([store.save("race", a), store.save("race", b)], Effect.result, {
        concurrency: "unbounded"
      })

      assert.strictEqual(results.filter(Result.isSuccess).length, 1)
      const failures = results.filter(Result.isFailure)
      assert.strictEqual(failures.length, 1)
      assert.instanceOf(failures[0]?.failure, CheckpointError)
      assert.strictEqual(failures[0].failure.code, "AlreadyExists")
      const saved = yield* Vfs.encodeSnapshot(yield* store.load("race"))
      const first = results[0]
      assert.isDefined(first)
      assert.deepStrictEqual(saved, yield* Vfs.encodeSnapshot(Result.isSuccess(first) ? a : b))
    }))

  it.effect("should report NotFound when a checkpoint is absent", () =>
    freshDatabase(Effect.gen(function*() {
      const store = yield* CheckpointStore.make(limits)
      const missing = yield* Effect.flip(store.load("absent"))
      assert.instanceOf(missing, CheckpointError)
      assert.deepStrictEqual([missing.code, missing.operation], ["NotFound", "CheckpointStore.load"])
    })))

  it.effect("should report Storage when the checkpoint table is unavailable", () =>
    freshDatabase(Effect.gen(function*() {
      const sql = yield* SqlClient
      const store = yield* CheckpointStore.make(limits)
      yield* sql`DROP TABLE effect_vfs_checkpoints`
      const failure = yield* Effect.flip(store.load("absent"))
      assert.instanceOf(failure, CheckpointError)
      assert.deepStrictEqual([failure.code, failure.operation], ["Storage", "CheckpointStore.load"])
      assert.isDefined(failure.cause)
    })))

  // Takes its own database: the Bun SQLite driver drops a leading U+FEFF from bound text, so "\ufeffrun" would
  // collide with the "run" checkpoint another test saves in the suite's database (#218).
  it.effect("should keep valid names literal and reject invalid names when saving or loading", () =>
    freshDatabase(Effect.gen(function*() {
      const store = yield* CheckpointStore.make(limits)
      const image = yield* snapshot

      for (const name of ["", "a".repeat(256), "é".repeat(128), "nul\0name", "\ud800"]) {
        for (
          const [entry, operation] of [
            ["CheckpointStore.save", store.save(name, image)],
            ["CheckpointStore.load", store.load(name)]
          ] as const
        ) {
          const error = yield* Effect.flip(operation)
          assert.instanceOf(error, CheckpointError)
          assert.deepStrictEqual([error.code, error.operation], ["InvalidName", entry])
        }
      }

      for (const name of ["../run/'", "é".repeat(127) + "a", "é", "e\u0301", "\ufeffrun"]) {
        yield* store.save(name, image)
        assert.deepStrictEqual(yield* Vfs.encodeSnapshot(yield* store.load(name)), yield* Vfs.encodeSnapshot(image))
      }
    })))

  it.effect("should retain its original limits when the supplied limits object changes", () =>
    Effect.gen(function*() {
      const mutableLimits = { ...limits }
      const store = yield* CheckpointStore.make(mutableLimits)
      mutableLimits.maxEncodedBytes = ByteSize.zero
      yield* store.save("kept", yield* snapshot)
      yield* store.load("kept")
    }))

  it.effect("should accept exact large byte limits when they exceed safe integers", () =>
    Effect.gen(function*() {
      const exactLimit = ByteSize.bytes(BigInt(Number.MAX_SAFE_INTEGER) + 1n)

      const exactStore = yield* CheckpointStore.make({
        ...limits,
        maxEncodedBytes: exactLimit,
        maxDecodedBytes: exactLimit
      })

      yield* exactStore.save("exact", yield* snapshot)
      yield* exactStore.load("exact")
    }))

  it.effect("should preserve checkpoints when startup migration runs again", () =>
    Effect.gen(function*() {
      const store = yield* CheckpointStore.make(limits)
      yield* store.save("migration-retry", yield* snapshot)
      yield* CheckpointStore.migrate
      yield* store.load("migration-retry")
    }))

  it.effect("should name limits when checkpoint configuration is invalid", () =>
    Effect.gen(function*() {
      for (const invalid of [{ ...limits, maxRecords: -1 }, { ...limits, extra: true }]) {
        const error = yield* Effect.flip(CheckpointStore.make(invalid))
        assert.strictEqual(error.code, "InvalidArgument")
        assert.strictEqual(error.operation, "CheckpointStore.make")
        assert.strictEqual(error.field, "limits")
      }
    }))

  // Each case names its checkpoints, since the cases share the suite's database.
  it.effect.each([
    { budget: "maxEncodedBytes", bounded: { ...limits, maxEncodedBytes: ByteSize.bytes(1) } },
    { budget: "maxRecords", bounded: { ...limits, maxRecords: 1 } },
    { budget: "maxEntries", bounded: { ...limits, maxEntries: 0 } },
    { budget: "maxDecodedBytes", bounded: { ...limits, maxDecodedBytes: ByteSize.bytes(2) } },
    { budget: "maxLineBytes", bounded: { ...limits, maxLineBytes: ByteSize.bytes(16) } }
  ])("should enforce $budget when saving and loading checkpoints", ({ budget, bounded }) =>
    Effect.gen(function*() {
      const broad = yield* CheckpointStore.make(limits)
      const narrow = yield* CheckpointStore.make(bounded)
      const image = yield* snapshot
      const saveError = yield* Effect.flip(narrow.save(`rejected-${budget}`, image))
      assert.instanceOf(saveError, Vfs.VfsError)
      assert.deepStrictEqual([saveError.code, saveError.operation], ["LimitExceeded", "CheckpointStore.save"])
      assert.strictEqual((yield* Effect.flip(broad.load(`rejected-${budget}`))).code, "NotFound")
      yield* broad.save(`stored-${budget}`, image)
      const loadError = yield* Effect.flip(narrow.load(`stored-${budget}`))
      assert.instanceOf(loadError, Vfs.VfsError)
      assert.deepStrictEqual([loadError.code, loadError.operation], ["LimitExceeded", "CheckpointStore.load"])
    }))

  it.effect("should reject malformed and historical images when loading checkpoints", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient
      const store = yield* CheckpointStore.make(limits)

      for (
        const [name, text, code] of [
          ["corrupt", "not json\n", "InvalidEncoding"],
          ["version", "{\"format\":\"effect-vfs\",\"version\":2}\n", "UnsupportedVersion"],
          ["graph", "{\"format\":\"effect-vfs\",\"version\":1}\n", "InvalidStructure"],
          // The record layout version 1 had before it became a tree no longer decodes, nor does the tree as one
          // document before it became lines.
          ["records", "{\"format\":\"effect-vfs\",\"version\":1,\"root\":\"0\",\"records\":[]}\n", "InvalidStructure"],
          ["document", "{\"format\":\"effect-vfs\",\"version\":1,\"nodes\":[]}\n", "InvalidStructure"]
        ] as const
      ) {
        const bytes = new TextEncoder().encode(text)
        yield* sql`INSERT INTO effect_vfs_checkpoints (name, image) VALUES (${name}, ${bytes})`
        const error = yield* Effect.flip(store.load(name))
        assert.instanceOf(error, Vfs.VfsError)
        assert.deepStrictEqual([error.code, error.operation], [code, "CheckpointStore.load"])
      }
    }))

  it.effect("should reject an oversized stored BLOB when loading a checkpoint", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient
      const store = yield* CheckpointStore.make(limits)
      const oversized = ByteSize.toBigInt(limits.maxEncodedBytes) + 1n
      yield* sql`INSERT INTO effect_vfs_checkpoints VALUES ('oversized', zeroblob(${oversized}))`
      const error = yield* Effect.flip(store.load("oversized"))
      assert.instanceOf(error, Vfs.VfsError)
      assert.strictEqual(error.code, "LimitExceeded")
      assert.strictEqual(error.operation, "CheckpointStore.load")
      assert.strictEqual(error.field, "encodedBytes")
    }))

  // The table's CHECK constraint keeps a non-blob image out, so only a foreign or legacy writer stores one.
  it.effect("should report InvalidStructure when a stored image is not a BLOB", () =>
    freshDatabase(Effect.gen(function*() {
      const sql = yield* SqlClient
      const store = yield* CheckpointStore.make(limits)
      yield* sql`PRAGMA ignore_check_constraints = ON`
      yield* sql`INSERT INTO effect_vfs_checkpoints (name, image) VALUES ('text', 'x')`
      const error = yield* Effect.flip(store.load("text"))
      assert.instanceOf(error, Vfs.VfsError)
      assert.deepStrictEqual([error.code, error.operation, error.field], [
        "InvalidStructure",
        "CheckpointStore.load",
        "image"
      ])
    })))

  it.effect("should preserve existing checkpoints when a new insert fails", () =>
    freshDatabase(Effect.gen(function*() {
      const sql = yield* SqlClient
      const store = yield* CheckpointStore.make(limits)
      const image = yield* snapshot
      yield* store.save("kept", image)
      yield* sql`CREATE TRIGGER fail_save BEFORE INSERT ON effect_vfs_checkpoints
        BEGIN SELECT RAISE(ABORT, 'injected write failure'); END`
      const error = yield* Effect.flip(store.save("new", image))
      assert.instanceOf(error, CheckpointError)
      assert.deepStrictEqual([error.code, error.operation], ["Storage", "CheckpointStore.save"])
      assert.strictEqual((yield* Effect.flip(store.load("new"))).code, "NotFound")
      assert.deepStrictEqual(yield* Vfs.encodeSnapshot(yield* store.load("kept")), yield* Vfs.encodeSnapshot(image))
    })))

  it.effect("should load a checkpoint when application SQL transforms and safe integers are enabled", () =>
    Effect.gen(function*() {
      yield* CheckpointStore.migrate
      const store = yield* CheckpointStore.make(limits)
      const image = yield* snapshot
      yield* store.save("configured", image)
      yield* CheckpointStore.migrate
      assert.deepStrictEqual(
        yield* Vfs.encodeSnapshot(yield* store.load("configured")),
        yield* Vfs.encodeSnapshot(image)
      )
    }).pipe(
      Effect.provideService(SafeIntegers, true),
      Effect.provide(SqliteClient.layer({ filename: ":memory:", transformResultNames: (name) => name.toUpperCase() }))
    ))

  it.effect("should report Storage when migration finds a conflicting checkpoint table", () =>
    unmigratedDatabase(Effect.gen(function*() {
      const sql = yield* SqlClient
      yield* sql`CREATE TABLE effect_vfs_checkpoints (unrelated TEXT)`
      const error = yield* Effect.flip(CheckpointStore.migrate)
      assert.strictEqual(error.code, "Storage")
      assert.strictEqual(error.operation, "CheckpointStore.migrate")
      assert.isDefined(error.cause)
    })))

  it.effect("should provide a usable checkpoint service when migration runs explicitly", () =>
    Effect.gen(function*() {
      const store = yield* CheckpointStore
      const image = yield* snapshot
      yield* store.save("layer", image)
      assert.deepStrictEqual(yield* Vfs.encodeSnapshot(yield* store.load("layer")), yield* Vfs.encodeSnapshot(image))
    }).pipe(Effect.provide(
      CheckpointStore.layer(limits).pipe(
        Layer.provide(Layer.effectDiscard(CheckpointStore.migrate)),
        Layer.provide(SqliteClient.layer({ filename: ":memory:" }))
      )
    )))

  it.effect("should roll back a checkpoint when the application transaction aborts", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient
      const store = yield* CheckpointStore.make(limits)
      const image = yield* snapshot

      const error = yield* Effect.flip(sql.withTransaction(Effect.gen(function*() {
        yield* store.save("rolled-back", image)

        return yield* Effect.fail("abort")
      })))

      assert.strictEqual(error, "abort")
      assert.strictEqual((yield* Effect.flip(store.load("rolled-back"))).code, "NotFound")
      yield* store.save("rolled-back", image)
    }))

  it.effect("should restore a complete capture with an empty overlay baseline when loaded from a checkpoint", () =>
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

it.layer(platform, { excludeTestServices: true })("checkpoint process restart", (it) => {
  it.effect(
    "should restore the saved namespace without later mutations when a fresh process loads a checkpoint",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const filesystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const directory = yield* filesystem.makeTempDirectoryScoped({ prefix: "effect-vfs-restart-" })
        const database = path.join(directory, "checkpoints.sqlite")
        const worker = yield* path.fromFileUrl(new URL("./fixtures/restart.ts", import.meta.url))

        // A worker that logs its marker and then fails while closing its database must still fail the test.
        const run = (mode: "save" | "restore") =>
          Effect.scoped(Effect.gen(function*() {
            const child = yield* spawner.spawn(ChildProcess.make("bun", [worker, mode, database]))
            const output = yield* Stream.mkString(Stream.decodeText(child.stdout))
            assert.strictEqual(yield* child.exitCode, 0)

            return output
          })).pipe(Effect.timeout("5 seconds"))

        assert.include(yield* run("save"), "saved")
        assert.include(yield* run("restore"), "restored")
      })),
    15_000
  )
})
