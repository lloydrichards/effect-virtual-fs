/**
 * Opaque portable snapshot deltas and their public inspection models.
 *
 * A delta names its base and target snapshots by their semantic identities and
 * holds one change per path that differs, each carrying only the node it
 * leaves behind, so its size follows what changed rather than the tree.
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
  /** Maximum encoded delta length in bytes. */
  maxEncodedBytes: Schema.ByteSize,
  /** Maximum bytes hashed for one snapshot's identity. */
  maxIdentityBytes: Schema.ByteSize,
  /** Maximum number of changes a delta holds. */
  maxDeltaRecords: Schema.Natural,
  /** Maximum decoded bytes of a delta's digests, paths and payloads. */
  maxDecodedDeltaBytes: Schema.ByteSize,
  /** Maximum number of nodes in the base snapshot. */
  maxBaseRecords: Schema.Natural,
  /** Maximum number of nodes in the target snapshot. */
  maxTargetRecords: Schema.Natural,
  /** Maximum number of names in either snapshot, and of names a delta writes. */
  maxEntries: Schema.Natural,
  /** Maximum number of nodes an applied delta produces. */
  maxOutputRecords: Schema.Natural,
  /** Maximum payload bytes of the target, and of the payloads a delta carries. */
  maxOutputBytes: Schema.ByteSize,
  /** Maximum number of target nodes carried over from the base rather than written by the delta. */
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

/**
 * Schema for what one side of a merge did at a conflicted path.
 *
 * `Unchanged` means the side did not touch the path itself; a conflict can
 * still name it when the other side's change depends on it, for example a
 * hard-link group whose membership diverged, or a name held at base because
 * it shares a node with a conflicted name.
 *
 * @category schemas
 * @since 0.8.0
 */
export const MergeSideChange = Schema.TaggedUnion({
  Unchanged: {},
  Added: { kind: SnapshotNodeKind },
  Removed: { kind: SnapshotNodeKind },
  Updated: {
    beforeKind: SnapshotNodeKind,
    afterKind: SnapshotNodeKind,
    differences: SnapshotDifferences
  }
})

/**
 * What one side of a merge did at a conflicted path.
 *
 * @category models
 * @since 0.8.0
 */
export type MergeSideChange = typeof MergeSideChange.Type

/**
 * Schema for the reasons a path-level merge reports a conflict.
 *
 * - `BothChanged`: both sides changed the same field of one node to different values.
 * - `ChangedRemoved`: one side changed a node the other side removed, or linked a new name to it.
 * - `BothAddedDifferent`: both sides added different nodes at one path.
 * - `KindDiverged`: one side changed a node's kind while the other side changed or removed the node.
 * - `ParentRemoved`: one side changed a path under a directory the other side removed or replaced.
 * - `HardLinkGroupDiverged`: both sides changed which names share one hard-linked node.
 *
 * @category schemas
 * @since 0.8.0
 */
export const MergeConflictReason = Schema.Literals([
  "BothChanged",
  "ChangedRemoved",
  "BothAddedDifferent",
  "KindDiverged",
  "ParentRemoved",
  "HardLinkGroupDiverged"
])

/**
 * The reason a path-level merge reports a conflict.
 *
 * @category models
 * @since 0.8.0
 */
export type MergeConflictReason = typeof MergeConflictReason.Type

/**
 * Schema for one conflict between two snapshot deltas from the same base.
 *
 * A conflict carries what each side did, as kinds and changed fields, and no
 * payload bytes or metadata values. The application reads those from the base,
 * ours, and theirs snapshots it already holds. Timestamp fields are left out of
 * `differences`, because timestamps never conflict.
 *
 * @category schemas
 * @since 0.8.0
 */
export const MergeConflict = Schema.Struct({
  path: BytePath,
  reason: MergeConflictReason,
  ours: MergeSideChange,
  theirs: MergeSideChange
})

/**
 * One conflict between two snapshot deltas from the same base.
 *
 * @category models
 * @since 0.8.0
 */
export type MergeConflict = typeof MergeConflict.Type

/**
 * Schema for the side a merge takes at one conflicted path.
 *
 * @category schemas
 * @since 0.8.0
 */
export const MergeTake = Schema.Literals(["ours", "theirs", "base"])

/**
 * The side a merge takes at one conflicted path.
 *
 * @category models
 * @since 0.8.0
 */
export type MergeTake = typeof MergeTake.Type

/**
 * Schema for one resolution of a reported merge conflict.
 *
 * The path must be one a previous merge of the same inputs reported.
 * Conflicts that span several paths, a removed directory's subtree or a
 * hard-link group, take one side as a whole: every reported path in the set
 * must name the same side.
 *
 * @category schemas
 * @since 0.8.0
 */
export const MergeResolution = Schema.Struct({
  path: BytePath,
  take: MergeTake
})

/**
 * One resolution of a reported merge conflict.
 *
 * @category models
 * @since 0.8.0
 */
export type MergeResolution = typeof MergeResolution.Type

/**
 * Schema for snapshot-delta merge options.
 *
 * @category schemas
 * @since 0.8.0
 */
export const MergeOptions = Schema.Struct({
  /** Sides to take at paths an earlier merge reported as conflicts. */
  resolutions: Schema.optionalKey(Schema.Array(MergeResolution)),
  /** Resource limits for verifying both deltas and building the merged one. Defaults to `SnapshotDeltaLimits.default`. */
  limits: Schema.optionalKey(SnapshotDeltaLimitsSchema)
})

/**
 * Snapshot-delta merge options.
 *
 * @category models
 * @since 0.8.0
 */
export type MergeOptions = typeof MergeOptions.Type

/**
 * Schema for the result of merging two snapshot deltas.
 *
 * The delta applies every change neither side disputed, plus every resolved
 * conflict; paths still in conflict keep the base node. It is bound to the
 * same base as its inputs and applies with `applySnapshotDelta`.
 *
 * @category schemas
 * @since 0.8.0
 */
export const MergeResult = Schema.Struct({
  delta: SnapshotDelta,
  conflicts: Schema.Array(MergeConflict)
})

/**
 * The result of merging two snapshot deltas.
 *
 * @category models
 * @since 0.8.0
 */
export type MergeResult = typeof MergeResult.Type
