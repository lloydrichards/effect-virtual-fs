import { LiveVolume, type VfsError } from "@effect-vfs/core"
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import { ByteSize, Context, Effect, Exit, FileSystem, Layer, Path, Schema, Scope } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { ConnectionError, SqlError } from "effect/sql/SqlError"
import * as R2 from "../src/R2LiveImageStore.js"
import * as Sqlite from "../src/SqliteLiveImageStore.js"
import { liveImageStoreContract, type Phase } from "./helpers/liveImageStoreContract.js"

const limit = 16

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

for (const backend of ["SQLite", "R2"] as const) {
  liveImageStoreContract({ name: backend, fixture: fixture(backend), rollback: backend === "SQLite" })
}
