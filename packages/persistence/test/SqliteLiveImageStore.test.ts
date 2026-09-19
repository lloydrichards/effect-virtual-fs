import { LiveVolume } from "@effect-vfs/core"
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, FileSystem, Layer, Option, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { ConnectionError, SqlError } from "effect/unstable/sql/SqlError"
import * as SqliteLiveImageStore from "../src/SqliteLiveImageStore.js"

const volume = {
  maxEntries: 100,
  maxBytes: ByteSize.kilobytes(32),
  maxFileBytes: ByteSize.kilobytes(16),
  maxPathBytes: ByteSize.bytes(1024)
}

const options = { maxImageBytes: ByteSize.kilobytes(64), volume }

const files = Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer)

const platform = Layer.mergeAll(files, NodeChildProcessSpawner.layer.pipe(Layer.provide(files)))

const store = (filename: string, maxDatabaseBytes = ByteSize.megabytes(2)) =>
  SqliteLiveImageStore.layer({ filename, maxImageBytes: options.maxImageBytes, maxDatabaseBytes }).pipe(
    Layer.provide(SqliteClient.layer({ filename, disableWAL: true, busyTimeout: 0 }))
  )

describe("SQLite live image store", () => {
  it.effect("preserves an acknowledged write across process exit", () =>
    Effect.scoped(Effect.gen(function*() {
      const filesystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const directory = yield* filesystem.makeTempDirectoryScoped({ prefix: "effect-vfs-live-" })
      const filename = path.join(directory, "live.sqlite")
      const worker = yield* path.fromFileUrl(new URL("./fixtures/live-restart.ts", import.meta.url))

      const run = (mode: string) =>
        spawner.string(ChildProcess.make("bun", [worker], {
          env: { LIVE_STORE_MODE: mode, LIVE_STORE_FILE: filename },
          extendEnv: true
        }))

      const written = yield* run("write")
      const reopened = yield* run("verify")
      assert.strictEqual(reopened.trim(), written.trim())
    })).pipe(Effect.provide(platform)), 15_000)

  it.live("recovers an acknowledged write after the writer is killed", () =>
    Effect.scoped(Effect.gen(function*() {
      const filesystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const directory = yield* filesystem.makeTempDirectoryScoped({ prefix: "effect-vfs-live-" })
      const filename = path.join(directory, "live.sqlite")
      const worker = yield* path.fromFileUrl(new URL("./fixtures/live-restart.ts", import.meta.url))

      const command = (mode: string) =>
        ChildProcess.make("bun", [worker], {
          env: { LIVE_STORE_MODE: mode, LIVE_STORE_FILE: filename },
          extendEnv: true
        })

      const writer = yield* spawner.spawn(command("write-hold"))
      const acknowledged = yield* Stream.runHead(writer.stdout)

      if (Option.isNone(acknowledged)) return yield* Effect.die("writer did not acknowledge the commit")

      yield* writer.kill({ killSignal: "SIGKILL" })

      const reopened = yield* spawner.string(command("verify"))
      assert.strictEqual(reopened.trim(), new TextDecoder().decode(acknowledged.value).trim())
    })).pipe(Effect.provide(platform)), 15_000)

  it.live(
    "rolls back an unacknowledged transaction when the writer is killed before COMMIT",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const filesystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const directory = yield* filesystem.makeTempDirectoryScoped({ prefix: "effect-vfs-live-" })
        const filename = path.join(directory, "live.sqlite")
        const worker = yield* path.fromFileUrl(new URL("./fixtures/live-restart.ts", import.meta.url))

        const command = (mode: string) =>
          ChildProcess.make("bun", [worker], {
            env: { LIVE_STORE_MODE: mode, LIVE_STORE_FILE: filename },
            extendEnv: true
          })

        const identity = yield* spawner.string(command("write"))
        const writer = yield* spawner.spawn(command("pause-before-commit"))
        const marker = `${filename}.before-commit`

        for (let attempt = 0; attempt < 100 && !(yield* filesystem.exists(marker)); attempt++) {
          yield* Effect.sleep("20 millis")
        }

        if (!(yield* filesystem.exists(marker))) return yield* Effect.die("writer did not reach COMMIT")

        yield* writer.kill({ killSignal: "SIGKILL" })

        const reopened = yield* spawner.string(command("verify"))
        assert.strictEqual(reopened.trim(), identity.trim())
      })).pipe(Effect.provide(platform)),
    15_000
  )

  it.effect("reopens names, bytes, hard links and identity", () =>
    Effect.scoped(Effect.gen(function*() {
      const filesystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* filesystem.makeTempDirectoryScoped({ prefix: "effect-vfs-live-" })
      const filename = path.join(directory, "live.sqlite")

      const before = yield* Effect.scoped(Effect.gen(function*() {
        const live = yield* LiveVolume.open(options)
        const caller = yield* live.caller()
        yield* caller.writeFile("/first", new Uint8Array([1, 2, 3]), { access: "write", create: "exclusive" })
        yield* caller.link("/first", "/alias")
        yield* caller.rename("/first", "/renamed")
        yield* caller.chmod("/renamed", 0o640)

        return { identity: live.identity, incarnation: live.incarnation }
      })).pipe(Effect.provide(store(filename)))

      yield* Effect.scoped(Effect.gen(function*() {
        const live = yield* LiveVolume.open(options)
        const caller = yield* live.caller()
        assert.strictEqual(live.identity, before.identity)
        assert.notStrictEqual(live.incarnation, before.incarnation)
        assert.deepEqual(yield* caller.readFile("/renamed"), new Uint8Array([1, 2, 3]))
        assert.deepEqual(yield* caller.readFile("/alias"), new Uint8Array([1, 2, 3]))
        assert.strictEqual((yield* caller.stat("/alias")).ino, (yield* caller.stat("/renamed")).ino)
        assert.strictEqual((yield* caller.stat("/renamed")).mode, 0o640)
      })).pipe(Effect.provide(store(filename)))
    })).pipe(Effect.provide(files)))

  it.effect("rejects a competing owner and a damaged image", () =>
    Effect.scoped(Effect.gen(function*() {
      const filesystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* filesystem.makeTempDirectoryScoped({ prefix: "effect-vfs-live-" })
      const filename = path.join(directory, "live.sqlite")

      yield* Effect.scoped(Effect.gen(function*() {
        yield* LiveVolume.open(options)
        const competing = yield* Effect.flip(LiveVolume.open(options).pipe(Effect.provide(store(filename))))
        assert.strictEqual(competing.code, "Ownership")
      })).pipe(Effect.provide(store(filename)))

      yield* Effect.gen(function*() {
        const sql = yield* SqlClient
        yield* sql.unsafe("UPDATE effect_vfs_live_image SET image = x'00' WHERE id = 1")
      }).pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })))

      const damaged = yield* Effect.flip(Effect.scoped(LiveVolume.open(options)).pipe(Effect.provide(store(filename))))
      assert.strictEqual(damaged.code, "CorruptStore")
    })).pipe(Effect.provide(files)))

  it.effect("rejects a SQLite client bound to another database", () =>
    Effect.scoped(Effect.gen(function*() {
      const filesystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* filesystem.makeTempDirectoryScoped({ prefix: "effect-vfs-live-" })
      const declared = path.join(directory, "declared.sqlite")
      const actual = path.join(directory, "actual.sqlite")

      const mismatched = SqliteLiveImageStore.layer({
        filename: declared,
        maxImageBytes: options.maxImageBytes,
        maxDatabaseBytes: ByteSize.megabytes(2)
      }).pipe(Layer.provide(SqliteClient.layer({ filename: actual, disableWAL: true })))

      const error = yield* Effect.flip(Effect.scoped(LiveVolume.open(options)).pipe(Effect.provide(mismatched)))
      assert.strictEqual(error.code, "InvalidConfiguration")
    })).pipe(Effect.provide(files)))

  it.effect("rejects a full-database write without publishing it", () =>
    Effect.scoped(Effect.gen(function*() {
      const filesystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* filesystem.makeTempDirectoryScoped({ prefix: "effect-vfs-live-" })
      const filename = path.join(directory, "live.sqlite")

      yield* Effect.scoped(Effect.gen(function*() {
        const live = yield* LiveVolume.open(options)
        const caller = yield* live.caller()

        const error = yield* Effect.flip(caller.writeFile("/too-large", new Uint8Array(15_000), {
          access: "write",
          create: "exclusive"
        }))

        assert.strictEqual(error.code, "StorageRejected")
        assert.strictEqual((yield* Effect.flip(caller.stat("/too-large"))).code, "NotFound")
      })).pipe(Effect.provide(store(filename, ByteSize.bytes(12_288))))
    })).pipe(Effect.provide(files)))

  it.effect("freezes the volume when a SQLite commit succeeds but its acknowledgement is lost", () =>
    Effect.scoped(Effect.gen(function*() {
      const filesystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* filesystem.makeTempDirectoryScoped({ prefix: "effect-vfs-live-" })
      const filename = path.join(directory, "live.sqlite")
      let loseAcknowledgement = false

      const sql = Layer.effect(
        SqlClient,
        Effect.map(SqlClient, (client) =>
          Object.assign(client, {
            reserve: Effect.map(client.reserve, (connection) => ({
              ...connection,
              executeRaw: (statement: string, params: ReadonlyArray<unknown>) =>
                loseAcknowledgement && statement === "COMMIT"
                  ? connection.executeRaw(statement, params).pipe(
                    Effect.andThen(Effect.fail(
                      new SqlError({
                        reason: new ConnectionError({ cause: "commit acknowledgement lost" })
                      })
                    ))
                  )
                  : connection.executeRaw(statement, params)
            }))
          }))
      ).pipe(Layer.provide(SqliteClient.layer({ filename, disableWAL: true, busyTimeout: 0 })))

      const injected = SqliteLiveImageStore.layer({
        filename,
        maxImageBytes: options.maxImageBytes,
        maxDatabaseBytes: ByteSize.megabytes(2)
      }).pipe(Layer.provide(sql))

      const identity = yield* Effect.scoped(Effect.gen(function*() {
        const live = yield* LiveVolume.open(options)
        const caller = yield* live.caller()
        loseAcknowledgement = true

        const failure = yield* Effect.flip(caller.writeFile("/durable", new Uint8Array([4, 5, 6]), {
          access: "write",
          create: "exclusive"
        }))

        assert.strictEqual(failure.code, "OutcomeUnknown")
        assert.strictEqual((yield* Effect.flip(caller.stat("/durable"))).code, "VolumeUnavailable")
        assert.strictEqual((yield* Effect.flip(live.usage)).code, "VolumeUnavailable")

        return live.identity
      })).pipe(Effect.provide(injected))

      yield* Effect.scoped(Effect.gen(function*() {
        const live = yield* LiveVolume.open(options)
        const caller = yield* live.caller()
        assert.strictEqual(live.identity, identity)
        assert.deepEqual(yield* caller.readFile("/durable"), new Uint8Array([4, 5, 6]))
      })).pipe(Effect.provide(store(filename)))
    })).pipe(Effect.provide(files)))

  it.effect("freezes the volume when an update fails and rollback cannot be confirmed", () =>
    Effect.scoped(Effect.gen(function*() {
      const filesystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* filesystem.makeTempDirectoryScoped({ prefix: "effect-vfs-live-" })
      const filename = path.join(directory, "live.sqlite")
      let failTransaction = false

      const sql = Layer.effect(
        SqlClient,
        Effect.map(SqlClient, (client) =>
          Object.assign(client, {
            reserve: Effect.map(client.reserve, (connection) => ({
              ...connection,
              executeRaw: (statement: string, params: ReadonlyArray<unknown>) =>
                failTransaction &&
                  (statement.startsWith("UPDATE effect_vfs_live_image") || statement === "ROLLBACK")
                  ? Effect.fail(new SqlError({ reason: new ConnectionError({ cause: "injected storage failure" }) }))
                  : connection.executeRaw(statement, params)
            }))
          }))
      ).pipe(Layer.provide(SqliteClient.layer({ filename, disableWAL: true, busyTimeout: 0 })))

      const injected = SqliteLiveImageStore.layer({
        filename,
        maxImageBytes: options.maxImageBytes,
        maxDatabaseBytes: ByteSize.megabytes(2)
      }).pipe(Layer.provide(sql))

      const identity = yield* Effect.scoped(Effect.gen(function*() {
        const live = yield* LiveVolume.open(options)
        const caller = yield* live.caller()
        failTransaction = true

        const failure = yield* Effect.flip(caller.writeFile("/unconfirmed", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        }))

        assert.strictEqual(failure.code, "OutcomeUnknown")
        assert.strictEqual((yield* Effect.flip(caller.stat("/"))).code, "VolumeUnavailable")

        return live.identity
      })).pipe(Effect.provide(injected))

      yield* Effect.scoped(Effect.gen(function*() {
        const live = yield* LiveVolume.open(options)
        const caller = yield* live.caller()
        assert.strictEqual(live.identity, identity)
        assert.strictEqual((yield* Effect.flip(caller.stat("/unconfirmed"))).code, "NotFound")
      })).pipe(Effect.provide(store(filename)))
    })).pipe(Effect.provide(files)))
})
