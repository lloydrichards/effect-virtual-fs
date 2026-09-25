/**
 * A bounded live-image store using Effect's SQL and platform services.
 *
 * @since 0.4.0
 */
import { LiveVolume, type VfsError } from "@effect-vfs/core"
import { ByteSize, type Crypto, Effect, Exit, FileSystem, Layer, Path, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { makeDigest, storeFailures } from "./internal/storeSupport.js"

/**
 * Limits and the local database path used to verify the supplied SQL client.
 * Supply a dedicated SQLite `SqlClient` for this same path.
 *
 * @example
 * ```ts
 * import type { Options } from "@effect-vfs/persistence/SqliteLiveImageStore"
 * import { ByteSize } from "effect"
 *
 * const options: Options = {
 *   filename: "/var/lib/my-app/live.sqlite",
 *   maxImageBytes: ByteSize.megabytes(4),
 *   maxDatabaseBytes: ByteSize.megabytes(16)
 * }
 * ```
 *
 * @since 0.4.0
 */
export interface Options {
  readonly filename: string
  readonly maxImageBytes: ByteSize.ByteSize
  readonly maxDatabaseBytes: ByteSize.ByteSize
  readonly busyTimeoutMs?: number
  /**
   * Sync the containing directory after the supplied SQL client opens the
   * database. The implementation must report sync errors as failures.
   * Required before this store can be qualified for crash durability.
   */
  readonly syncDatabaseDirectory?: ((directory: string) => Effect.Effect<void, Error>) | undefined
}

const StoreRow = Schema.Struct({
  generation: Schema.Finite,
  kind: Schema.String,
  size: Schema.Finite,
  image: Schema.NullOr(Schema.Uint8Array),
  digest: Schema.String
})

const { fail, invalid } = storeFailures("SqliteLiveImageStore")

/**
 * Reserve one SQLite connection and its exclusive lock for the Layer scope.
 * The application supplies `SqlClient`, `FileSystem`, `Path`, and `Crypto`.
 *
 * @example
 * ```ts
 * import * as SqliteLiveImageStore from "@effect-vfs/persistence/SqliteLiveImageStore"
 * import { ByteSize } from "effect"
 *
 * const liveStore = SqliteLiveImageStore.layer({
 *   filename: "/var/lib/my-app/live.sqlite",
 *   maxImageBytes: ByteSize.megabytes(4),
 *   maxDatabaseBytes: ByteSize.megabytes(16)
 * })
 * ```
 *
 * @since 0.4.0
 */
export const layer = (options: Options): Layer.Layer<
  LiveVolume.LiveImageStore,
  VfsError.ArgumentFailure | VfsError.StoreFailure,
  SqlClient | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> =>
  Layer.effect(
    LiveVolume.LiveImageStore,
    Effect.gen(function*() {
      const filesystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const digest = yield* makeDigest
      const sql = yield* SqlClient
      const maxImage = ByteSize.toBigInt(options.maxImageBytes)
      const maxDatabase = ByteSize.toBigInt(options.maxDatabaseBytes)
      const timeout = options.busyTimeoutMs ?? 0

      if (!path.isAbsolute(options.filename)) return yield* invalid("filename")

      if (maxImage <= 0n || maxImage > BigInt(Number.MAX_SAFE_INTEGER)) return yield* invalid("maxImageBytes")

      if (maxDatabase <= 0n) return yield* invalid("maxDatabaseBytes")

      if (!Number.isSafeInteger(timeout) || timeout < 0) return yield* invalid("busyTimeoutMs")

      const connection = yield* sql.reserve.pipe(Effect.mapError((cause) => fail("Storage", cause)))
      const run = (statement: string, params: ReadonlyArray<unknown> = []) => connection.executeRaw(statement, params)

      const query = Effect.fnUntraced(function*<A>(
        schema: Schema.ConstraintDecoder<A>,
        statement: string,
        params: ReadonlyArray<unknown> = []
      ) {
        const rows = yield* run(statement, params).pipe(Effect.mapError((cause) => fail("Storage", cause)))

        return yield* Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(
          Effect.mapError((cause) => fail("CorruptStore", cause))
        )
      })

      yield* run(`PRAGMA busy_timeout=${timeout}`).pipe(Effect.mapError((cause) => fail("Storage", cause)))
      yield* run("PRAGMA journal_mode=DELETE").pipe(Effect.mapError((cause) => fail("Ownership", cause)))
      yield* run("PRAGMA synchronous=EXTRA").pipe(Effect.mapError((cause) => fail("Storage", cause)))
      yield* run("PRAGMA fullfsync=ON").pipe(Effect.mapError((cause) => fail("Storage", cause)))
      yield* run("PRAGMA locking_mode=EXCLUSIVE").pipe(Effect.mapError((cause) => fail("Storage", cause)))
      // Keep statement journals in memory and prevent mid-transaction cache spills.
      // The rollback journal remains on disk beside the database.
      yield* run("PRAGMA temp_store=MEMORY").pipe(Effect.mapError((cause) => fail("Storage", cause)))
      yield* run("PRAGMA cache_spill=OFF").pipe(Effect.mapError((cause) => fail("Storage", cause)))
      yield* run("PRAGMA journal_size_limit=0").pipe(Effect.mapError((cause) => fail("Storage", cause)))

      const lock = yield* Effect.exit(run("SELECT count(*) AS count FROM sqlite_schema"))

      if (Exit.isFailure(lock)) return yield* fail("Ownership", lock.cause)

      const journal = (yield* query(Schema.Struct({ journal_mode: Schema.String }), "PRAGMA journal_mode"))[0]
      const synchronous = (yield* query(Schema.Struct({ synchronous: Schema.Finite }), "PRAGMA synchronous"))[0]
      const fullfsync = (yield* query(Schema.Struct({ fullfsync: Schema.Finite }), "PRAGMA fullfsync"))[0]
      const locking = (yield* query(Schema.Struct({ locking_mode: Schema.String }), "PRAGMA locking_mode"))[0]
      const tempStore = (yield* query(Schema.Struct({ temp_store: Schema.Finite }), "PRAGMA temp_store"))[0]
      const cacheSpill = (yield* query(Schema.Struct({ cache_spill: Schema.Finite }), "PRAGMA cache_spill"))[0]

      const journalSizeLimit = (yield* query(
        Schema.Struct({ journal_size_limit: Schema.Finite }),
        "PRAGMA journal_size_limit"
      ))[0]

      const page = (yield* query(Schema.Struct({ page_size: Schema.Finite }), "PRAGMA page_size"))[0]
      const version = (yield* query(Schema.Struct({ user_version: Schema.Finite }), "PRAGMA user_version"))[0]

      const databases = yield* query(
        Schema.Struct({ seq: Schema.Finite, name: Schema.String, file: Schema.String }),
        "PRAGMA database_list"
      )

      const compileOptions = yield* query(
        Schema.Struct({ compile_options: Schema.String }),
        "PRAGMA compile_options"
      )

      const main = databases.find((database) => database.name === "main")

      // ATTACH could create a super-journal outside the single-database budget.
      if (databases.length !== 1 || main === undefined || main.file === "") {
        return yield* invalid("filename")
      }

      const expectedParent = yield* filesystem.realPath(path.dirname(options.filename)).pipe(
        Effect.mapError((cause) => fail("Storage", cause))
      )

      const expectedPath = path.join(expectedParent, path.basename(options.filename))
      const actualPath = yield* filesystem.realPath(main.file).pipe(Effect.mapError((cause) => fail("Storage", cause)))

      // The client opened a different database file than the one named.
      if (expectedPath !== actualPath) return yield* invalid("filename")

      // A schema version this store did not write belongs to something else, or to a newer release.
      if (version?.user_version !== 0 && version?.user_version !== 1) return yield* fail("IncompatibleStore")

      // The SQLite build or connection refused a setting the durability guarantees depend on.
      if (
        journal?.journal_mode.toLowerCase() !== "delete" || synchronous?.synchronous !== 3 ||
        fullfsync?.fullfsync !== 1 ||
        locking?.locking_mode.toLowerCase() !== "exclusive" || page === undefined ||
        tempStore?.temp_store !== 2 || cacheSpill?.cache_spill !== 0 ||
        journalSizeLimit?.journal_size_limit !== 0 ||
        compileOptions.some((option) => option.compile_options === "TEMP_STORE=0") ||
        !Number.isSafeInteger(page.page_size) || page.page_size <= 0
      ) return yield* fail("IncompatibleStore")

      // SqlClient may have created the file before this Layer starts. Sync the
      // verified parent before any schema write or store becomes available.
      if (options.syncDatabaseDirectory !== undefined) {
        yield* options.syncDatabaseDirectory(expectedParent).pipe(
          Effect.mapError((cause) => fail("Storage", cause))
        )
      }

      const maxPages = maxDatabase / BigInt(page.page_size)

      if (maxPages < 1n || maxPages > BigInt(2_147_483_647)) return yield* invalid("maxDatabaseBytes")
      yield* run(`PRAGMA max_page_count=${maxPages}`).pipe(Effect.mapError((cause) => fail("Storage", cause)))

      const pageLimit = (yield* query(Schema.Struct({ max_page_count: Schema.Finite }), "PRAGMA max_page_count"))[0]

      if (pageLimit?.max_page_count !== Number(maxPages)) return yield* fail("IncompatibleStore")

      const pageCount = (yield* query(Schema.Struct({ page_count: Schema.Finite }), "PRAGMA page_count"))[0]

      if (pageCount === undefined || pageCount.page_count > Number(maxPages)) return yield* fail("IncompatibleStore")

      const integrity = (yield* query(Schema.Struct({ quick_check: Schema.String }), "PRAGMA quick_check"))[0]

      if (integrity?.quick_check !== "ok") return yield* fail("CorruptStore")

      const count =
        (yield* query(Schema.Struct({ count: Schema.Finite }), "SELECT count(*) AS count FROM sqlite_schema"))[0]

      const table = (yield* query(
        Schema.Struct({ name: Schema.String }),
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'effect_vfs_live_image'"
      ))[0]

      if (
        (table === undefined && count?.count !== 0) ||
        (table !== undefined && count?.count !== 1) ||
        (version.user_version === 1 && table === undefined)
      ) {
        return yield* fail("CorruptStore")
      }

      yield* run(
        "CREATE TABLE IF NOT EXISTS effect_vfs_live_image (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL, image BLOB NOT NULL, digest TEXT NOT NULL)"
      ).pipe(
        Effect.mapError((cause) => fail("Storage", cause))
      )

      let generation: number | undefined
      let available = true

      const select =
        "SELECT generation, typeof(image) AS kind, length(image) AS size, CASE WHEN typeof(image) = 'blob' AND length(image) <= ? THEN image ELSE NULL END AS image, digest FROM effect_vfs_live_image WHERE id = 1"

      return LiveVolume.LiveImageStore.of({
        loadOrCreate: Effect.fnUntraced(function*(initial: Uint8Array) {
          if (!available) return yield* fail("Storage")

          if (generation !== undefined) return yield* fail("Ownership")

          let decoded = yield* query(StoreRow, select, [Number(maxImage)])

          if (decoded.length === 0) {
            if (version.user_version === 1 || BigInt(initial.length) > maxImage) return yield* fail("CorruptStore")
            const hash = yield* digest(initial).pipe(Effect.mapError((cause) => fail("Storage", cause)))
            yield* run("BEGIN IMMEDIATE").pipe(Effect.mapError((cause) => fail("Storage", cause)))

            const initialized = yield* Effect.exit(Effect.gen(function*() {
              yield* run("INSERT INTO effect_vfs_live_image (id, generation, image, digest) VALUES (1, 0, ?, ?)", [
                initial,
                hash
              ])
              yield* run("PRAGMA user_version=1")
              yield* run("COMMIT")
            }))

            if (Exit.isFailure(initialized)) {
              yield* Effect.exit(run("ROLLBACK"))

              return yield* fail("Storage", initialized.cause)
            }

            decoded = yield* query(StoreRow, select, [Number(maxImage)])
          }

          const row = decoded[0]

          if (
            row === undefined || !Number.isSafeInteger(row.generation) || row.generation < 0 ||
            row.kind !== "blob" || !Number.isSafeInteger(row.size) || BigInt(row.size) > maxImage ||
            row.image === null || !/^[0-9a-f]{64}$/.test(row.digest)
          ) return yield* fail("CorruptStore")

          const actual = yield* digest(row.image).pipe(Effect.mapError((cause) => fail("Storage", cause)))

          if (actual !== row.digest) return yield* fail("CorruptStore")

          generation = row.generation

          return new Uint8Array(row.image)
        }),
        commit: Effect.fnUntraced(function*(image: Uint8Array) {
          if (!available || generation === undefined) return "unknown" as const

          if (BigInt(image.length) > maxImage) return "rejected" as const

          if (generation === Number.MAX_SAFE_INTEGER) return "rejected" as const

          const hash = yield* digest(image).pipe(Effect.orElseSucceed(() => ""))

          if (hash === "") return "rejected" as const

          const began = yield* Effect.exit(run("BEGIN IMMEDIATE"))

          if (Exit.isFailure(began)) return "unknown" as const

          const updated = yield* Effect.exit(query(
            Schema.Struct({ generation: Schema.Finite }),
            "UPDATE effect_vfs_live_image SET generation = ?, image = ?, digest = ? WHERE id = 1 AND generation = ? RETURNING generation",
            [generation + 1, image, hash, generation]
          ))

          if (Exit.isFailure(updated)) {
            const rolledBack = yield* Effect.exit(run("ROLLBACK"))

            if (Exit.isSuccess(rolledBack)) return "rejected" as const
            available = false

            return "unknown" as const
          }

          if (updated.value.length !== 1) {
            available = false
            yield* Effect.exit(run("ROLLBACK"))

            return "unknown" as const
          }

          const committed = yield* Effect.exit(run("COMMIT"))

          if (Exit.isFailure(committed)) {
            available = false
            yield* Effect.exit(run("ROLLBACK"))

            return "unknown" as const
          }

          generation++

          return "committed" as const
        })
      })
    })
  )
