import { LiveVolume, VfsError } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import { assert, it } from "@effect/vitest"
import {
  ByteSize,
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Predicate,
  Schema,
  Scope
} from "effect"
import * as Digest from "effect/crypto/Digest"
import { SqlClient } from "effect/sql/SqlClient"
import { ConnectionError, SqlError } from "effect/sql/SqlError"
import * as R2 from "../src/R2LiveImageStore.js"
import * as Sqlite from "../src/SqliteLiveImageStore.js"

type Phase = "read" | "write" | "update" | "ack"

const initial = new Uint8Array([1, 2, 3])

const next = new Uint8Array([4, 5, 6])

const limit = 16

const failure = () => VfsError.make({ code: "Storage", operation: "contract transport" })

const platform = Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer)

const fixture = Effect.fnUntraced(function*(backend: "SQLite" | "R2") {
  const hooks = new Map<Phase, Effect.Effect<void, VfsError.StoreFailure>>()
  let writes = 0
  let reads = 0

  const phase = (name: Phase) =>
    Effect.suspend(() => {
      if (name === "write") writes++

      if (name === "read") reads++
      const hook = hooks.get(name)
      hooks.delete(name)

      return hook ?? Effect.void
    })

  let object: R2.ObjectRecord | null = null
  let revision = 0

  const client: R2.R2Client = {
    read: () => phase("read").pipe(Effect.andThen(Effect.sync(() => object))),
    write: Effect.fnUntraced(function*(_key, image, generation, digest, condition) {
      yield* phase("write")

      if ("ifNoneMatch" in condition ? object !== null : object?.etag !== condition.ifMatch) return null
      object = { bytes: new Uint8Array(image), generation, digest, etag: String(++revision) }
      const etag = object.etag
      yield* phase("ack")

      return { etag }
    })
  }

  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped()
  const filename = path.join(directory, "contract.sqlite")

  let execute: (statement: string, params?: ReadonlyArray<unknown>) => Effect.Effect<unknown, SqlError> = () =>
    Effect.void

  const layer = (maxImageBytes: ByteSize.ByteSize) => {
    if (backend === "R2") {
      return R2.layer({ key: "contract", maxImageBytes }).pipe(Layer.provide(Layer.succeed(R2.Client, client)))
    }

    const sql = Layer.effect(
      SqlClient,
      Effect.map(SqlClient, (client) =>
        Object.assign(client, {
          reserve: Effect.map(client.reserve, (connection) => {
            execute = (statement, params = []) => connection.executeRaw(statement, params)

            return {
              ...connection,
              executeRaw: Effect.fnUntraced(function*(statement: string, params: ReadonlyArray<unknown>) {
                if (statement.includes("typeof(image)")) {
                  yield* phase("read").pipe(
                    Effect.mapError((cause) => new SqlError({ reason: new ConnectionError({ cause }) }))
                  )
                }

                if (statement === "BEGIN IMMEDIATE") {
                  yield* phase("write").pipe(
                    Effect.mapError((cause) => new SqlError({ reason: new ConnectionError({ cause }) }))
                  )
                }

                const result = yield* connection.executeRaw(statement, params)

                if (
                  statement.startsWith("INSERT INTO effect_vfs_live_image") ||
                  statement.startsWith("UPDATE effect_vfs_live_image")
                ) {
                  yield* phase("update").pipe(
                    Effect.mapError((cause) => new SqlError({ reason: new ConnectionError({ cause }) }))
                  )
                }

                if (statement === "COMMIT") {
                  yield* phase("ack").pipe(
                    Effect.mapError((cause) => new SqlError({ reason: new ConnectionError({ cause }) }))
                  )
                }

                return result
              })
            }
          })
        }))
    ).pipe(Layer.provide(SqliteClient.layer({ filename, disableWAL: true, busyTimeout: 0 })))

    return Sqlite.layer({ filename, maxImageBytes, maxDatabaseBytes: ByteSize.megabytes(2) }).pipe(Layer.provide(sql))
  }

  const open = Effect.fnUntraced(function*(maxImageBytes = ByteSize.bytes(limit)) {
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
    const context = yield* Layer.buildWithScope(layer(maxImageBytes), scope)

    return { store: Context.get(context, LiveVolume.LiveImageStore), close: Scope.close(scope, Exit.void) }
  })

  const damage = Effect.fnUntraced(
    function*(field: "generation" | "digest" | "image", value: string | number | Uint8Array) {
      if (backend === "SQLite") {
        yield* execute(`UPDATE effect_vfs_live_image SET ${field} = ? WHERE id = 1`, [value]).pipe(Effect.orDie)
      } else if (object !== null) {
        if (field === "generation") object = { ...object, generation: String(value), etag: String(++revision) }
        else if (field === "digest") object = { ...object, digest: String(value) }
        else if (value instanceof Uint8Array) object = { ...object, bytes: value }
      }
    }
  )

  return {
    hooks,
    persisted: Effect.suspend(() =>
      backend === "R2"
        ? Effect.succeed(object === null ? undefined : { generation: Number(object.generation), image: object.bytes })
        : execute("SELECT generation, image FROM effect_vfs_live_image WHERE id = 1").pipe(
          Effect.orDie,
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({
            generation: Schema.Finite,
            image: Schema.Uint8Array
          })))),
          Effect.map((rows) => rows[0]),
          Effect.orDie
        )
    ),
    writeCount: () => writes,
    readCount: () => reads,
    open,
    damage,
    operation: backend === "SQLite" ? "SqliteLiveImageStore.loadOrCreate" : "R2LiveImageStore.loadOrCreate"
  }
})

const gate = Effect.gen(function*() {
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()

  return {
    entered: Deferred.await(entered),
    release: Deferred.succeed(release, undefined),
    hold: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
  }
})

const assertInterrupted = (exit: Exit.Exit<unknown, unknown>) => {
  assert.isTrue(Exit.isFailure(exit))

  if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterrupts(exit.cause))
}

for (const backend of ["SQLite", "R2"] as const) {
  it.layer(platform)(`${backend} live-image contract`, (it) => {
    it.effect("creates, commits, copies, and reopens the acknowledged image", () =>
      Effect.gen(function*() {
        const f = yield* fixture(backend)
        const { store, close } = yield* f.open()
        assert.strictEqual(store.durability, "memory-only")
        assert.strictEqual(yield* store.commit(initial), "unknown")
        const loaded = yield* store.loadOrCreate(initial)
        loaded[0] = 99
        assert.deepStrictEqual(initial, new Uint8Array([1, 2, 3]))
        assert.strictEqual((yield* f.persisted)?.generation, 0)
        assert.strictEqual(yield* store.commit(next), "committed")
        assert.strictEqual((yield* f.persisted)?.generation, 1)
        yield* close
        const reopened = yield* f.open()
        assert.deepStrictEqual(yield* reopened.store.loadOrCreate(new Uint8Array(limit + 1)), next)
        const error = yield* Effect.flip(reopened.store.loadOrCreate(initial))
        assert.deepStrictEqual([error.code, error.operation], ["Ownership", f.operation])
      }))
    it.effect("returns copies when creating and loading an existing image", () =>
      Effect.gen(function*() {
        const f = yield* fixture(backend)
        const created = yield* f.open()
        const first = yield* created.store.loadOrCreate(initial)
        first[0] = 99
        yield* created.close
        const existing = yield* f.open()
        const second = yield* existing.store.loadOrCreate(next)
        assert.deepStrictEqual(second, initial)
        second[1] = 99
        yield* existing.close
        assert.deepStrictEqual(yield* (yield* f.open()).store.loadOrCreate(next), initial)
      }))
    it.effect("rejects oversized initial input before writing and permits retry", () =>
      Effect.gen(function*() {
        const f = yield* fixture(backend)
        const { store } = yield* f.open()
        const error = yield* Effect.flip(store.loadOrCreate(new Uint8Array(limit + 1)))
        assert.deepStrictEqual([error.code, error.operation, error.field], [
          "InvalidArgument",
          f.operation,
          "maxImageBytes"
        ])
        assert.strictEqual(f.writeCount(), 0)
        assert.deepStrictEqual(yield* store.loadOrCreate(initial), initial)
      }))
    it.effect("rejects unsafe configured image bounds", () =>
      Effect.gen(function*() {
        const f = yield* fixture(backend)
        const error = yield* Effect.flip(f.open(ByteSize.bytes(BigInt(Number.MAX_SAFE_INTEGER) + 1n)))
        assert.instanceOf(error, VfsError.VfsError)

        if (Schema.is(VfsError.VfsError)(error)) assert.strictEqual(error.code, "InvalidArgument")
      }))
    it.effect("rejects oversized commits without freezing or changing storage", () =>
      Effect.gen(function*() {
        const f = yield* fixture(backend)
        const { store, close } = yield* f.open()
        yield* store.loadOrCreate(initial)
        const count = f.writeCount()
        assert.strictEqual(yield* store.commit(new Uint8Array(limit + 1)), "rejected")
        assert.strictEqual(f.writeCount(), count)
        assert.strictEqual(yield* store.commit(next), "committed")
        yield* close
        assert.deepStrictEqual(yield* (yield* f.open()).store.loadOrCreate(initial), next)
      }))

    if (backend === "SQLite") {
      it.effect("keeps a confirmed rollback retryable without changing persisted bytes or generation", () =>
        Effect.gen(function*() {
          const f = yield* fixture(backend)
          const { store, close } = yield* f.open()
          yield* store.loadOrCreate(initial)
          f.hooks.set("update", Effect.fail(failure()))
          assert.strictEqual(yield* store.commit(next), "rejected")
          assert.deepStrictEqual(yield* f.persisted, { generation: 0, image: initial })
          assert.strictEqual(yield* store.commit(next), "committed")
          assert.deepStrictEqual(yield* f.persisted, { generation: 1, image: next })
          yield* close
          assert.deepStrictEqual(yield* (yield* f.open()).store.loadOrCreate(initial), next)
        }))
    }

    for (
      const [field, value] of [
        ["generation", -1],
        ["generation", 1.5],
        ["generation", Number.MAX_SAFE_INTEGER + 1],
        ["digest", "invalid"],
        ["digest", "0".repeat(64)],
        ["image", new Uint8Array([9])],
        ["image", new Uint8Array(limit + 1)]
      ] as const
    ) {
      it.effect(`rejects corrupt ${field} ${String(value)}`, () =>
        Effect.gen(function*() {
          const f = yield* fixture(backend)
          const owner = yield* f.open()
          yield* owner.store.loadOrCreate(initial)
          yield* f.damage(field, value)
          yield* owner.close
          const error = yield* Effect.flip((yield* f.open()).store.loadOrCreate(initial))
          assert.deepStrictEqual([error.code, error.operation], ["CorruptStore", f.operation])
        }))
    }

    it.effect("loads the final safe generation but rejects advancement", () =>
      Effect.gen(function*() {
        const f = yield* fixture(backend)
        const owner = yield* f.open()
        yield* owner.store.loadOrCreate(initial)
        yield* f.damage("generation", Number.MAX_SAFE_INTEGER)
        yield* owner.close
        const { store } = yield* f.open()
        yield* store.loadOrCreate(initial)
        const count = f.writeCount()
        assert.strictEqual(yield* store.commit(next), "rejected")
        assert.strictEqual(f.writeCount(), count)
      }))
    it.effect("rejects competing initialization immediately without reading storage", () =>
      Effect.gen(function*() {
        const f = yield* fixture(backend)
        const { store } = yield* f.open()
        const held = yield* gate
        f.hooks.set("read", held.hold)
        const first = yield* Effect.forkChild(store.loadOrCreate(initial))
        yield* held.entered
        const reads = f.readCount()
        yield* Effect.gen(function*() {
          const result = yield* Effect.exit(store.loadOrCreate(next))
          assert.isTrue(Exit.isFailure(result))

          if (Exit.isFailure(result)) {
            const error = Cause.squash(result.cause)
            assert.instanceOf(error, VfsError.VfsError)

            if (Schema.is(VfsError.VfsError)(error)) assert.strictEqual(error.code, "Ownership")
          }

          assert.strictEqual(f.writeCount(), 0)
          assert.strictEqual(f.readCount(), reads)
        }).pipe(Effect.ensuring(held.release))
        assert.deepStrictEqual(yield* Fiber.join(first), initial)
      }))
    it.effect("releases initialization after a failed read", () =>
      Effect.gen(function*() {
        const f = yield* fixture(backend)
        const { store } = yield* f.open()
        f.hooks.set("read", Effect.fail(failure()))
        assert.strictEqual((yield* Effect.flip(store.loadOrCreate(initial))).code, "Storage")
        assert.deepStrictEqual(yield* store.loadOrCreate(initial), initial)
      }))
    it.effect("freezes after a write-start failure, including failed SQLite BEGIN", () =>
      Effect.gen(function*() {
        const f = yield* fixture(backend)
        const owner = yield* f.open()
        yield* owner.store.loadOrCreate(initial)
        f.hooks.set("write", Effect.fail(failure()))
        assert.strictEqual(yield* owner.store.commit(next), "unknown")
        const count = f.writeCount()
        assert.strictEqual(yield* owner.store.commit(next), "unknown")
        assert.strictEqual(f.writeCount(), count)
        assert.strictEqual((yield* Effect.flip(owner.store.loadOrCreate(initial))).code, "Storage")
        yield* owner.close
        assert.deepStrictEqual(yield* (yield* f.open()).store.loadOrCreate(next), initial)
      }))
    it.effect("freezes a stale owner", () =>
      Effect.gen(function*() {
        const f = yield* fixture(backend)
        const { store } = yield* f.open()
        yield* store.loadOrCreate(initial)
        yield* f.damage("generation", 1)
        assert.strictEqual(yield* store.commit(next), "unknown")
        const count = f.writeCount()
        assert.strictEqual(yield* store.commit(next), "unknown")
        assert.strictEqual(f.writeCount(), count)
      }))
    it.effect("recovers a complete image after losing a write acknowledgement", () =>
      Effect.gen(function*() {
        const f = yield* fixture(backend)
        const owner = yield* f.open()
        yield* owner.store.loadOrCreate(initial)
        f.hooks.set("ack", Effect.fail(failure()))
        assert.strictEqual(yield* owner.store.commit(next), "unknown")
        const count = f.writeCount()
        assert.strictEqual(yield* owner.store.commit(initial), "unknown")
        assert.strictEqual(f.writeCount(), count)
        yield* owner.close
        assert.deepStrictEqual(yield* (yield* f.open()).store.loadOrCreate(initial), next)
      }))
    it.effect("retains a freeze when an earlier successful write replies later", () =>
      Effect.gen(function*() {
        const f = yield* fixture(backend)
        const { store } = yield* f.open()
        yield* store.loadOrCreate(initial)
        const held = yield* gate
        f.hooks.set("ack", held.hold)
        const early = yield* Effect.forkChild(store.commit(next))
        yield* held.entered
        yield* Effect.gen(function*() {
          assert.strictEqual(yield* store.commit(initial), "unknown")
        }).pipe(Effect.ensuring(held.release))
        assert.strictEqual(yield* Fiber.join(early), "committed")
        const count = f.writeCount()
        assert.strictEqual(yield* store.commit(initial), "unknown")
        assert.strictEqual(f.writeCount(), count)
      }))
    it.effect("releases initialization when cancelled before writing", () =>
      Effect.gen(function*() {
        const f = yield* fixture(backend)
        const { store } = yield* f.open()
        const held = yield* gate
        f.hooks.set("read", held.hold)
        const loading = yield* Effect.forkChild(store.loadOrCreate(initial))
        yield* held.entered
        yield* Fiber.interrupt(loading)
        assertInterrupted(yield* Fiber.await(loading))
        assert.strictEqual(f.writeCount(), 0)
        assert.deepStrictEqual(yield* store.loadOrCreate(initial), initial)
      }))

    const phases: ReadonlyArray<Phase> = backend === "SQLite" ? ["write", "update", "ack"] : ["write", "ack"]

    for (const creating of [true, false]) {
      for (const phase of phases) {
        it.effect(`freezes when ${creating ? "creation" : "commit"} is cancelled at ${phase}`, () =>
          Effect.gen(function*() {
            const f = yield* fixture(backend)
            const owner = yield* f.open()

            if (!creating) yield* owner.store.loadOrCreate(initial)
            const held = yield* gate
            f.hooks.set(phase, held.hold)

            const writing = yield* Effect.forkChild(
              creating ? owner.store.loadOrCreate(next) : owner.store.commit(next)
            )

            yield* held.entered
            yield* Fiber.interrupt(writing)
            assertInterrupted(yield* Fiber.await(writing))
            const count = f.writeCount()
            assert.strictEqual(yield* owner.store.commit(initial), "unknown")
            assert.strictEqual((yield* Effect.flip(owner.store.loadOrCreate(initial))).code, "Storage")
            assert.strictEqual(f.writeCount(), count)
            yield* owner.close
            assert.deepStrictEqual(
              yield* (yield* f.open()).store.loadOrCreate(initial),
              phase === "ack" ? next : initial
            )
          }))
      }
    }

    for (const creating of [true, false]) {
      it.effect(`cancels ${creating ? "initialization" : "commit"} hashing without writing or freezing`, () =>
        Effect.gen(function*() {
          const original = yield* Digest.Digest
          const held = yield* gate
          let block = false
          const f = yield* fixture(backend)

          const { store } = yield* f.open().pipe(Effect.provideService(Digest.Digest, {
            ...original,
            digest: (algorithm, bytes) =>
              block
                ? held.hold.pipe(Effect.andThen(original.digest(algorithm, bytes)))
                : original.digest(algorithm, bytes)
          }))

          if (!creating) yield* store.loadOrCreate(initial)
          block = true
          const count = f.writeCount()
          const hashing = yield* Effect.forkChild(creating ? store.loadOrCreate(next) : store.commit(next))
          yield* held.entered
          yield* Fiber.interrupt(hashing)
          assertInterrupted(yield* Fiber.await(hashing))
          assert.strictEqual(f.writeCount(), count)
          block = false

          if (creating) assert.deepStrictEqual(yield* store.loadOrCreate(initial), initial)
          else assert.strictEqual(yield* store.commit(next), "committed")
        }))
    }

    it.effect("keeps an acknowledged generation when the caller then cancels", () =>
      Effect.gen(function*() {
        const f = yield* fixture(backend)
        const owner = yield* f.open()
        yield* owner.store.loadOrCreate(initial)
        const cancelled = yield* Effect.forkChild(owner.store.commit(next).pipe(Effect.andThen(Effect.interrupt)))
        assertInterrupted(yield* Fiber.await(cancelled))
        assert.strictEqual(yield* owner.store.commit(initial), "committed")
        yield* owner.close
        assert.deepStrictEqual(yield* (yield* f.open()).store.loadOrCreate(next), initial)
      }))
    it.effect("does not start a write after another commit freezes during hashing", () =>
      Effect.gen(function*() {
        const original = yield* Digest.Digest
        const held = yield* gate
        let blockNext = false
        const f = yield* fixture(backend)

        const { store } = yield* f.open().pipe(Effect.provideService(Digest.Digest, {
          ...original,
          digest: (algorithm, image) => {
            if (!blockNext) return original.digest(algorithm, image)
            blockNext = false

            return held.hold.pipe(Effect.andThen(original.digest(algorithm, image)))
          }
        }))

        yield* store.loadOrCreate(initial)
        blockNext = true
        const hashing = yield* Effect.forkChild(store.commit(next))
        yield* held.entered
        f.hooks.set("write", Effect.fail(failure()))
        yield* Effect.gen(function*() {
          assert.strictEqual(yield* store.commit(initial), "unknown")
        }).pipe(Effect.ensuring(held.release))
        const count = f.writeCount()
        assert.strictEqual(yield* Fiber.join(hashing), "unknown")
        assert.strictEqual(f.writeCount(), count)
      }))

    for (const synchronous of [false, true]) {
      it.effect(`preserves pre-write digest ${synchronous ? "throws" : "defects"} and allows retry`, () =>
        Effect.gen(function*() {
          const digest = yield* Digest.Digest
          let broken = false
          const defect = new Error("digest failed")
          const f = yield* fixture(backend)

          const owner = yield* f.open().pipe(Effect.provideService(Digest.Digest, {
            ...digest,
            digest: (algorithm, image) => {
              if (broken && synchronous) throw defect

              return broken ? Effect.die(defect) : digest.digest(algorithm, image)
            }
          }))

          yield* owner.store.loadOrCreate(initial)
          broken = true
          const count = f.writeCount()
          const result = yield* owner.store.commit(next)
          assert.isObject(result)

          if (Predicate.isTagged(result, "Rejected")) assert.strictEqual(Cause.squash(result.cause), defect)
          assert.strictEqual(f.writeCount(), count)
          broken = false
          assert.strictEqual(yield* owner.store.commit(next), "committed")
        }))
    }
  })
}
