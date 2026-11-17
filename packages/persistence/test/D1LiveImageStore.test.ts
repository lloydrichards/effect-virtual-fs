/* oxlint-disable effecttsgo/process-env -- Register the workerd integration suite only in its explicit Node runtime job. */
import { LiveVolume } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import * as D1Client from "@effect/sql-d1/D1Client"
import { assert, it } from "@effect/vitest"
import { ByteSize, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path, Schema, Scope } from "effect"
import * as Reactivity from "effect/reactivity/Reactivity"
import { describe } from "vitest"
import * as D1 from "../src/D1LiveImageStore.js"
import { d1Fixture, localDatabase } from "./helpers/d1Fixture.js"
import { liveImageStoreContract } from "./helpers/liveImageStoreContract.js"

const platform = Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer)

describe.skipIf(process.env["VFS_D1_TEST"] !== "1")("D1 integration", () => {
  liveImageStoreContract({
    name: "D1",
    fixture: d1Fixture,
    fractionalGeneration: false,
    pendingWritesCompleteOnClose: true
  })
  it.layer(platform)("D1 statement ownership", (it) => {
    it.effect("shares an injected client while owners and client lifetime stay independent", () =>
      Effect.gen(function*() {
        const f = yield* d1Fixture
        const a = yield* f.open(ByteSize.bytes(16), "a", f.sharedClient)
        const b = yield* f.open(ByteSize.bytes(16), "b", f.sharedClient)
        assert.deepStrictEqual(yield* a.store.loadOrCreate(new Uint8Array([1])), new Uint8Array([1]))
        assert.deepStrictEqual(yield* b.store.loadOrCreate(new Uint8Array([2])), new Uint8Array([2]))
        yield* a.close
        assert.strictEqual(yield* b.store.commit(new Uint8Array([3])), "committed")
        yield* b.close

        const count = yield* f.sharedClient.unsafe<{ count: number }>(
          "SELECT count(*) AS count FROM effect_vfs_live_images"
        )

        assert.strictEqual(count[0]?.count, 2)
        const replacement = yield* f.open(ByteSize.bytes(16), "a", f.sharedClient)
        assert.deepStrictEqual(yield* replacement.store.loadOrCreate(new Uint8Array()), new Uint8Array([1]))
      }))

    it.effect("ignores injected client name transforms for fixed schema and receipts", () =>
      Effect.gen(function*() {
        const f = yield* d1Fixture

        const client = yield* D1Client.make({
          db: f.db,
          transformQueryNames: (name) => `query_${name}`,
          transformResultNames: (name) => `result_${name}`
        }).pipe(Effect.provide(Reactivity.layer))

        const owner = yield* f.open(ByteSize.bytes(16), "transformed", client)
        assert.deepStrictEqual(yield* owner.store.loadOrCreate(new Uint8Array([1])), new Uint8Array([1]))
        assert.strictEqual(yield* owner.store.commit(new Uint8Array([2])), "committed")
        yield* owner.close
        const replacement = yield* f.open(ByteSize.bytes(16), "transformed", client)
        assert.deepStrictEqual(yield* replacement.store.loadOrCreate(new Uint8Array()), new Uint8Array([2]))
      }))

    it.effect("rejects malformed UTF-16 keys before they can alias a valid volume", () =>
      Effect.gen(function*() {
        const f = yield* d1Fixture
        const owner = yield* f.open(ByteSize.bytes(16), "\ufffd")
        yield* owner.store.loadOrCreate(new Uint8Array([7]))
        yield* owner.close
        const statements = f.statementCount()

        for (const key of ["\ud800", "\ud801", "\udc00", "x\udfffy"]) {
          const error = yield* Effect.flip(f.open(ByteSize.bytes(16), key))
          assert.deepStrictEqual([error.code, error.operation, error.field], [
            "InvalidArgument",
            "D1LiveImageStore.layer",
            "key"
          ])
          assert.strictEqual(f.statementCount(), statements)
        }

        const reopened = yield* f.open(ByteSize.bytes(16), "\ufffd")
        assert.deepStrictEqual(yield* reopened.store.loadOrCreate(new Uint8Array()), new Uint8Array([7]))
      }))

    it.effect("keeps valid Unicode keys distinct across acknowledged writes and reopen", () =>
      Effect.gen(function*() {
        const f = yield* d1Fixture
        const keys = ["\ufffd", "workspace-😀", "workspace-😁", "café", "cafe\u0301"]

        for (const [index, key] of keys.entries()) {
          const owner = yield* f.open(ByteSize.bytes(16), key)
          assert.deepStrictEqual(yield* owner.store.loadOrCreate(new Uint8Array([index])), new Uint8Array([index]))
          assert.strictEqual(yield* owner.store.commit(new Uint8Array([index + 10])), "committed")
          yield* owner.close
        }

        for (const [index, key] of keys.entries()) {
          const owner = yield* f.open(ByteSize.bytes(16), key)
          assert.deepStrictEqual(yield* owner.store.loadOrCreate(new Uint8Array()), new Uint8Array([index + 10]))
          yield* owner.close
        }
      }))

    it.effect("admits published table declarations with harmless SQL spelling differences", () =>
      Effect.gen(function*() {
        const f = yield* d1Fixture
        yield* Effect.promise(() =>
          f.db.batch([
            f.db.prepare("DROP TABLE effect_vfs_live_images"),
            f.db.prepare("DROP TABLE effect_vfs_live_images_schema"),
            f.db.prepare(`create table "effect_vfs_live_images" (
            "volume_key" text primary key not null,
            "generation" integer not null,
            "image" blob not null,
            "digest" text not null
          ) strict`),
            f.db.prepare(`create table "effect_vfs_live_images_schema" (
            "id" integer primary key not null check ( "id" = 1 ),
            "version" integer not null check ( "version" = 1 )
          ) strict`),
            f.db.prepare("INSERT INTO effect_vfs_live_images_schema (id, version) VALUES (1, 1)")
          ])
        )
        const owner = yield* f.open()
        assert.deepStrictEqual(yield* owner.store.loadOrCreate(new Uint8Array([1])), new Uint8Array([1]))
        assert.strictEqual(yield* owner.store.commit(new Uint8Array([2])), "committed")
      }))

    for (
      const [name, table, statements] of [
        ["image generation CHECK", "effect_vfs_live_images", [
          "DROP TABLE effect_vfs_live_images",
          "CREATE TABLE effect_vfs_live_images (volume_key TEXT PRIMARY KEY NOT NULL, generation INTEGER NOT NULL CHECK(generation = 0), image BLOB NOT NULL, digest TEXT NOT NULL) STRICT"
        ]],
        ["image foreign key", "effect_vfs_live_images", [
          "DROP TABLE effect_vfs_live_images",
          "CREATE TABLE image_parent (volume_key TEXT PRIMARY KEY) STRICT",
          "CREATE TABLE effect_vfs_live_images (volume_key TEXT PRIMARY KEY NOT NULL REFERENCES image_parent(volume_key) ON DELETE CASCADE, generation INTEGER NOT NULL, image BLOB NOT NULL, digest TEXT NOT NULL) STRICT"
        ]],
        ["escaped identifier in version CHECK", "effect_vfs_live_images_schema", [
          "PRAGMA ignore_check_constraints = ON",
          "DROP TABLE effect_vfs_live_images_schema",
          "CREATE TABLE effect_vfs_live_images_schema (id INTEGER PRIMARY KEY NOT NULL CHECK (\"i\"\"d\" = 1), version INTEGER NOT NULL CHECK (version = 1)) STRICT",
          "INSERT INTO effect_vfs_live_images_schema (id, version) VALUES (1, 1)",
          "PRAGMA ignore_check_constraints = OFF"
        ]],
        ["extra version CHECK", "effect_vfs_live_images_schema", [
          "DROP TABLE effect_vfs_live_images_schema",
          "CREATE TABLE effect_vfs_live_images_schema (id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1), version INTEGER NOT NULL CHECK (version = 1) CHECK(version <= 1)) STRICT",
          "INSERT INTO effect_vfs_live_images_schema (id, version) VALUES (1, 1)"
        ]],
        ["version foreign key", "effect_vfs_live_images_schema", [
          "DROP TABLE effect_vfs_live_images_schema",
          "CREATE TABLE version_parent (id INTEGER PRIMARY KEY) STRICT",
          "INSERT INTO version_parent (id) VALUES (1)",
          "CREATE TABLE effect_vfs_live_images_schema (id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1) REFERENCES version_parent(id) ON DELETE CASCADE, version INTEGER NOT NULL CHECK (version = 1)) STRICT",
          "INSERT INTO effect_vfs_live_images_schema (id, version) VALUES (1, 1)"
        ]]
      ] as const
    ) {
      it.effect(`rejects unsupported ${name} during startup without repairing its declaration`, () =>
        Effect.gen(function*() {
          const f = yield* d1Fixture
          yield* Effect.promise(() => f.db.batch(statements.map((sql) => f.db.prepare(sql))))

          const declaration = () =>
            f.db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").bind(table).all<
              { sql: string }
            >()

          const before = yield* Effect.promise(declaration)
          const error = yield* Effect.flip(f.open())
          assert.deepStrictEqual([error.code, error.operation], ["IncompatibleStore", "D1LiveImageStore.layer"])
          const after = yield* Effect.promise(declaration)
          assert.deepStrictEqual(after.results, before.results)
          assert.strictEqual(f.writeCount(), 0)
        }))
    }

    it.effect("rejects a D1 Session at the runtime boundary", () =>
      Effect.gen(function*() {
        const f = yield* d1Fixture
        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))

        const session = f.db.withSession()
        let statements = 0

        const binding = {
          prepare: (sql: string) => {
            statements++

            return session.prepare(sql)
          },
          batch: session.batch.bind(session)
        }

        const client = yield* D1Client.make({
          // @ts-expect-error Deliberately supply a session to exercise JavaScript admission.
          db: binding
        }).pipe(Effect.provide(Reactivity.layer))

        const error = yield* Effect.flip(Layer.buildWithScope(
          D1.layer({ key: "session", maxImageBytes: ByteSize.bytes(16) }).pipe(
            Layer.provide(Layer.succeed(D1Client.D1Client, client))
          ),
          scope
        ))

        assert.deepStrictEqual([error.code, error.field], ["InvalidArgument", "db"])
        assert.strictEqual(statements, 0)
      }))

    it.effect("runs the bundled qualification Worker inside workerd", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const filename = yield* path.fromFileUrl(new URL("../.cache/d1/worker.js", import.meta.url))
        const source = yield* fs.readFileString(filename)
        const { mf } = yield* localDatabase(source)
        const response = yield* Effect.promise(() => mf.dispatchFetch("https://qualification.example/"))
        const body = yield* Effect.promise(() => response.json())
        assert.strictEqual(response.status, 200)
        assert.deepStrictEqual(
          yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              status: Schema.String,
              primary: Schema.Boolean,
              imageBytes: Schema.Finite,
              generation: Schema.Finite,
              durability: Schema.String
            })
          )(body),
          {
            status: "passed",
            primary: true,
            imageBytes: 1_048_576,
            generation: 2,
            durability: "memory-only"
          }
        )
      }))

    for (
      const [name, statement] of [
        ["missing table", "ALTER TABLE effect_vfs_live_images RENAME TO saved_images"],
        ["missing version", "DELETE FROM effect_vfs_live_images_schema"],
        ["extra column", "ALTER TABLE effect_vfs_live_images ADD COLUMN extra TEXT"],
        [
          "trigger",
          "CREATE TRIGGER change_image AFTER INSERT ON effect_vfs_live_images BEGIN UPDATE effect_vfs_live_images SET digest = 'invalid'; END"
        ]
      ]
    ) {
      it.effect(`refuses ${name} without repairing the schema`, () =>
        Effect.gen(function*() {
          const f = yield* d1Fixture
          yield* Effect.promise(() => f.db.prepare(statement!).run())
          const error = yield* Effect.flip(f.open())
          assert.strictEqual(error.code, "IncompatibleStore")
        }))
    }

    it.effect("refuses a key collation that aliases distinct application owners", () =>
      Effect.gen(function*() {
        const f = yield* d1Fixture
        yield* Effect.promise(() =>
          f.db.batch([
            f.db.prepare("DROP TABLE effect_vfs_live_images"),
            f.db.prepare(
              "CREATE TABLE effect_vfs_live_images (volume_key TEXT COLLATE NOCASE PRIMARY KEY NOT NULL, generation INTEGER NOT NULL, image BLOB NOT NULL, digest TEXT NOT NULL) STRICT"
            )
          ])
        )
        assert.strictEqual((yield* Effect.flip(f.open())).code, "IncompatibleStore")
      }))

    it.effect("reopens filesystem bytes after the previous volume owner closes", () =>
      Effect.gen(function*() {
        const f = yield* d1Fixture
        const owner = yield* f.open(ByteSize.kibibytes(64))
        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))

        const options = {
          maxImageBytes: ByteSize.kibibytes(64),
          volume: {
            maxEntries: 100,
            maxBytes: ByteSize.kibibytes(32),
            maxFileBytes: ByteSize.kibibytes(16),
            maxPathBytes: ByteSize.bytes(1024)
          }
        }

        const volume = yield* Scope.provide(
          LiveVolume.open(options).pipe(Effect.provideService(LiveVolume.LiveImageStore, owner.store)),
          scope
        )

        const caller = yield* volume.caller()
        yield* caller.writeFile("/saved", new Uint8Array([42]), { access: "write", create: "exclusive" })
        assert.strictEqual(volume.durability, "memory-only")
        yield* Scope.close(scope, Exit.void)
        assert.strictEqual((yield* Effect.flip(caller.readFile("/saved"))).code, "VolumeUnavailable")
        yield* owner.close
        const replacement = yield* f.open(ByteSize.kibibytes(64))

        const reopened = yield* LiveVolume.open(options).pipe(
          Effect.provideService(LiveVolume.LiveImageStore, replacement.store)
        )

        assert.deepStrictEqual(yield* (yield* reopened.caller()).readFile("/saved"), new Uint8Array([42]))
      }))

    it.effect("drains a write that completes after caller interruption before releasing ownership", () =>
      Effect.gen(function*() {
        const f = yield* d1Fixture
        const owner = yield* f.open(ByteSize.bytes(16), "contract", f.sharedClient)
        const other = yield* f.open(ByteSize.bytes(16), "other", f.sharedClient)
        yield* other.store.loadOrCreate(new Uint8Array([8]))
        yield* owner.store.loadOrCreate(new Uint8Array([1]))
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        f.hooks.set("write", Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
        const pending = yield* Effect.forkChild(owner.store.commit(new Uint8Array([2])))
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(pending)
        assert.strictEqual(yield* owner.store.commit(new Uint8Array([3])), "unknown")
        const closing = yield* Effect.forkChild(owner.drain)
        yield* Effect.yieldNow
        yield* Effect.gen(function*() {
          assert.isUndefined(closing.pollUnsafe())
          assert.strictEqual(yield* other.store.commit(new Uint8Array([9])), "committed")
          assert.deepStrictEqual((yield* f.persisted)?.image, new Uint8Array([1]))
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
        yield* Fiber.join(closing)
        assert.deepStrictEqual(
          yield* (yield* f.open(ByteSize.bytes(16), "contract", f.sharedClient)).store.loadOrCreate(new Uint8Array()),
          new Uint8Array([2])
        )
      }))
    it.effect("round-trips binary views without adjacent bytes", () =>
      Effect.gen(function*() {
        const f = yield* d1Fixture
        const owner = yield* f.open()
        yield* owner.store.loadOrCreate(new Uint8Array([99, 0, 255, 8]).subarray(1, 3))
        yield* owner.close
        assert.deepStrictEqual(yield* (yield* f.open()).store.loadOrCreate(new Uint8Array()), new Uint8Array([0, 255]))
      }))

    for (const mode of ["generation", "envelope"] as const) {
      it.effect(`freezes a malformed ${mode} receipt after an actual D1 commit`, () =>
        Effect.gen(function*() {
          const f = yield* d1Fixture
          const owner = yield* f.open()
          yield* owner.store.loadOrCreate(new Uint8Array([1]))
          f.corruptReceipt(mode)
          assert.strictEqual(yield* owner.store.commit(new Uint8Array([2])), "unknown")
          assert.strictEqual(yield* owner.store.commit(new Uint8Array([3])), "unknown")
          yield* owner.close
          assert.deepStrictEqual(yield* (yield* f.open()).store.loadOrCreate(new Uint8Array()), new Uint8Array([2]))
        }))
    }

    for (const image of [[256], [-1], [1.5], [1, 2], "not bytes"]) {
      it.effect(`rejects malformed BLOB ${String(image)} before byte conversion`, () =>
        Effect.gen(function*() {
          const f = yield* d1Fixture
          const owner = yield* f.open()
          yield* owner.store.loadOrCreate(new Uint8Array([1]))
          yield* owner.close
          f.corruptBlob(image)
          assert.strictEqual(
            (yield* Effect.flip((yield* f.open()).store.loadOrCreate(new Uint8Array()))).code,
            "CorruptStore"
          )
        }))
    }

    it.effect("admits the 1 MiB image budget and refuses a larger configured limit", () =>
      Effect.gen(function*() {
        const f = yield* d1Fixture
        assert.strictEqual((yield* Effect.flip(f.open(ByteSize.bytes(1_048_577)))).code, "InvalidArgument")
        const owner = yield* f.open(ByteSize.mebibytes(1))
        const bytes = new Uint8Array(1_048_576)
        bytes[bytes.length - 1] = 255
        yield* owner.store.loadOrCreate(bytes)
        yield* owner.close
        assert.deepStrictEqual(
          yield* (yield* f.open(ByteSize.mebibytes(1))).store.loadOrCreate(new Uint8Array()),
          bytes
        )
      }))
  })
})
