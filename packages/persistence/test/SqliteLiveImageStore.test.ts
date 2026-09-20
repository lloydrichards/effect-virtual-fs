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
  it.effect("uses bounded temporary-file settings on the commit connection", () =>
    Effect.scoped(Effect.gen(function*() {
      const filesystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const directory = yield* filesystem.makeTempDirectoryScoped({ prefix: "effect-vfs-live-" })
      const filename = path.join(directory, "live.sqlite")
      const evidence = path.join(directory, "pragmas.txt")
      const worker = yield* path.fromFileUrl(new URL("./fixtures/live-restart.ts", import.meta.url))

      yield* spawner.string(ChildProcess.make("bun", [worker], {
        env: { LIVE_STORE_MODE: "write", LIVE_STORE_FILE: filename, LIVE_STORE_EVIDENCE_FILE: evidence },
        extendEnv: true
      }))

      const settings = yield* filesystem.readFileString(evidence)
      assert.match(settings, /^journal_mode=delete$/m)
      assert.match(settings, /^temp_store=2$/m)
      assert.match(settings, /^cache_spill=0$/m)
      assert.match(settings, /^journal_size_limit=0$/m)
    })).pipe(Effect.provide(platform)))

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
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const directory = yield* filesystem.makeTempDirectoryScoped({ prefix: "effect-vfs-live-" })
      const filename = path.join(directory, "live.sqlite")
      const worker = yield* path.fromFileUrl(new URL("./fixtures/live-restart.ts", import.meta.url))

      const run = (mode: string) =>
        spawner.string(ChildProcess.make("bun", [worker], {
          env: { LIVE_STORE_MODE: mode, LIVE_STORE_FILE: filename },
          extendEnv: true
        }))

      const [beforeIdentity, beforeIncarnation] = (yield* run("write-linked")).trim().split(":")
      const [afterIdentity, afterIncarnation] = (yield* run("verify-linked")).trim().split(":")
      assert.ok(beforeIdentity)
      assert.ok(beforeIncarnation)
      assert.strictEqual(afterIdentity, beforeIdentity)
      assert.notStrictEqual(afterIncarnation, beforeIncarnation)
    })).pipe(Effect.provide(platform)))

  it.effect("rejects a competing owner", () =>
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
    })).pipe(Effect.provide(files)), 15_000)

  it.effect("rejects a damaged image", () =>
    Effect.scoped(Effect.gen(function*() {
      const filesystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const directory = yield* filesystem.makeTempDirectoryScoped({ prefix: "effect-vfs-live-" })
      const filename = path.join(directory, "live.sqlite")
      const worker = yield* path.fromFileUrl(new URL("./fixtures/live-restart.ts", import.meta.url))

      yield* spawner.string(ChildProcess.make("bun", [worker], {
        env: { LIVE_STORE_MODE: "write", LIVE_STORE_FILE: filename },
        extendEnv: true
      }))

      yield* Effect.gen(function*() {
        const sql = yield* SqlClient
        yield* sql.unsafe("UPDATE effect_vfs_live_image SET image = x'00' WHERE id = 1")
      }).pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })))

      const damaged = yield* Effect.flip(Effect.scoped(LiveVolume.open(options)).pipe(Effect.provide(store(filename))))
      assert.strictEqual(damaged.code, "CorruptStore")
    })).pipe(Effect.provide(platform)))

  it.effect("rejects extra schema objects that could create statement journals", () =>
    Effect.scoped(Effect.gen(function*() {
      const filesystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const directory = yield* filesystem.makeTempDirectoryScoped({ prefix: "effect-vfs-live-" })
      const filename = path.join(directory, "live.sqlite")
      const worker = yield* path.fromFileUrl(new URL("./fixtures/live-restart.ts", import.meta.url))

      yield* spawner.string(ChildProcess.make("bun", [worker], {
        env: { LIVE_STORE_MODE: "write", LIVE_STORE_FILE: filename },
        extendEnv: true
      }))

      yield* Effect.gen(function*() {
        const sql = yield* SqlClient
        yield* sql.unsafe(
          "CREATE TRIGGER extra_change AFTER UPDATE ON effect_vfs_live_image BEGIN SELECT 1; END"
        )
      }).pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })))

      const error = yield* Effect.flip(Effect.scoped(LiveVolume.open(options)).pipe(Effect.provide(store(filename))))
      assert.strictEqual(error.code, "CorruptStore")
    })).pipe(Effect.provide(platform)))

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

      yield* Effect.scoped(Effect.gen(function*() {
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
      })).pipe(Effect.provide(injected))
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

      yield* Effect.scoped(Effect.gen(function*() {
        const live = yield* LiveVolume.open(options)
        const caller = yield* live.caller()
        failTransaction = true

        const failure = yield* Effect.flip(caller.writeFile("/unconfirmed", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        }))

        assert.strictEqual(failure.code, "OutcomeUnknown")
        assert.strictEqual((yield* Effect.flip(caller.stat("/"))).code, "VolumeUnavailable")
      })).pipe(Effect.provide(injected))
    })).pipe(Effect.provide(files)))
})
