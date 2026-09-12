/**
 * Opaque portable snapshot deltas and their public inspection models.
 *
 * @since 0.1.0
 */
import * as Data from "effect/Data"
import * as Schema from "effect/Schema"
import { BytePath } from "./BytePath.js"

const Natural = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/** Type identifier for opaque snapshot deltas. */
export const SnapshotDeltaTypeId = Symbol("@effect-vfs/core/SnapshotDelta")
/** Type identifier for opaque snapshot deltas. */
export type SnapshotDeltaTypeId = typeof SnapshotDeltaTypeId

/** An immutable, opaque description of the exact difference between two snapshots. */
export interface SnapshotDelta {
  readonly [SnapshotDeltaTypeId]: SnapshotDeltaTypeId
}

const snapshotDeltas = new WeakMap<SnapshotDelta, object>()

/** @internal */
export const makeSnapshotDelta = (value: object): SnapshotDelta => {
  const delta = Object.freeze<SnapshotDelta>({ [SnapshotDeltaTypeId]: SnapshotDeltaTypeId })
  snapshotDeltas.set(delta, value)
  return delta
}

/** @internal */
export const snapshotDeltaValue = (delta: SnapshotDelta): object | undefined => snapshotDeltas.get(delta)

/** Schema for an already validated opaque snapshot delta. */
export const SnapshotDelta = Schema.declare<SnapshotDelta>((value): value is SnapshotDelta =>
  typeof value === "object" && value !== null && snapshotDeltas.has(value as SnapshotDelta)
)

/** Schema for filesystem entry kinds reported by snapshot inspection. */
export const SnapshotNodeKind = Schema.Literals(["directory", "file", "symlink"])
/** A filesystem entry kind reported by snapshot inspection. */
export type SnapshotNodeKind = typeof SnapshotNodeKind.Type

/** Schema for semantic fields that can differ between snapshots. */
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
/** A semantic field that differs between two snapshots. */
export type SnapshotDifference = typeof SnapshotDifference.Type

const SnapshotDifferences = Schema.Array(SnapshotDifference).check(Schema.isMinLength(1))

/**
 * Schema for a path-oriented difference between two snapshots.
 *
 * Independent snapshots do not preserve shared lineage, so moves are reported
 * as a removal and an addition rather than an inferred rename.
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
/** A path-oriented semantic difference between two snapshots. */
export type SnapshotChange = typeof SnapshotChange.Type

/** Schema for snapshot-delta inspection options. */
export const SnapshotChangesOptions = Schema.Struct({
  /** Include access, modification, change, and birth-time differences. Defaults to `false`. */
  includeTimestamps: Schema.optionalKey(Schema.Boolean)
})
/** Filtering options for snapshot-delta inspection. */
export type SnapshotChangesOptions = typeof SnapshotChangesOptions.Type

/** A valid snapshot delta was inspected or applied against a valid but semantically different base. */
export class SnapshotDeltaError extends Data.TaggedError("SnapshotDeltaError")<{
  readonly code: "BaseMismatch"
}> {}

const SnapshotDeltaLimitsSchema = Schema.Struct({
  maxEncodedBytes: Natural,
  maxIdentityBytes: Natural,
  maxDeltaRecords: Natural,
  maxDecodedDeltaBytes: Natural,
  maxBaseRecords: Natural,
  maxTargetRecords: Natural,
  maxEntries: Natural,
  maxOutputRecords: Natural,
  maxOutputBytes: Natural,
  maxInheritedRecords: Natural
})
/** Resource limits shared by delta creation, inspection, encoding, decoding, and application. */
export type SnapshotDeltaLimits = typeof SnapshotDeltaLimitsSchema.Type

/** Constructs and freezes a complete snapshot-delta resource policy. @internal */
export const makeSnapshotDeltaLimits = (limits: SnapshotDeltaLimits): SnapshotDeltaLimits =>
  Object.freeze({ ...limits })

const mebibyte = 1024 * 1024
const constrained = makeSnapshotDeltaLimits({
  maxEncodedBytes: 2 * mebibyte,
  maxIdentityBytes: 4 * mebibyte,
  maxDeltaRecords: 6_500,
  maxDecodedDeltaBytes: 512 * 1024,
  maxBaseRecords: 6_500,
  maxTargetRecords: 6_500,
  maxEntries: 6_500,
  maxOutputRecords: 6_500,
  maxOutputBytes: 256 * 1024,
  maxInheritedRecords: 6_500
})
const defaultLimits = makeSnapshotDeltaLimits({
  maxEncodedBytes: 16 * mebibyte,
  maxIdentityBytes: 32 * mebibyte,
  maxDeltaRecords: 50_000,
  maxDecodedDeltaBytes: 8 * mebibyte,
  maxBaseRecords: 50_000,
  maxTargetRecords: 50_000,
  maxEntries: 100_000,
  maxOutputRecords: 50_000,
  maxOutputBytes: 4 * mebibyte,
  maxInheritedRecords: 50_000
})

/**
 * Schema for a complete snapshot-delta resource policy, with frozen presets.
 *
 * The constrained preset is intended for memory-sensitive environments. The
 * default preset permits larger snapshots and payloads while remaining finite.
 */
export const SnapshotDeltaLimits = Object.assign(SnapshotDeltaLimitsSchema, {
  constrained,
  default: defaultLimits
})
