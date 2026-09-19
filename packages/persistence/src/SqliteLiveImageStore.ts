/**
 * A bounded live-image store using Effect's SQL and platform services.
 *
 * @since 0.4.0
 */
import { LiveVolume } from "@effect-vfs/core"
import { ByteSize, Crypto, Effect, Exit, FileSystem, Layer, Path, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

/**
 * Limits and the local database path used for directory synchronization.
 * Supply a dedicated SQLite `SqlClient` for this same path.
 *
 * @since 0.4.0
 */
export interface Options {
  readonly filename: string
  readonly maxImageBytes: ByteSize.ByteSize
  readonly maxDatabaseBytes: ByteSize.ByteSize
  readonly busyTimeoutMs?: number
}

const StoreRow = Schema.Struct({
  generation: Schema.Finite,
  kind: Schema.String,
  size: Schema.Finite,
  image: Schema.NullOr(Schema.Uint8Array),
  digest: Schema.String
})

const fail = (code: LiveVolume.LiveVolumeError["code"], cause?: unknown) =>
  new LiveVolume.LiveVolumeError({ code, cause })

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

/**
 * Reserve one SQLite connection and its exclusive lock for the Layer scope.
 * The application supplies `SqlClient`, `FileSystem`, `Path`, and `Crypto`.
 *
 * @since 0.4.0
 */
export const layer = (options: Options) =>
  Layer.effect(
    LiveVolume.LiveImageStore,
    Effect.gen(function*() {
      const filesystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const crypto = yield* Crypto.Crypto
      const sql = yield* SqlClient
      const maxImage = ByteSize.toBigInt(options.maxImageBytes)
      const maxDatabase = ByteSize.toBigInt(options.maxDatabaseBytes)
      const timeout = options.busyTimeoutMs ?? 0

      if (
        !path.isAbsolute(options.filename) || maxImage <= 0n || maxImage > BigInt(Number.MAX_SAFE_INTEGER) ||
        maxDatabase <= 0n || !Number.isSafeInteger(timeout) || timeout < 0
      ) return yield* fail("InvalidConfiguration")

      const existed = yield* filesystem.exists(options.filename).pipe(
        Effect.mapError((cause) => fail("Storage", cause))
      )

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

      const digest = (image: Uint8Array) => Effect.map(crypto.digest("SHA-256", image), hex)

      yield* run(`PRAGMA busy_timeout=${timeout}`).pipe(Effect.mapError((cause) => fail("Storage", cause)))
      yield* run("PRAGMA journal_mode=DELETE").pipe(Effect.mapError((cause) => fail("Ownership", cause)))
      yield* run("PRAGMA synchronous=EXTRA").pipe(Effect.mapError((cause) => fail("Storage", cause)))
      yield* run("PRAGMA fullfsync=ON").pipe(Effect.mapError((cause) => fail("Storage", cause)))
      yield* run("PRAGMA locking_mode=EXCLUSIVE").pipe(Effect.mapError((cause) => fail("Storage", cause)))

      const lock = yield* Effect.exit(run("SELECT count(*) AS count FROM sqlite_schema"))

      if (Exit.isFailure(lock)) return yield* fail("Ownership", lock.cause)

      const journal = (yield* query(Schema.Struct({ journal_mode: Schema.String }), "PRAGMA journal_mode"))[0]
      const synchronous = (yield* query(Schema.Struct({ synchronous: Schema.Finite }), "PRAGMA synchronous"))[0]
      const fullfsync = (yield* query(Schema.Struct({ fullfsync: Schema.Finite }), "PRAGMA fullfsync"))[0]
      const locking = (yield* query(Schema.Struct({ locking_mode: Schema.String }), "PRAGMA locking_mode"))[0]
      const page = (yield* query(Schema.Struct({ page_size: Schema.Finite }), "PRAGMA page_size"))[0]
      const version = (yield* query(Schema.Struct({ user_version: Schema.Finite }), "PRAGMA user_version"))[0]

      const databases = yield* query(
        Schema.Struct({ seq: Schema.Finite, name: Schema.String, file: Schema.String }),
        "PRAGMA database_list"
      )

      const main = databases.find((database) => database.name === "main")

      if (main === undefined || main.file === "") return yield* fail("InvalidConfiguration")

      const expectedParent = yield* filesystem.realPath(path.dirname(options.filename)).pipe(
        Effect.mapError((cause) => fail("Storage", cause))
      )

      const expectedPath = path.join(expectedParent, path.basename(options.filename))
      const actualPath = yield* filesystem.realPath(main.file).pipe(Effect.mapError((cause) => fail("Storage", cause)))

      if (
        journal?.journal_mode.toLowerCase() !== "delete" || synchronous?.synchronous !== 3 ||
        fullfsync?.fullfsync !== 1 ||
        locking?.locking_mode.toLowerCase() !== "exclusive" || page === undefined ||
        !Number.isSafeInteger(page.page_size) || page.page_size <= 0 ||
        (version?.user_version !== 0 && version?.user_version !== 1) || expectedPath !== actualPath
      ) return yield* fail("InvalidConfiguration")

      const maxPages = maxDatabase / BigInt(page.page_size)

      if (maxPages < 1n || maxPages > BigInt(2_147_483_647)) return yield* fail("InvalidConfiguration")
      yield* run(`PRAGMA max_page_count=${maxPages}`).pipe(Effect.mapError((cause) => fail("Storage", cause)))

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

      if ((table === undefined && count?.count !== 0) || (version.user_version === 1 && table === undefined)) {
        return yield* fail("CorruptStore")
      }

      yield* run(
        "CREATE TABLE IF NOT EXISTS effect_vfs_live_image (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL, image BLOB NOT NULL, digest TEXT NOT NULL)"
      ).pipe(
        Effect.mapError((cause) => fail("Storage", cause))
      )

      if (!existed) {
        yield* Effect.scoped(Effect.gen(function*() {
          const directory = yield* filesystem.open(path.dirname(options.filename), { flag: "r" })
          yield* directory.sync
        })).pipe(Effect.mapError((cause) => fail("Storage", cause)))
      }

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
