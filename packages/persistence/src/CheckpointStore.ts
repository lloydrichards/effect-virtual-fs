/**
 * Create-only SQLite checkpoints. Applications own capture, database provisioning,
 * migration timing, and restoration into a fresh volume.
 *
 * @since 0.1.0
 */
import { VfsError, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { ByteSize, Context, Data, Effect, Layer, Schema } from "effect"
import * as Migrator from "effect/unstable/sql/Migrator"
import { SafeIntegers, SqlClient } from "effect/unstable/sql/SqlClient"

/**
 * Checkpoint lookup, naming, or storage failure. Rejected limits and unusable images fail with core's `VfsError`
 * instead, reporting the image code, such as `InvalidStructure` or `LimitExceeded`. Every failure names the
 * entry point that raised it as its operation: `CheckpointStore.make`, `CheckpointStore.save`,
 * `CheckpointStore.load` or `CheckpointStore.migrate`.
 *
 * @example
 * ```ts
 * // `NotFound` is expected on a first run; other codes are real failures.
 * import { CheckpointStore } from "@effect-vfs/persistence"
 * import { ByteSize, Effect } from "effect"
 *
 * const limits = {
 *   maxEncodedBytes: ByteSize.megabytes(4),
 *   maxRecords: 10_000,
 *   maxEntries: 10_000,
 *   maxDecodedBytes: ByteSize.megabytes(16)
 * }
 *
 * const loadOrStartFresh = Effect.gen(function*() {
 *   const store = yield* CheckpointStore.make(limits)
 *
 *   return yield* store.load("nightly").pipe(
 *     Effect.asSome,
 *     Effect.catchTag("CheckpointError", (error) =>
 *       error.code === "NotFound" ? Effect.succeedNone : Effect.fail(error))
 *   )
 * })
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export class CheckpointError extends Data.TaggedError("CheckpointError")<{
  readonly code: "InvalidName" | "NotFound" | "AlreadyExists" | "Storage"
  readonly operation: "CheckpointStore.save" | "CheckpointStore.load" | "CheckpointStore.migrate"
  readonly name?: string
  readonly cause?: unknown
}> {}

const checkName = (name: string, operation: "CheckpointStore.save" | "CheckpointStore.load") =>
  Effect.suspend(() => {
    if (name.length === 0 || name.length > 255 || name.includes("\0")) {
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

// A stored row that cannot be a checkpoint image, reported against the load entry point.
const loadFailure = (code: "InvalidStructure" | "LimitExceeded", field: string) =>
  VfsError.make({ code, operation: "CheckpointStore.load", field })

// Core's codecs name themselves as the operation; a checkpoint failure names the store's entry point instead.
const asEntryPoint = (operation: "CheckpointStore.save" | "CheckpointStore.load") => (error: Vfs.VfsError) =>
  VfsError.make({ code: error.code, operation, field: error.field, path: error.path, cause: error.cause })

// Implemented at module scope so `make` and `layer` can be real static methods:
// docgen only documents class members declared as methods, and silently skips
// static properties, which left these entry points off the API page entirely.
const makeStore = Effect.fn("CheckpointStore.make")(function*(limits: Vfs.DecodeLimits) {
  const ownedLimits = yield* Schema.decodeEffect(Vfs.DecodeLimits, { onExcessProperty: "error" })(limits).pipe(
    Effect.mapError(() =>
      VfsError.make({ code: "InvalidArgument", operation: "CheckpointStore.make", field: "limits" })
    )
  )

  const sql = (yield* SqlClient).withoutTransforms()
  const maxEncodedBytes = ByteSize.toBigInt(ownedLimits.maxEncodedBytes)

  // Encoding under the store's limits fails wherever decoding under them would, so a saved image is known to load
  // without being decoded here.
  const save = Effect.fn("CheckpointStore.save")(function*(name: string, snapshot: Vfs.Snapshot) {
    yield* checkName(name, "CheckpointStore.save")

    const image = yield* Vfs.encodeSnapshot(snapshot, ownedLimits).pipe(
      Effect.mapError(asEntryPoint("CheckpointStore.save"))
    )

    const inserted = yield* sql`
      INSERT INTO effect_vfs_checkpoints (name, image) VALUES (${name}, ${image})
      ON CONFLICT(name) DO NOTHING RETURNING name
    `.pipe(Effect.mapError(
      (cause) => new CheckpointError({ code: "Storage", operation: "CheckpointStore.save", name, cause })
    ))

    if (inserted.length === 0) {
      return yield* new CheckpointError({ code: "AlreadyExists", operation: "CheckpointStore.save", name })
    }
  })

  const load = Effect.fn("CheckpointStore.load")(function*(name: string) {
    yield* checkName(name, "CheckpointStore.load")

    const rows = yield* sql`
      SELECT typeof(image) AS kind,
        CASE WHEN typeof(image) = 'blob' THEN length(image) ELSE NULL END AS size,
        CASE WHEN typeof(image) = 'blob' AND length(image) <= ${maxEncodedBytes}
          THEN image ELSE NULL END AS image
      FROM effect_vfs_checkpoints WHERE name = ${name}
    `.pipe(Effect.mapError(
      (cause) => new CheckpointError({ code: "Storage", operation: "CheckpointStore.load", name, cause })
    ))

    if (rows.length === 0) {
      return yield* new CheckpointError({ code: "NotFound", operation: "CheckpointStore.load", name })
    }

    const row = yield* Schema.decodeUnknownEffect(StoredRow)(rows[0]).pipe(
      Effect.mapError(() => loadFailure("InvalidStructure", "row"))
    )

    if (row.kind !== "blob" || row.size === null) {
      return yield* loadFailure("InvalidStructure", "image")
    }

    if (BigInt(row.size) > maxEncodedBytes) {
      return yield* loadFailure("LimitExceeded", "encodedBytes")
    }

    if (row.image === null) {
      return yield* loadFailure("InvalidStructure", "image")
    }

    return yield* Vfs.decodeSnapshot(row.image, ownedLimits).pipe(Effect.mapError(asEntryPoint("CheckpointStore.load")))
  })

  return CheckpointStore.of({ save, load })
})

/**
 * SQLite checkpoint service. Supply a SQLite `SqlClient` and run `migrate` before use.
 * Driver lifetime belongs to the application's layer scope.
 *
 * **Details**
 *
 * `CheckpointStore.migrate` applies the package's numbered migrations through a
 * separate ledger table, `effect_vfs_checkpoint_migrations`. Run it once during
 * application startup, before providing the store to consumers; it is safe to
 * run again on later startups. Neither `make` nor `layer` runs it.
 *
 * @see The SQLite checkpoints guide at `/guides/sqlite-checkpoints` for driver
 * selection, transaction semantics, and durability caveats.
 *
 * @example
 * ```ts
 * import { CheckpointStore } from "@effect-vfs/persistence"
 * import { ByteSize, Effect, Layer } from "effect"
 * import type { SqlClient } from "effect/unstable/sql/SqlClient"
 *
 * const limits = {
 *   maxEncodedBytes: ByteSize.megabytes(4),
 *   maxRecords: 10_000,
 *   maxEntries: 10_000,
 *   maxDecodedBytes: ByteSize.megabytes(16)
 * }
 *
 * // `migrate` creates the package tables and must run before the store is used.
 * const checkpoints = (sqlite: Layer.Layer<SqlClient>) =>
 *   CheckpointStore.layer(limits).pipe(
 *     Layer.provide(Layer.effectDiscard(CheckpointStore.migrate)),
 *     Layer.provide(sqlite)
 *   )
 *
 * const program = (sqlite: Layer.Layer<SqlClient>) =>
 *   Effect.gen(function*() {
 *     const store = yield* CheckpointStore
 *
 *     return yield* store.load("nightly")
 *   }).pipe(Effect.provide(checkpoints(sqlite)))
 * ```
 *
 * @category services
 * @since 0.1.0
 */
export class CheckpointStore extends Context.Service<CheckpointStore, {
  /** Saves a new name. A duplicate fails without modifying the existing checkpoint. */
  readonly save: (name: string, snapshot: Vfs.Snapshot) => Effect.Effect<void, CheckpointError | Vfs.VfsError>
  /** Loads a validated snapshot. A missing name fails with `NotFound`. */
  readonly load: (name: string) => Effect.Effect<Vfs.Snapshot, CheckpointError | Vfs.VfsError>
}>()(
  "@effect-vfs/persistence/CheckpointStore"
) {
  /**
   * Creates a store with an owned copy of mandatory image limits.
   * Saving encodes under the same limits loading decodes under and fails where
   * loading would, so a saved checkpoint is known to load without being decoded.
   *
   * @example
   * ```ts
   * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
   * import { CheckpointStore } from "@effect-vfs/persistence"
   * import { ByteSize, Effect, Layer } from "effect"
   * import type { SqlClient } from "effect/unstable/sql/SqlClient"
   *
   * const limits = {
   *   maxEncodedBytes: ByteSize.megabytes(4),
   *   maxRecords: 10_000,
   *   maxEntries: 10_000,
   *   maxDecodedBytes: ByteSize.megabytes(16)
   * }
   *
   * const program = Effect.gen(function*() {
   *   const store = yield* CheckpointStore.make(limits)
   *
   *   const volume = yield* Vfs.fromFixture({
   *     entries: [{ kind: "file", path: "/notes.txt", bytes: new Uint8Array([104, 105]) }]
   *   })
   *
   *   yield* store.save("nightly", yield* volume.snapshot)
   *
   *   // Restoration always produces a fresh volume.
   *   return yield* Vfs.fromSnapshot(yield* store.load("nightly"))
   * })
   *
   * // The package does not choose a driver; supply your own SQLite client.
   * const runnable = (sqlite: Layer.Layer<SqlClient>) => program.pipe(Effect.provide(sqlite))
   * ```
   *
   * @since 0.1.0
   */
  static make(limits: Vfs.DecodeLimits) {
    return makeStore(limits)
  }

  /**
   * Provides a store using the application-supplied SQLite client. Does not run migrations.
   *
   * @example
   * ```ts
   * import { CheckpointStore } from "@effect-vfs/persistence"
   * import { ByteSize, Layer } from "effect"
   * import type { SqlClient } from "effect/unstable/sql/SqlClient"
   *
   * const limits = {
   *   maxEncodedBytes: ByteSize.megabytes(4),
   *   maxRecords: 10_000,
   *   maxEntries: 10_000,
   *   maxDecodedBytes: ByteSize.megabytes(16)
   * }
   *
   * // The application chooses the driver, for example SqliteClient.layer(...)
   * // from @effect/sql-sqlite-bun. Migrations are a separate startup step.
   * const checkpoints = (sqlite: Layer.Layer<SqlClient>) =>
   *   CheckpointStore.layer(limits).pipe(Layer.provide(sqlite))
   * ```
   *
   * @since 0.1.0
   */
  static layer(limits: Vfs.DecodeLimits) {
    return Layer.effect(CheckpointStore, makeStore(limits))
  }

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
    Effect.mapError((cause) => new CheckpointError({ code: "Storage", operation: "CheckpointStore.migrate", cause })),
    Effect.withSpan("CheckpointStore.migrate")
  )
}
