/**
 * Create-only SQLite checkpoints. Applications own capture, database provisioning,
 * migration timing, and restoration into a fresh volume.
 *
 * @since 0.1.0
 */
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Context, Data, Effect, Layer, Schema } from "effect"
import * as Migrator from "effect/unstable/sql/Migrator"
import { SafeIntegers, SqlClient } from "effect/unstable/sql/SqlClient"

/**
 * Checkpoint lookup, naming, or storage failure. Image failures retain core's `ImageError`.
 *
 * @category errors
 * @since 0.1.0
 */
export class CheckpointError extends Data.TaggedError("CheckpointError")<{
  readonly code: "InvalidName" | "NotFound" | "AlreadyExists" | "Storage"
  readonly operation: "save" | "load" | "migrate"
  readonly name?: string
  readonly cause?: unknown
}> {}

/**
 * Named checkpoints with no implicit capture, replacement, or live-write persistence.
 *
 * @category models
 * @since 0.1.0
 */
export interface CheckpointStoreShape {
  /** Saves a new name. A duplicate fails without modifying the existing checkpoint. */
  readonly save: (name: string, snapshot: Vfs.Snapshot) => Effect.Effect<void, CheckpointError | Vfs.ImageError>
  /** Loads a validated snapshot. A missing name fails with `NotFound`. */
  readonly load: (name: string) => Effect.Effect<Vfs.Snapshot, CheckpointError | Vfs.ImageError>
}

const checkName = (name: string, operation: "save" | "load") =>
  Effect.suspend(() => {
    if (typeof name !== "string" || name.length === 0 || name.length > 255 || name.includes("\0")) {
      return Effect.fail(new CheckpointError({ code: "InvalidName", operation }))
    }
    const bytes = new TextEncoder().encode(name)
    // Reject lone surrogates rather than allowing SQLite's UTF-8 boundary to alias names.
    return bytes.length > 255 || new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) !== name
      ? Effect.fail(new CheckpointError({ code: "InvalidName", operation }))
      : Effect.void
  })

const StoredRow = Schema.Struct({
  kind: Schema.String,
  size: Schema.NullOr(Schema.Union([Schema.Finite, Schema.BigInt])),
  image: Schema.NullOr(Schema.Uint8Array)
})

/**
 * SQLite checkpoint service. Supply a SQLite `SqlClient` and run `migrate` before use.
 * Driver lifetime belongs to the application's layer scope.
 *
 * @category services
 * @since 0.1.0
 */
export class CheckpointStore extends Context.Service<CheckpointStore, CheckpointStoreShape>()(
  "@effect-vfs/persistence/CheckpointStore"
) {
  /**
   * Creates a store with an owned copy of mandatory image limits.
   * Saving validates against the same limits used by loading.
   */
  static readonly make = Effect.fn("CheckpointStore.make")(function*(limits: Vfs.DecodeLimits) {
    const ownedLimits = yield* Schema.decodeEffect(Vfs.DecodeLimits, { onExcessProperty: "error" })(limits).pipe(
      Effect.mapError(() => new Vfs.ImageError({ code: "InvalidStructure", field: "limits" }))
    )
    const sql = (yield* SqlClient).withoutTransforms()

    const save = Effect.fn("CheckpointStore.save")(function*(name: string, snapshot: Vfs.Snapshot) {
      yield* checkName(name, "save")
      const image = yield* Vfs.encodeSnapshot(snapshot)

      yield* Vfs.decodeSnapshot(image, ownedLimits)

      const inserted = yield* sql`
        INSERT INTO effect_vfs_checkpoints (name, image) VALUES (${name}, ${image})
        ON CONFLICT(name) DO NOTHING RETURNING name
      `.pipe(Effect.mapError(
        (cause) => new CheckpointError({ code: "Storage", operation: "save", name, cause })
      ))

      if (inserted.length === 0) return yield* new CheckpointError({ code: "AlreadyExists", operation: "save", name })
    })

    const load = Effect.fn("CheckpointStore.load")(function*(name: string) {
      yield* checkName(name, "load")

      const rows = yield* sql`
        SELECT typeof(image) AS kind,
          CASE WHEN typeof(image) = 'blob' THEN length(image) ELSE NULL END AS size,
          CASE WHEN typeof(image) = 'blob' AND length(image) <= ${ownedLimits.maxEncodedBytes}
            THEN image ELSE NULL END AS image
        FROM effect_vfs_checkpoints WHERE name = ${name}
      `.pipe(Effect.mapError(
        (cause) => new CheckpointError({ code: "Storage", operation: "load", name, cause })
      ))

      if (rows.length === 0) return yield* new CheckpointError({ code: "NotFound", operation: "load", name })
      const row = yield* Schema.decodeUnknownEffect(StoredRow)(rows[0]).pipe(
        Effect.mapError(() => new Vfs.ImageError({ code: "InvalidStructure", field: "row" }))
      )
      if (row.kind !== "blob" || row.size === null) {
        return yield* new Vfs.ImageError({ code: "InvalidStructure", field: "image" })
      }
      if (row.size > ownedLimits.maxEncodedBytes) {
        return yield* new Vfs.ImageError({ code: "LimitExceeded", field: "encodedBytes" })
      }
      if (row.image === null) return yield* new Vfs.ImageError({ code: "InvalidStructure", field: "image" })
      return yield* Vfs.decodeSnapshot(row.image, ownedLimits)
    })

    return { save, load } satisfies CheckpointStoreShape
  })

  /** Provides a store using the application-supplied SQLite client. Does not run migrations. */
  static readonly layer = (limits: Vfs.DecodeLimits) => Layer.effect(CheckpointStore, CheckpointStore.make(limits))

  /**
   * Applies the package's numbered SQLite migrations using a separate migration ledger.
   * Run during application startup before providing the store to consumers.
   */
  static readonly migrate: Effect.Effect<void, CheckpointError, SqlClient> = Effect.gen(function*() {
    const sql = (yield* SqlClient).withoutTransforms()
    yield* Migrator.make({})({
      table: "effect_vfs_checkpoint_migrations",
      loader: Migrator.fromRecord({
        "001_checkpoints": Effect.gen(function*() {
          const sql = yield* SqlClient
          yield* sql`CREATE TABLE effect_vfs_checkpoints (
          name TEXT NOT NULL PRIMARY KEY,
          image BLOB NOT NULL CHECK(typeof(image) = 'blob')
        )`
        })
      })
    }).pipe(Effect.provideService(SqlClient, sql), Effect.provideService(SafeIntegers, false))
  }).pipe(
    Effect.catchDefect((cause) => cause instanceof Migrator.MigrationError ? Effect.fail(cause) : Effect.die(cause)),
    Effect.asVoid,
    Effect.mapError((cause) => new CheckpointError({ code: "Storage", operation: "migrate", cause })),
    Effect.withSpan("CheckpointStore.migrate")
  )
}
