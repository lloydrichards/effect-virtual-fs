/**
 * A bounded live-image store using Effect's SQL and platform services.
 *
 * @since 0.4.0
 */
import { LiveVolume, type VfsError } from "@effect-vfs/core"
import { ByteSize, Cause, Effect, Exit, FileSystem, Layer, Path, Predicate, Schema } from "effect"
import type * as Digest from "effect/crypto/Digest"
import { SqlClient } from "effect/sql/SqlClient"
import * as Protocol from "./internal/liveImageProtocol.js"
import { type StoreFailures, storeFailures } from "./internal/storeSupport.js"

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
 * @category models
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

interface Revision {
  readonly generation: unknown
}

const StoreRow = Schema.Struct({
  generation: Schema.Unknown,
  kind: Schema.String,
  size: Schema.Finite,
  image: Schema.NullOr(Schema.Uint8Array),
  digest: Schema.Unknown
})

const opening = storeFailures("SqliteLiveImageStore.layer")

const loading = storeFailures("SqliteLiveImageStore.loadOrCreate")

/**
 * Reserve one SQLite connection and its exclusive lock for the Layer scope.
 * The application supplies a dedicated `SqlClient`, `FileSystem`, `Path`, and `Digest`.
 * Close the store before its client. The store releases its reservation and
 * exclusive lock without closing the borrowed client.
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
 * @category layers
 */
export const layer = (options: Options): Layer.Layer<
  LiveVolume.LiveImageStore,
  VfsError.ArgumentFailure | VfsError.StoreFailure,
  SqlClient | Digest.Digest | FileSystem.FileSystem | Path.Path
> =>
  Layer.effect(
    LiveVolume.LiveImageStore,
    Effect.gen(function*() {
      const filesystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const sql = yield* SqlClient
      const maxImage = yield* Protocol.imageLimit(options.maxImageBytes, opening)
      const maxDatabase = ByteSize.toBigInt(options.maxDatabaseBytes)
      const timeout = options.busyTimeoutMs ?? 0

      if (!path.isAbsolute(options.filename)) return yield* opening.invalid("filename")

      if (maxDatabase <= 0n) return yield* opening.invalid("maxDatabaseBytes")

      if (!Number.isSafeInteger(timeout) || timeout < 0) return yield* opening.invalid("busyTimeoutMs")

      const connection = yield* sql.reserve.pipe(Effect.mapError((cause) => opening.fail("Storage", cause)))
      const run = (statement: string, params: ReadonlyArray<unknown> = []) => connection.executeRaw(statement, params)

      // Queries while opening name the layer; the row reads after it name loadOrCreate, since commit reports
      // outcomes rather than failures.
      const queryAs = (failures: StoreFailures) =>
        Effect.fnUntraced(function*<A>(
          schema: Schema.ConstraintDecoder<A>,
          statement: string,
          params: ReadonlyArray<unknown> = []
        ) {
          const rows = yield* run(statement, params).pipe(Effect.mapError((cause) => failures.fail("Storage", cause)))

          return yield* Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(
            Effect.mapError((cause) => failures.fail("CorruptStore", cause))
          )
        })

      const query = queryAs(opening)
      const queryRow = queryAs(loading)

      yield* run(`PRAGMA busy_timeout=${timeout}`).pipe(Effect.mapError((cause) => opening.fail("Storage", cause)))
      yield* run("PRAGMA journal_mode=DELETE").pipe(Effect.mapError((cause) => opening.fail("Ownership", cause)))
      yield* run("PRAGMA synchronous=EXTRA").pipe(Effect.mapError((cause) => opening.fail("Storage", cause)))
      yield* run("PRAGMA fullfsync=ON").pipe(Effect.mapError((cause) => opening.fail("Storage", cause)))
      yield* run("PRAGMA locking_mode=EXCLUSIVE").pipe(Effect.mapError((cause) => opening.fail("Storage", cause)))
      // Keep statement journals in memory and prevent mid-transaction cache spills.
      // The rollback journal remains on disk beside the database.
      yield* run("PRAGMA temp_store=MEMORY").pipe(Effect.mapError((cause) => opening.fail("Storage", cause)))
      yield* run("PRAGMA cache_spill=OFF").pipe(Effect.mapError((cause) => opening.fail("Storage", cause)))
      yield* run("PRAGMA journal_size_limit=0").pipe(Effect.mapError((cause) => opening.fail("Storage", cause)))

      const lock = yield* Effect.exit(run("SELECT count(*) AS count FROM sqlite_schema"))

      if (Exit.isFailure(lock)) return yield* opening.fail("Ownership", lock.cause)

      const protocol = yield* Protocol.make<Revision>({
        maxImage,
        loading,
        storage: {
          read: Effect.suspend(() => read()),
          compareAndSwap: (expected, next) => compareAndSwap(expected, next)
        }
      })

      // Release exclusive ownership before closing the client. Older Bun clients
      // can retain prepared statements, delaying the physical close until GC.
      // SQLite requires a database read after switching back to NORMAL:
      // https://www.sqlite.org/pragma.html#pragma_locking_mode
      yield* Effect.addFinalizer(() =>
        run("PRAGMA locking_mode=NORMAL").pipe(
          Effect.andThen(run("SELECT count(*) AS count FROM sqlite_schema")),
          // A frozen connection can still fail I/O during the unlock read. Preserve its
          // unknown outcome and allow the reserved connection and client to finalize.
          Effect.catch((error) =>
            Effect.flatMap(protocol.isAvailable, (available) => available ? Effect.die(error) : Effect.void)
          )
        )
      )

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
        return yield* opening.invalid("filename")
      }

      const expectedParent = yield* filesystem.realPath(path.dirname(options.filename)).pipe(
        Effect.mapError((cause) => opening.fail("Storage", cause))
      )

      const expectedPath = path.join(expectedParent, path.basename(options.filename))

      const actualPath = yield* filesystem.realPath(main.file).pipe(
        Effect.mapError((cause) => opening.fail("Storage", cause))
      )

      // The client opened a different database file than the one named.
      if (expectedPath !== actualPath) return yield* opening.invalid("filename")

      // A schema version this store did not write belongs to something else, or to a newer release.
      if (version?.user_version !== 0 && version?.user_version !== 1) return yield* opening.fail("IncompatibleStore")

      // The SQLite build or connection refused a setting the durability guarantees depend on.
      if (
        journal?.journal_mode.toLowerCase() !== "delete" || synchronous?.synchronous !== 3 ||
        fullfsync?.fullfsync !== 1 ||
        locking?.locking_mode.toLowerCase() !== "exclusive" || page === undefined ||
        tempStore?.temp_store !== 2 || cacheSpill?.cache_spill !== 0 ||
        journalSizeLimit?.journal_size_limit !== 0 ||
        compileOptions.some((option) => option.compile_options === "TEMP_STORE=0") ||
        !Number.isSafeInteger(page.page_size) || page.page_size <= 0
      ) return yield* opening.fail("IncompatibleStore")

      // SqlClient may have created the file before this Layer starts. Sync the
      // verified parent before any schema write or store becomes available.
      if (options.syncDatabaseDirectory !== undefined) {
        yield* options.syncDatabaseDirectory(expectedParent).pipe(
          Effect.mapError((cause) => opening.fail("Storage", cause))
        )
      }

      const maxPages = maxDatabase / BigInt(page.page_size)

      if (maxPages < 1n || maxPages > BigInt(2_147_483_647)) return yield* opening.invalid("maxDatabaseBytes")
      yield* run(`PRAGMA max_page_count=${maxPages}`).pipe(Effect.mapError((cause) => opening.fail("Storage", cause)))

      const pageLimit = (yield* query(Schema.Struct({ max_page_count: Schema.Finite }), "PRAGMA max_page_count"))[0]

      if (pageLimit?.max_page_count !== Number(maxPages)) return yield* opening.fail("IncompatibleStore")

      const pageCount = (yield* query(Schema.Struct({ page_count: Schema.Finite }), "PRAGMA page_count"))[0]

      if (pageCount === undefined || pageCount.page_count > Number(maxPages)) {
        return yield* opening.fail("IncompatibleStore")
      }

      const integrity = (yield* query(Schema.Struct({ quick_check: Schema.String }), "PRAGMA quick_check"))[0]

      if (integrity?.quick_check !== "ok") return yield* opening.fail("CorruptStore")

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
        return yield* opening.fail("CorruptStore")
      }

      yield* run(
        "CREATE TABLE IF NOT EXISTS effect_vfs_live_image (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL, image BLOB NOT NULL, digest TEXT NOT NULL)"
      ).pipe(
        Effect.mapError((cause) => opening.fail("Storage", cause))
      )

      const select =
        "SELECT generation, typeof(image) AS kind, length(image) AS size, CASE WHEN typeof(image) = 'blob' AND length(image) <= ? THEN image ELSE NULL END AS image, digest FROM effect_vfs_live_image WHERE id = 1"

      const read = Effect.fnUntraced(function*() {
        const rows = yield* queryRow(StoreRow, select, [Number(maxImage)])
        const row = rows[0]

        if (row === undefined) {
          const current = (yield* queryRow(Schema.Struct({ user_version: Schema.Finite }), "PRAGMA user_version"))[0]

          if (current?.user_version !== 0) return yield* loading.fail("CorruptStore")

          return null
        }

        // The bounded projection withholds non-BLOB and oversized values.
        if (row.kind !== "blob" || row.image === null) return yield* loading.fail("CorruptStore")

        return {
          image: row.image,
          generation: row.generation,
          digest: row.digest,
          token: { generation: row.generation }
        }
      })

      const compareAndSwap = Effect.fnUntraced(function*(expected: Revision | undefined, next: Protocol.Image) {
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function*() {
            const began = yield* Effect.exit(restore(run("BEGIN IMMEDIATE")))

            if (Exit.isFailure(began)) {
              yield* Effect.exit(run("ROLLBACK"))

              if (Cause.hasInterrupts(began.cause)) return yield* Effect.failCause(began.cause).pipe(Effect.orDie)

              return Protocol.WriteResult.Unknown({ cause: began.cause })
            }

            let attemptedCommit = false

            const written = yield* Effect.exit(restore(Effect.gen(function*() {
              if (expected === undefined) {
                yield* run("INSERT INTO effect_vfs_live_image (id, generation, image, digest) VALUES (1, ?, ?, ?)", [
                  next.generation,
                  next.image,
                  next.digest
                ])
                yield* run("PRAGMA user_version=1")
              } else {
                const updated = yield* queryRow(
                  Schema.Struct({ generation: Schema.Unknown }),
                  "UPDATE effect_vfs_live_image SET generation = ?, image = ?, digest = ? WHERE id = 1 AND generation = ? RETURNING generation",
                  [next.generation, next.image, next.digest, expected.generation]
                )

                if (updated.length !== 1) return Protocol.WriteResult.Conflict()
              }

              attemptedCommit = true
              yield* run("COMMIT")

              return Protocol.WriteResult.Written({ token: { generation: next.generation } })
            })))

            if (Exit.isSuccess(written) && Predicate.isTagged(written.value, "Written")) return written.value
            const rolledBack = yield* Effect.exit(run("ROLLBACK"))

            if (Exit.isFailure(written)) {
              if (Cause.hasInterrupts(written.cause)) return yield* Effect.failCause(written.cause).pipe(Effect.orDie)

              return !attemptedCommit && Exit.isSuccess(rolledBack)
                ? Protocol.WriteResult.Rejected({ cause: written.cause })
                : Protocol.WriteResult.Unknown({ cause: written.cause })
            }

            return Exit.isSuccess(rolledBack) ? written.value : Protocol.WriteResult.Unknown({})
          })
        )
      })

      return protocol.store
    })
  )
