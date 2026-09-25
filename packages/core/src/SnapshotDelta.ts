/**
 * Opaque portable snapshot deltas and their public inspection models.
 *
 * @since 0.1.0
 */
import * as ByteSize from "effect/ByteSize"
import * as Schema from "effect/Schema"
import { BytePath } from "./BytePath.js"
import * as Internal from "./internal/snapshotDeltaModel.js"

/**
 * Type identifier for opaque snapshot deltas.
 *
 * @category type IDs
 * @since 0.1.0
 */
export const SnapshotDeltaTypeId: "@effect-vfs/core/SnapshotDelta" = Internal.SnapshotDeltaTypeId

/**
 * Type identifier for opaque snapshot deltas.
 *
 * @category type IDs
 * @since 0.1.0
 */
export type SnapshotDeltaTypeId = typeof SnapshotDeltaTypeId

/**
 * An immutable, opaque description of the exact difference between two snapshots.
 *
 * @category models
 * @since 0.1.0
 */
export interface SnapshotDelta {
  readonly [SnapshotDeltaTypeId]: SnapshotDeltaTypeId
}

/**
 * Schema for an already validated opaque snapshot delta.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SnapshotDelta = Schema.declare<SnapshotDelta>(Internal.isSnapshotDelta)

/**
 * Schema for filesystem entry kinds reported by snapshot inspection.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SnapshotNodeKind = Schema.Literals(["directory", "file", "symlink"])

/**
 * A filesystem entry kind reported by snapshot inspection.
 *
 * @category models
 * @since 0.1.0
 */
export type SnapshotNodeKind = typeof SnapshotNodeKind.Type

/**
 * Schema for semantic fields that can differ between snapshots.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SnapshotDifference = Schema.Literals([
  "kind",
  "content",
  "target",
  "hardLinks",
  "mode",
  "uid",
  "gid",
  "atimeNs",
  "mtimeNs",
  "ctimeNs",
  "birthtimeNs"
])

/**
 * A semantic field that differs between two snapshots.
 *
 * @category models
 * @since 0.1.0
 */
export type SnapshotDifference = typeof SnapshotDifference.Type

const SnapshotDifferences = Schema.Array(SnapshotDifference).check(Schema.isMinLength(1))

/**
 * Schema for a path-oriented difference between two snapshots.
 *
 * Independent snapshots do not preserve shared lineage, so moves are reported
 * as a removal and an addition rather than an inferred rename.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const volume = yield* Vfs.make()
 *   const caller = yield* volume.caller()
 *
 *   yield* caller.writeFile("/f", new Uint8Array([1]), {
 *     access: "write",
 *     create: "exclusive"
 *   })
 *
 *   const base = yield* volume.snapshot
 *
 *   yield* caller.writeFile("/f", new Uint8Array([2, 3]), { access: "write", truncate: true })
 *   yield* caller.chmod("/f", 0o600)
 *
 *   const delta = yield* Vfs.diffSnapshots(base, yield* volume.snapshot)
 *   const changes = yield* Vfs.inspectSnapshotDelta(base, delta)
 *
 *   // `Updated` carries which fields moved; `Added` and `Removed` carry a kind.
 *   const change = changes[0]!
 *
 *   return change._tag === "Updated" ? change.differences : change.kind
 * }).pipe(Effect.provide(NodeCrypto.layer))
 *
 * Effect.runPromise(program).then(console.log)
 * // [ 'content', 'mode' ]
 * ```
 *
 * @category schemas
 * @since 0.1.0
 */
export const SnapshotChange = Schema.Union([
  Schema.TaggedStruct("Added", { path: BytePath, kind: SnapshotNodeKind }),
  Schema.TaggedStruct("Removed", { path: BytePath, kind: SnapshotNodeKind }),
  Schema.TaggedStruct("Updated", {
    path: BytePath,
    beforeKind: SnapshotNodeKind,
    afterKind: SnapshotNodeKind,
    differences: SnapshotDifferences
  })
])

/**
 * A path-oriented semantic difference between two snapshots.
 *
 * @category models
 * @since 0.1.0
 */
export type SnapshotChange = typeof SnapshotChange.Type

/**
 * Schema for snapshot-delta inspection options.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const volume = yield* Vfs.make()
 *   const caller = yield* volume.caller()
 *   const base = yield* volume.snapshot
 *
 *   yield* caller.mkdir("/work")
 *
 *   const delta = yield* Vfs.diffSnapshots(base, yield* volume.snapshot)
 *
 *   // Timestamps are excluded by default, since they change on every write.
 *   const plain = yield* Vfs.inspectSnapshotDelta(base, delta)
 *   const timed = yield* Vfs.inspectSnapshotDelta(base, delta, { includeTimestamps: true })
 *
 *   return [plain.length, timed.length]
 * }).pipe(Effect.provide(NodeCrypto.layer))
 *
 * Effect.runPromise(program).then(console.log)
 * // [ 1, 2 ]
 * ```
 *
 * @category schemas
 * @since 0.1.0
 */
export const SnapshotChangesOptions = Schema.Struct({
  /** Include access, modification, change, and birth-time differences. Defaults to `false`. */
  includeTimestamps: Schema.optionalKey(Schema.Boolean)
})

/**
 * Filtering options for snapshot-delta inspection.
 *
 * @category models
 * @since 0.1.0
 */
export type SnapshotChangesOptions = typeof SnapshotChangesOptions.Type

const SnapshotDeltaLimitsSchema = Schema.Struct({
  maxEncodedBytes: Schema.ByteSize,
  maxIdentityBytes: Schema.ByteSize,
  maxDeltaRecords: Schema.Natural,
  maxDecodedDeltaBytes: Schema.ByteSize,
  maxBaseRecords: Schema.Natural,
  maxTargetRecords: Schema.Natural,
  maxEntries: Schema.Natural,
  maxOutputRecords: Schema.Natural,
  maxOutputBytes: Schema.ByteSize,
  maxInheritedRecords: Schema.Natural
})

/**
 * Resource limits shared by delta creation, inspection, encoding, decoding, and application.
 *
 * @category models
 * @since 0.1.0
 */
export type SnapshotDeltaLimits = typeof SnapshotDeltaLimitsSchema.Type

/**
 * Constructs and freezes a complete snapshot-delta resource policy.
 *
 * @internal
 */
export const makeSnapshotDeltaLimits = (limits: SnapshotDeltaLimits): SnapshotDeltaLimits =>
  Object.freeze({ ...limits })

const constrained = makeSnapshotDeltaLimits({
  maxEncodedBytes: ByteSize.mebibytes(2),
  maxIdentityBytes: ByteSize.mebibytes(4),
  maxDeltaRecords: 6_500,
  maxDecodedDeltaBytes: ByteSize.kibibytes(512),
  maxBaseRecords: 6_500,
  maxTargetRecords: 6_500,
  maxEntries: 6_500,
  maxOutputRecords: 6_500,
  maxOutputBytes: ByteSize.kibibytes(256),
  maxInheritedRecords: 6_500
})

const defaultLimits = makeSnapshotDeltaLimits({
  maxEncodedBytes: ByteSize.mebibytes(16),
  maxIdentityBytes: ByteSize.mebibytes(32),
  maxDeltaRecords: 50_000,
  maxDecodedDeltaBytes: ByteSize.mebibytes(8),
  maxBaseRecords: 50_000,
  maxTargetRecords: 50_000,
  maxEntries: 100_000,
  maxOutputRecords: 50_000,
  maxOutputBytes: ByteSize.mebibytes(4),
  maxInheritedRecords: 50_000
})

/**
 * Schema for a complete snapshot-delta resource policy, with frozen presets.
 *
 * The constrained preset is intended for memory-sensitive environments. The
 * default preset permits larger snapshots and payloads while remaining finite.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const volume = yield* Vfs.make()
 *   const base = yield* volume.snapshot
 *
 *   yield* (yield* volume.caller()).mkdir("/work")
 *
 *   // Omitting limits uses `default`; pass `constrained` where memory is tight.
 *   return yield* Vfs.diffSnapshots(
 *     base,
 *     yield* volume.snapshot,
 *     Vfs.SnapshotDeltaLimits.constrained
 *   )
 * }).pipe(Effect.provide(NodeCrypto.layer))
 * ```
 *
 * @category schemas
 * @since 0.1.0
 */
export const SnapshotDeltaLimits = Object.assign(SnapshotDeltaLimitsSchema, {
  constrained,
  default: defaultLimits
})
