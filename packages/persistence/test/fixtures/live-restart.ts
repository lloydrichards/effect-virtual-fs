import { LiveVolume } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import { ByteSize, Config, Console, Effect, FileSystem, Layer, Schema } from "effect"
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
  const evidence = yield* Config.String("LIVE_STORE_EVIDENCE_FILE").pipe(Config.withDefault(""))
  const pragmas: Array<string> = []

  const sqlite = SqliteClient.layer({ filename, disableWAL: true, busyTimeout: 0 })

  const database = mode.startsWith("pause-") || evidence !== ""
    ? Layer.effect(
      SqlClient,
      Effect.gen(function*() {
        const client = yield* SqlClient
        const filesystem = yield* FileSystem.FileSystem

        return Object.assign(client, {
          reserve: Effect.map(client.reserve, (connection) => ({
            ...connection,
            executeRaw: (statement: string, params: ReadonlyArray<unknown>) => {
              const execute = connection.executeRaw(statement, params).pipe(
                Effect.tap((rows) =>
                  Effect.gen(function*() {
                    if (
                      evidence === "" ||
                      !/^PRAGMA (journal_mode|synchronous|fullfsync|locking_mode|page_size)$/.test(statement)
                    ) {
                      return
                    }

                    const decoded = yield* Schema.decodeUnknownEffect(
                      Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
                    )(rows)

                    for (const row of decoded) {
                      for (const [key, value] of Object.entries(row)) {
                        pragmas.push(`${key}=${String(value)}`)
                      }
                    }

                    if (pragmas.length === 5) {
                      yield* filesystem.writeFileString(evidence, `${pragmas.join("\n")}\n`)
                    }
                  })
                )
              )

              return (mode === "pause-before-commit" && statement === "COMMIT") ||
                  (mode === "pause-after-update" && statement.startsWith("UPDATE effect_vfs_live_image")) ||
                  (mode === "pause-after-commit" && statement === "COMMIT")
                ? (mode === "pause-before-commit" ? Effect.void : execute).pipe(
                  Effect.andThen(filesystem.writeFileString(
                    `${filename}.${mode === "pause-before-commit" ? "before-commit" : mode}`,
                    "ready"
                  )),
                  Effect.orDie,
                  Effect.andThen(Effect.never)
                )
                : execute
            }
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
    } else if (mode === "write-linked") {
      yield* caller.writeFile("/first", new Uint8Array([1, 2, 3]), { access: "write", create: "exclusive" })
      yield* caller.link("/first", "/alias")
      yield* caller.rename("/first", "/renamed")
      yield* caller.chmod("/renamed", 0o640)
    } else if (mode.startsWith("pause-")) {
      yield* caller.writeFile("/durable", new Uint8Array([4, 5, 6]), { access: "write" })
    } else if (mode === "verify-pending") {
      const bytes = yield* caller.readFile("/durable")

      if (bytes.toString() !== "4,5,6") return yield* Effect.die("pending image did not commit")
    } else if (mode === "verify-linked") {
      const renamed = yield* caller.readFile("/renamed")
      const alias = yield* caller.readFile("/alias")
      const renamedStat = yield* caller.stat("/renamed")
      const aliasStat = yield* caller.stat("/alias")

      if (
        renamed.toString() !== "1,2,3" || alias.toString() !== "1,2,3" ||
        renamedStat.ino !== aliasStat.ino || renamedStat.mode !== 0o640
      ) return yield* Effect.die("linked files changed after restart")
    } else {
      const bytes = yield* caller.readFile("/durable")

      if (bytes.toString() !== "7,8,9") return yield* Effect.die("contents changed")
    }

    yield* Console.log(
      mode === "write-linked" || mode === "verify-linked"
        ? `${volume.identity}:${volume.incarnation}`
        : volume.identity
    )

    if (mode === "write-hold") return yield* Effect.never
  })).pipe(Effect.provide(Layer.mergeAll(storage, NodeCrypto.layer)))
})

await Effect.runPromise(program)
