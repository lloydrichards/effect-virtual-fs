/**
 * Bounded Cloudflare D1 live images with application-controlled ownership.
 *
 * @since 0.12.0
 */
import { LiveVolume, type VfsError } from "@effect-vfs/core"
import * as D1Client from "@effect/sql-d1/D1Client"
import { type ByteSize, Cause, Effect, Exit, Fiber, Layer, Predicate, Schema, Scope } from "effect"
import type * as Digest from "effect/crypto/Digest"
import * as Protocol from "./internal/liveImageProtocol.js"
import { SqlLiveImageKey } from "./internal/sqlLiveImageKey.js"
import { storeFailures } from "./internal/storeSupport.js"

/**
 * Stable volume identity and image budget. Supply a native D1Client backed by
 * a plain primary-serving D1Database, and run the packaged migration first.
 *
 * @example
 * ```ts
 * import type { Options } from "@effect-vfs/persistence/D1LiveImageStore"
 * import { ByteSize } from "effect"
 *
 * const options: Options = {
 *   key: "workspace-123",
 *   maxImageBytes: ByteSize.kibibytes(512)
 * }
 * ```
 *
 * @since 0.12.0
 * @category models
 */
export interface Options {
  /** Between 1 and 256 UTF-16 code units, without NUL or unpaired surrogates. */
  readonly key: string
  /** Positive and at most 1 MiB, leaving headroom below D1's total row limit. */
  readonly maxImageBytes: ByteSize.ByteSize
}

const opening = storeFailures("D1LiveImageStore.layer")

const loading = storeFailures("D1LiveImageStore.loadOrCreate")

const NativeMethod = Schema.declare(Predicate.isFunction)

const Binding = Schema.Struct({
  prepare: NativeMethod,
  batch: NativeMethod,
  exec: NativeMethod,
  dump: NativeMethod,
  withSession: NativeMethod
})

const Byte = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))

const Column = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  notnull: Schema.Finite,
  pk: Schema.Finite,
  hidden: Schema.Finite,
  dflt_value: Schema.Unknown
})

const Table = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  strict: Schema.Finite,
  ncol: Schema.Finite,
  wr: Schema.Finite
})

const Index = Schema.Struct({
  name: Schema.String,
  unique: Schema.Finite,
  origin: Schema.String,
  partial: Schema.Finite
})

const TableDeclaration = Schema.Struct({ name: Schema.String, sql: Schema.String })

const VersionOneTables = [
  [
    "effect_vfs_live_images",
    "CREATE TABLE effect_vfs_live_images (volume_key TEXT PRIMARY KEY NOT NULL, generation INTEGER NOT NULL, image BLOB NOT NULL, digest TEXT NOT NULL) STRICT"
  ],
  [
    "effect_vfs_live_images_schema",
    "CREATE TABLE effect_vfs_live_images_schema (id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1), version INTEGER NOT NULL CHECK (version = 1)) STRICT"
  ]
] as const

const normalizeDeclaration = (sql: string) =>
  sql.replace(
    /"(?:""|[^"])*"/g,
    (identifier) => /^"[a-z_][a-z0-9_]*"$/i.test(identifier) ? identifier.slice(1, -1) : identifier
  ).replace(/\s+/g, "").replace(/;$/, "").toLowerCase()

const Result = <A>(row: Schema.ConstraintDecoder<A>) =>
  Schema.Struct({ success: Schema.Literal(true), results: Schema.Array(row) })

/**
 * Borrows the supplied native D1Client without closing it. Its binding must
 * serve the primary; D1DatabaseSession bindings are rejected before SQL.
 * Require one application-controlled owner per key. Interrupted or uncertain
 * writes freeze the owner. Closing the Layer waits for pending statements to
 * settle before ownership can be handed off. The guarantee is memory-only.
 *
 * @example
 * ```ts
 * import * as D1LiveImageStore from "@effect-vfs/persistence/D1LiveImageStore"
 * import * as D1Client from "@effect/sql-d1/D1Client"
 * import { ByteSize, Layer } from "effect"
 *
 * const store = (db: D1Client.D1ClientConfig["db"]) =>
 *   D1LiveImageStore.layer({
 *     key: "workspace-123",
 *     maxImageBytes: ByteSize.kibibytes(512)
 *   }).pipe(Layer.provide(D1Client.layer({ db })))
 * ```
 *
 * @since 0.12.0
 * @category layers
 */
export const layer = (
  options: Options
): Layer.Layer<
  LiveVolume.LiveImageStore,
  VfsError.ArgumentFailure | VfsError.StoreFailure,
  D1Client.D1Client | Digest.Digest
> =>
  Layer.effect(
    LiveVolume.LiveImageStore,
    Effect.gen(function*() {
      const maxImage = yield* Protocol.imageLimit(options.maxImageBytes, opening)

      if (maxImage > 1_048_576n) return yield* opening.invalid("maxImageBytes")
      yield* Schema.decodeEffect(SqlLiveImageKey)(options.key).pipe(Effect.mapError(() => opening.invalid("key")))
      const supplied = yield* D1Client.D1Client
      yield* Schema.decodeEffect(Binding)(supplied.config.db).pipe(Effect.mapError(() => opening.invalid("db")))
      const client = supplied.withoutTransforms()
      const scope = yield* Scope.Scope

      const run = Effect.fnUntraced(function*(statement: string, params: ReadonlyArray<unknown> = []) {
        // The binding has no cancellation acknowledgement. Keep its query alive in
        // the owner scope while allowing the caller waiting on it to be interrupted.
        // Scope closure drains these fibers before an application replaces the owner.
        const query = Effect.try({
          try: () => client.unsafe(statement, params).raw,
          catch: (cause) => loading.fail("Storage", cause)
        }).pipe(
          Effect.flatten,
          Effect.mapError((cause) => loading.fail("Storage", cause)),
          Effect.uninterruptible
        )

        const pending = yield* Effect.forkIn(query, scope)

        return yield* Fiber.join(pending)
      })

      const querySchema = Effect.fnUntraced(function*<A>(schema: Schema.ConstraintDecoder<A>, statement: string) {
        const raw = yield* run(statement)

        return (yield* Schema.decodeUnknownEffect(Result(schema))(raw)).results
      })

      yield* Effect.gen(function*() {
        // Column PRAGMAs miss CHECKs and references that can reject valid commits
        // or cascade image deletion. Admit only the published v1 declarations,
        // allowing lexical spelling differences but retaining SQL expression text.
        const declarations = yield* querySchema(
          TableDeclaration,
          "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name IN ('effect_vfs_live_images', 'effect_vfs_live_images_schema')"
        )

        if (declarations.length !== VersionOneTables.length) return yield* opening.fail("IncompatibleStore")

        for (const [name, expected] of VersionOneTables) {
          const actual = declarations.find((declaration) => declaration.name === name)?.sql

          if (actual === undefined || normalizeDeclaration(actual) !== normalizeDeclaration(expected)) {
            return yield* opening.fail("IncompatibleStore")
          }
        }

        for (
          const [table, expected] of [
            ["effect_vfs_live_images", [["volume_key", "TEXT"], ["generation", "INTEGER"], ["image", "BLOB"], [
              "digest",
              "TEXT"
            ]]],
            ["effect_vfs_live_images_schema", [["id", "INTEGER"], ["version", "INTEGER"]]]
          ] as const
        ) {
          const columns = yield* querySchema(Column, `PRAGMA table_xinfo('${table}')`)
          const tables = yield* querySchema(Table, `PRAGMA table_list('${table}')`)

          if (
            tables.length !== 1 || tables[0]?.type !== "table" || tables[0]?.strict !== 1 || tables[0]?.wr !== 0 ||
            tables[0]?.ncol !== expected.length
          ) return yield* opening.fail("IncompatibleStore")

          if (
            columns.length !== expected.length ||
            columns.some((column, index) =>
              column.name !== expected[index]?.[0] || column.type !== expected[index]?.[1] || column.notnull !== 1 ||
              column.pk !== (index === 0 ? 1 : 0) || column.hidden !== 0 || column.dflt_value !== null
            )
          ) return yield* opening.fail("IncompatibleStore")
        }

        const indexes = yield* querySchema(Index, "PRAGMA index_list('effect_vfs_live_images')")

        if (
          indexes.length !== 1 || indexes[0]?.unique !== 1 || indexes[0]?.origin !== "pk" || indexes[0]?.partial !== 0
        ) return yield* opening.fail("IncompatibleStore")

        const keyColumns = yield* querySchema(
          Schema.Struct({
            name: Schema.NullOr(Schema.String),
            coll: Schema.String,
            key: Schema.Finite,
            desc: Schema.Finite
          }),
          "PRAGMA index_xinfo('sqlite_autoindex_effect_vfs_live_images_1')"
        )

        const indexed = keyColumns.filter((column) => column.key === 1)

        if (
          indexed.length !== 1 || indexed[0]?.name !== "volume_key" || indexed[0]?.coll !== "BINARY" ||
          indexed[0]?.desc !== 0
        ) return yield* opening.fail("IncompatibleStore")

        const triggers = yield* querySchema(
          Schema.Struct({ count: Schema.Finite }),
          "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'trigger' AND tbl_name IN ('effect_vfs_live_images', 'effect_vfs_live_images_schema')"
        )

        if (triggers[0]?.count !== 0) return yield* opening.fail("IncompatibleStore")

        const version = yield* querySchema(
          Schema.Struct({ id: Schema.Finite, version: Schema.Finite }),
          "SELECT id, version FROM effect_vfs_live_images_schema"
        )

        if (version.length !== 1 || version[0]?.id !== 1 || version[0]?.version !== 1) {
          return yield* opening.fail("IncompatibleStore")
        }
      }).pipe(Effect.mapError((cause) => opening.fail("IncompatibleStore", cause)))

      const Row = Result(
        Schema.Struct({
          generation: Schema.Unknown,
          digest: Schema.Unknown,
          kind: Schema.String,
          size: Schema.Int,
          image: Schema.Unknown
        })
      )

      const Receipt = Result(Schema.Struct({ generation: Schema.Finite }))

      const protocol = yield* Protocol.make<{ readonly generation: unknown }>({
        maxImage,
        loading,
        storage: {
          read: Effect.gen(function*() {
            const response = yield* run(
              "SELECT generation, digest, typeof(image) AS kind, length(image) AS size, CASE WHEN typeof(image) = 'blob' AND length(image) <= ? THEN image ELSE NULL END AS image FROM effect_vfs_live_images WHERE volume_key = ?",
              [Number(maxImage), options.key]
            )

            const { results } = yield* Schema.decodeUnknownEffect(Row)(response).pipe(
              Effect.mapError((cause) => loading.fail("CorruptStore", cause))
            )

            if (results.length === 0) return null
            const row = results[0]

            if (
              results.length !== 1 || row === undefined || row.kind !== "blob" || row.size < 0 ||
              BigInt(row.size) > maxImage
            ) return yield* loading.fail("CorruptStore")

            // Validate byte values and length before constructing a Uint8Array, which
            // would otherwise silently truncate malformed numeric BLOB values.
            const bytes = yield* Schema.decodeUnknownEffect(
              Schema.Array(Byte).check(Schema.isMaxLength(Number(maxImage)))
            )(row.image).pipe(Effect.mapError((cause) => loading.fail("CorruptStore", cause)))

            if (bytes.length !== row.size) return yield* loading.fail("CorruptStore")

            return {
              image: new Uint8Array(bytes),
              generation: row.generation,
              digest: row.digest,
              token: { generation: row.generation }
            }
          }),
          compareAndSwap: Effect.fnUntraced(function*(expected, next) {
            const statement = expected === undefined
              ? "INSERT INTO effect_vfs_live_images (generation, image, digest, volume_key) VALUES (?, ?, ?, ?) ON CONFLICT (volume_key) DO NOTHING RETURNING generation"
              : "UPDATE effect_vfs_live_images SET generation = ?, image = ?, digest = ? WHERE volume_key = ? AND generation = ? RETURNING generation"

            const params = [next.generation, next.image, next.digest, options.key]

            const attempted = yield* Effect.exit(
              run(statement, expected === undefined ? params : [...params, expected.generation]).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Receipt))
              )
            )

            if (Exit.isFailure(attempted)) {
              if (Cause.hasInterrupts(attempted.cause)) {
                return yield* Effect.failCause(attempted.cause).pipe(Effect.orDie)
              }

              return Protocol.WriteResult.Unknown({ cause: attempted.cause })
            }

            const rows = attempted.value.results

            if (rows.length === 0) return Protocol.WriteResult.Conflict()

            if (rows.length !== 1 || rows[0]?.generation !== next.generation) return Protocol.WriteResult.Unknown({})

            return Protocol.WriteResult.Written({ token: { generation: next.generation } })
          })
        }
      })

      return protocol.store
    })
  )
