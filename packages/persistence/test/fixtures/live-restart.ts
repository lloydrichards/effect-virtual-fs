import { LiveVolume } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import { ByteSize, Config, Console, Effect, FileSystem, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as SqliteLiveImageStore from "../../src/SqliteLiveImageStore.js"

const options = {
  maxImageBytes: ByteSize.kilobytes(64),
  volume: {
    maxEntries: 100,
    maxBytes: ByteSize.kilobytes(32),
    maxFileBytes: ByteSize.kilobytes(16),
    maxPathBytes: ByteSize.bytes(1024)
  }
}

const program = Effect.gen(function*() {
  const mode = yield* Config.String("LIVE_STORE_MODE")
  const filename = yield* Config.String("LIVE_STORE_FILE")

  const sqlite = SqliteClient.layer({ filename, disableWAL: true, busyTimeout: 0 })

  const database = mode === "pause-before-commit"
    ? Layer.effect(
      SqlClient,
      Effect.gen(function*() {
        const client = yield* SqlClient
        const filesystem = yield* FileSystem.FileSystem

        return Object.assign(client, {
          reserve: Effect.map(client.reserve, (connection) => ({
            ...connection,
            executeRaw: (statement: string, params: ReadonlyArray<unknown>) =>
              statement === "COMMIT"
                ? filesystem.writeFileString(`${filename}.before-commit`, "ready").pipe(
                  Effect.orDie,
                  Effect.flatMap(() => Effect.never)
                )
                : connection.executeRaw(statement, params)
          }))
        })
      })
    ).pipe(Layer.provide(sqlite))
    : sqlite

  const storage = SqliteLiveImageStore.layer({
    filename,
    maxImageBytes: options.maxImageBytes,
    maxDatabaseBytes: ByteSize.megabytes(2)
  }).pipe(
    Layer.provide(database),
    Layer.provide(Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer))
  )

  yield* Effect.scoped(Effect.gen(function*() {
    const volume = yield* LiveVolume.open(options)
    const caller = yield* volume.caller()

    if (mode === "write" || mode === "write-hold") {
      yield* caller.writeFile("/durable", new Uint8Array([7, 8, 9]), { access: "write", create: "exclusive" })
    } else if (mode === "pause-before-commit") {
      yield* caller.writeFile("/durable", new Uint8Array([4, 5, 6]), { access: "write" })
    } else {
      const bytes = yield* caller.readFile("/durable")

      if (bytes.toString() !== "7,8,9") return yield* Effect.die("contents changed")
    }

    yield* Console.log(volume.identity)

    if (mode === "write-hold") return yield* Effect.never
  })).pipe(Effect.provide(Layer.mergeAll(storage, NodeCrypto.layer)))
})

await Effect.runPromise(program)
