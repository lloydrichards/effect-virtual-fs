/**
 * PostgreSQL whole-image persistence with application-controlled ownership.
 *
 * @since 0.12.0
 */
import { LiveVolume, type VfsError } from "@effect-vfs/core"
import * as PgClient from "@effect/sql-pg/PgClient"
import { type ByteSize, Cause, Effect, Exit, Layer, Schema } from "effect"
import type * as Digest from "effect/crypto/Digest"
import * as Protocol from "./internal/liveImageProtocol.js"
import { SqlLiveImageKey } from "./internal/sqlLiveImageKey.js"
import { storeFailures } from "./internal/storeSupport.js"

/**
 * Store identity and image budget. Supply a dedicated single-connection
 * PostgreSQL client and run the packaged migration before opening.
 *
 * @example
 * ```ts
 * import type { Options } from "@effect-vfs/persistence/PgLiveImageStore"
 * import { ByteSize } from "effect"
 *
 * const options: Options = {
 *   key: "workspace-123",
 *   maxImageBytes: ByteSize.mebibytes(4)
 * }
 * ```
 *
 * @since 0.12.0
 * @category models
 */
export interface Options {
  /** Well-formed Unicode identity, from 1 to 256 UTF-16 code units, without NUL. */
  readonly key: string
  /** Positive byte limit below PostgreSQL's 1 GiB value limit. */
  readonly maxImageBytes: ByteSize.ByteSize
}

const opening = storeFailures("PgLiveImageStore.layer")

const loading = storeFailures("PgLiveImageStore.loadOrCreate")

const Receipt = Schema.Array(Schema.Struct({ generation: Schema.BigInt }))

const Row = Schema.Array(Schema.Struct({
  generation: Schema.BigInt,
  image: Schema.NullOr(Schema.Uint8Array),
  digest: Schema.Unknown
}))

const Columns = Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String, required: Schema.Boolean }))

const Table = Schema.Array(Schema.Struct({ compatible: Schema.Boolean }))

/**
 * Reserves the supplied client's connection for this store's scope. Supply one
 * fresh single-connection client per owner; do not share it with another store,
 * application queries, transactions, streams or listeners. Closing the store
 * releases its reservation but does not close the client. After uncertainty,
 * close the complete store/client scope and reopen with a fresh client.
 *
 * Use default PostgreSQL type decoding, no acquisition hooks, and a receive
 * limit of at least max(16 MiB, maxImageBytes + 90). Do not mutate the client's
 * configuration after construction. The guarantee remains memory-only.
 *
 * @example
 * ```ts
 * import * as PgLiveImageStore from "@effect-vfs/persistence/PgLiveImageStore"
 * import * as PgClient from "@effect/sql-pg/PgClient"
 * import { ByteSize, Layer, Redacted } from "effect"
 *
 * const Client = PgClient.layerFrom(PgClient.makeClient({
 *   url: Redacted.make("postgresql://user:password@localhost/app"),
 *   multiplex: false
 * }))
 * const store = PgLiveImageStore.layer({
 *   key: "workspace-123",
 *   maxImageBytes: ByteSize.mebibytes(4)
 * }).pipe(Layer.provide(Client))
 * ```
 *
 * @since 0.12.0
 * @category layers
 */
export const layer = (options: Options): Layer.Layer<
  LiveVolume.LiveImageStore,
  VfsError.ArgumentFailure | VfsError.StoreFailure,
  PgClient.PgClient | Digest.Digest
> =>
  Layer.effect(
    LiveVolume.LiveImageStore,
    Effect.gen(function*() {
      const maxImage = yield* Protocol.imageLimit(options.maxImageBytes, opening)

      if (maxImage >= 1_073_741_824n) return yield* opening.invalid("maxImageBytes")
      yield* Schema.decodeEffect(SqlLiveImageKey)(options.key).pipe(Effect.mapError(() => opening.invalid("key")))

      const client = yield* PgClient.PgClient

      // Direct reserved execution bypasses ambient application transactions.
      // Acquisition hooks could still open a transaction before reservation.
      if (client.config.onAcquire !== undefined) return yield* opening.invalid("client.onAcquire")
      const budget = client.config.maxMessageSize ?? 16 * 1024 * 1024
      const required = Math.max(16 * 1024 * 1024, Number(maxImage) + 4 + 2 + 3 * 4 + 8 + 64)

      if (!Number.isSafeInteger(budget) || budget < required) return yield* opening.invalid("client.maxMessageSize")

      const session = yield* client.reserve.pipe(Effect.mapError((cause) => opening.fail("Storage", cause)))

      const run = (statement: string, params: ReadonlyArray<unknown> = []) =>
        session.execute(statement, params, undefined)

      const metadata = yield* run(`SELECT
    c.relkind = 'r' AND c.relpersistence = 'p' AND NOT c.relrowsecurity
    AND pg_catalog.obj_description(c.oid, 'pg_class') = 'effect-vfs-live-images:1'
    AND NOT EXISTS (SELECT FROM pg_catalog.pg_trigger WHERE tgrelid = c.oid AND NOT tgisinternal)
    AND NOT EXISTS (SELECT FROM pg_catalog.pg_rewrite WHERE ev_class = c.oid)
    AND (SELECT count(*) FROM pg_catalog.pg_constraint WHERE conrelid = c.oid AND contype <> 'n') = 1
    AND EXISTS (SELECT FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_collation k ON k.oid = i.indcollation[0]
      WHERE i.indrelid = c.oid AND i.indisprimary AND i.indisvalid AND i.indisready AND k.collisdeterministic)
    AND EXISTS (SELECT FROM pg_catalog.pg_constraint WHERE conrelid = c.oid AND contype = 'p'
      AND NOT condeferrable AND convalidated AND pg_catalog.pg_get_constraintdef(oid) = 'PRIMARY KEY (volume_key)')
    AS compatible
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'effect_vfs_live_images'`).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Table)),
        Effect.mapError((cause) => opening.fail("IncompatibleStore", cause))
      )

      if (metadata.length !== 1 || metadata[0]?.compatible !== true) return yield* opening.fail("IncompatibleStore")

      const columns = yield* run(`SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
    a.attnotnull AND a.attidentity = '' AND a.attgenerated = '' AND NOT a.atthasdef
    AND (a.attname <> 'volume_key' OR EXISTS (SELECT FROM pg_catalog.pg_collation k
      WHERE k.oid = a.attcollation AND k.collisdeterministic)) AS required
    FROM pg_catalog.pg_attribute a WHERE a.attrelid = 'public.effect_vfs_live_images'::regclass
      AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Columns)),
        Effect.mapError((cause) => opening.fail("IncompatibleStore", cause))
      )

      const expected = [["volume_key", "text"], ["generation", "bigint"], ["image", "bytea"], ["digest", "text"]]

      if (
        columns.length !== expected.length ||
        columns.some((column, index) =>
          column.name !== expected[index]?.[0] || column.type !== expected[index]?.[1] || !column.required
        )
      ) return yield* opening.fail("IncompatibleStore")

      const protocol = yield* Protocol.make<bigint>({
        maxImage,
        loading,
        storage: {
          read: Effect.gen(function*() {
            const rows = yield* run(
              `SELECT generation,
          CASE WHEN octet_length(image) <= $1 THEN image ELSE NULL END AS image, digest
          FROM public.effect_vfs_live_images WHERE volume_key = $2`,
              [Number(maxImage), options.key]
            ).pipe(
              Effect.mapError((cause) => loading.fail("Storage", cause)),
              Effect.flatMap((rows) =>
                Schema.decodeEffect(Row)(rows).pipe(
                  Effect.mapError((cause) => loading.fail("CorruptStore", cause))
                )
              )
            )

            const row = rows[0]

            if (row === undefined) return null

            if (row.image === null) return yield* loading.fail("CorruptStore")

            return {
              image: row.image,
              generation: row.generation.toString(),
              digest: row.digest,
              token: row.generation
            }
          }),
          compareAndSwap: Effect.fnUntraced(function*(expected, next) {
            const generation = BigInt(next.generation)
            const params = [generation, next.image, next.digest, options.key]

            const statement = expected === undefined
              ? "INSERT INTO public.effect_vfs_live_images (generation, image, digest, volume_key) VALUES ($1, $2, $3, $4) ON CONFLICT (volume_key) DO NOTHING RETURNING generation"
              : "UPDATE public.effect_vfs_live_images SET generation = $1, image = $2, digest = $3 WHERE volume_key = $4 AND generation = $5 RETURNING generation"

            const result = yield* Effect.exit(
              run(statement, expected === undefined ? params : [...params, expected]).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Receipt))
              )
            )

            if (Exit.isFailure(result)) {
              if (Cause.hasInterrupts(result.cause)) return yield* Effect.failCause(result.cause).pipe(Effect.orDie)

              return Protocol.WriteResult.Unknown({ cause: result.cause })
            }

            if (result.value.length === 0) return Protocol.WriteResult.Conflict()

            if (result.value.length !== 1 || result.value[0]?.generation !== generation) {
              return Protocol.WriteResult.Unknown({})
            }

            return Protocol.WriteResult.Written({ token: generation })
          })
        }
      })

      return protocol.store
    })
  )
