import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, Layer, Result } from "effect"
import { SafeIntegers, SqlClient } from "effect/unstable/sql/SqlClient"
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
const database = <A, E>(effect: Effect.Effect<A, E, SqlClient>) =>
  effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })))

describe("SQLite checkpoints", () => {
  it.effect("preserves a checkpoint when another save uses the same name", () =>
    database(Effect.gen(function*() {
      yield* CheckpointStore.migrate
      const store = yield* CheckpointStore.make(limits)
      const original = yield* snapshot
      yield* store.save("run", original)
      const empty = yield* (yield* Vfs.make()).snapshot
      const error = yield* Effect.flip(store.save("run", empty))
      assert.instanceOf(error, CheckpointError)
      assert.strictEqual(error.code, "AlreadyExists")
      const restored = yield* (yield* Vfs.fromSnapshot(yield* store.load("run"))).caller()
      assert.deepStrictEqual(yield* restored.readFile("/f"), new Uint8Array([0, 255, 1]))
    })))

  it.effect("allows exactly one of two competing saves to claim a name", () =>
    database(Effect.gen(function*() {
      yield* CheckpointStore.migrate
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
    })))

  it.effect("distinguishes missing checkpoints from database failures", () =>
    database(Effect.gen(function*() {
      yield* CheckpointStore.migrate
      const sql = yield* SqlClient
      const store = yield* CheckpointStore.make(limits)
      const missing = yield* Effect.flip(store.load("absent"))
      assert.instanceOf(missing, CheckpointError)
      assert.strictEqual(missing.code, "NotFound")
      yield* sql`DROP TABLE effect_vfs_checkpoints`
      const failure = yield* Effect.flip(store.load("absent"))
      assert.instanceOf(failure, CheckpointError)
      assert.strictEqual(failure.code, "Storage")
      assert.isDefined(failure.cause)
    })))

  it.effect("keeps names literal and rejects empty, oversized, NUL and lossy names", () =>
    database(Effect.gen(function*() {
      yield* CheckpointStore.migrate
      const store = yield* CheckpointStore.make(limits)
      const image = yield* snapshot
      for (const name of ["", "a".repeat(256), "é".repeat(128), "nul\0name", "\ud800"]) {
        for (const operation of [store.save(name, image), store.load(name)]) {
          const error = yield* Effect.flip(operation)
          assert.instanceOf(error, CheckpointError)
          assert.strictEqual(error.code, "InvalidName")
        }
      }
      for (const name of ["../run/'", "é".repeat(127) + "a", "é", "e\u0301", "\ufeffrun"]) {
        yield* store.save(name, image)
        assert.deepStrictEqual(yield* Vfs.encodeSnapshot(yield* store.load(name)), yield* Vfs.encodeSnapshot(image))
      }
    })))

  it.effect("owns validated limits and permits repeated startup migrations", () =>
    database(Effect.gen(function*() {
      yield* CheckpointStore.migrate
      const mutableLimits = { ...limits }
      const store = yield* CheckpointStore.make(mutableLimits)
      mutableLimits.maxEncodedBytes = ByteSize.zero
      yield* store.save("kept", yield* snapshot)
      yield* CheckpointStore.migrate
      yield* store.load("kept")
      const exactLimit = ByteSize.bytes(BigInt(Number.MAX_SAFE_INTEGER) + 1n)
      const exactStore = yield* CheckpointStore.make({
        ...limits,
        maxEncodedBytes: exactLimit,
        maxDecodedBytes: exactLimit
      })
      yield* exactStore.save("exact", yield* snapshot)
      yield* exactStore.load("exact")
      for (const invalid of [{ ...limits, maxRecords: -1 }, { ...limits, extra: true }]) {
        const error = yield* Effect.flip(CheckpointStore.make(invalid))
        assert.strictEqual(error.code, "InvalidStructure")
        assert.strictEqual(error.field, "limits")
      }
    })))

  it.effect.each([
    { ...limits, maxEncodedBytes: ByteSize.bytes(1) },
    { ...limits, maxRecords: 1 },
    { ...limits, maxEntries: 0 },
    { ...limits, maxDecodedBytes: ByteSize.bytes(2) }
  ])("enforces the same save and load budgets", (bounded) =>
    database(Effect.gen(function*() {
      yield* CheckpointStore.migrate
      const broad = yield* CheckpointStore.make(limits)
      const narrow = yield* CheckpointStore.make(bounded)
      const image = yield* snapshot
      const saveError = yield* Effect.flip(narrow.save("rejected", image))
      assert.instanceOf(saveError, Vfs.ImageError)
      assert.strictEqual(saveError.code, "LimitExceeded")
      assert.strictEqual((yield* Effect.flip(broad.load("rejected"))).code, "NotFound")
      yield* broad.save("stored", image)
      const loadError = yield* Effect.flip(narrow.load("stored"))
      assert.instanceOf(loadError, Vfs.ImageError)
      assert.strictEqual(loadError.code, "LimitExceeded")
    })))

  it.effect("rejects corrupt, unsupported and oversized stored images", () =>
    database(Effect.gen(function*() {
      yield* CheckpointStore.migrate
      const sql = yield* SqlClient
      const store = yield* CheckpointStore.make(limits)
      for (
        const [name, text, code] of [
          ["corrupt", "not json", "InvalidEncoding"],
          ["version", "{\"format\":\"effect-vfs\",\"version\":2}", "UnsupportedVersion"],
          ["graph", "{\"format\":\"effect-vfs\",\"version\":1,\"root\":\"missing\",\"records\":[]}", "InvalidStructure"]
        ] as const
      ) {
        const bytes = new TextEncoder().encode(text)
        yield* sql`INSERT INTO effect_vfs_checkpoints (name, image) VALUES (${name}, ${bytes})`
        const error = yield* Effect.flip(store.load(name))
        assert.instanceOf(error, Vfs.ImageError)
        assert.strictEqual(error.code, code)
      }
      const oversized = ByteSize.toBigInt(limits.maxEncodedBytes) + 1n
      yield* sql`INSERT INTO effect_vfs_checkpoints VALUES ('oversized', zeroblob(${oversized}))`
      const error = yield* Effect.flip(store.load("oversized"))
      assert.instanceOf(error, Vfs.ImageError)
      assert.strictEqual(error.code, "LimitExceeded")
      assert.strictEqual(error.field, "encodedBytes")
    })))

  it.effect("reports a failed insert without damaging existing checkpoints", () =>
    database(Effect.gen(function*() {
      yield* CheckpointStore.migrate
      const sql = yield* SqlClient
      const store = yield* CheckpointStore.make(limits)
      const image = yield* snapshot
      yield* store.save("kept", image)
      yield* sql`CREATE TRIGGER fail_save BEFORE INSERT ON effect_vfs_checkpoints
        BEGIN SELECT RAISE(ABORT, 'injected write failure'); END`
      const error = yield* Effect.flip(store.save("new", image))
      assert.instanceOf(error, CheckpointError)
      assert.strictEqual(error.code, "Storage")
      assert.strictEqual((yield* Effect.flip(store.load("new"))).code, "NotFound")
      assert.deepStrictEqual(yield* Vfs.encodeSnapshot(yield* store.load("kept")), yield* Vfs.encodeSnapshot(image))
    })))

  it.effect("loads under application SQL transforms and safe-integer settings", () =>
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

  it.effect("returns a typed migration error when the checkpoint table conflicts", () =>
    database(Effect.gen(function*() {
      const sql = yield* SqlClient
      yield* sql`CREATE TABLE effect_vfs_checkpoints (unrelated TEXT)`
      const error = yield* Effect.flip(CheckpointStore.migrate)
      assert.strictEqual(error.code, "Storage")
      assert.strictEqual(error.operation, "migrate")
      assert.isDefined(error.cause)
    })))

  it.effect("provides a usable service after the explicit migration layer", () =>
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

  it.effect("rolls back checkpoints with the application's enclosing transaction", () =>
    database(Effect.gen(function*() {
      yield* CheckpointStore.migrate
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
    })))
})
