// The one budget the snapshot and delta codecs enforce. `DecodeLimits` and `SnapshotDeltaLimits` stay the public
// spelling of it: each decodes into this budget, so the codecs read one set of names whichever the caller chose.
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { DecodeLimits } from "../Snapshot.js"
import { SnapshotDeltaLimits } from "../SnapshotDelta.js"

/** @internal */
export const Budget = Schema.Struct({
  // The encoded input, before it is parsed.
  encodedBytes: Schema.ByteSize,
  // The records a document holds: a snapshot's nodes, or a delta's changes.
  records: Schema.Natural,
  // The names a document writes into a namespace.
  entries: Schema.Natural,
  // The names, paths and payloads a document holds once decoded.
  decodedBytes: Schema.ByteSize
})

/** @internal */
export type Budget = typeof Budget.Type

// A delta's budget adds the work its operations do against the snapshots on either side of it.
/** @internal */
export const DeltaBudget = Schema.Struct({
  ...Budget.fields,
  // The bytes hashed for one snapshot's identity.
  identityBytes: Schema.ByteSize,
  // The nodes a base or a target snapshot holds.
  baseRecords: Schema.Natural,
  targetRecords: Schema.Natural,
  // The nodes and payload bytes an applied delta produces.
  outputRecords: Schema.Natural,
  outputBytes: Schema.ByteSize,
  // The nodes an applied delta carries over from its base unchanged.
  inheritedRecords: Schema.Natural
})

/** @internal */
export type DeltaBudget = typeof DeltaBudget.Type

/** @internal */
export const BudgetFromDecodeLimits = DecodeLimits.pipe(Schema.decodeTo(
  Budget,
  SchemaTransformation.transform({
    decode: (limits) => ({
      encodedBytes: limits.maxEncodedBytes,
      records: limits.maxRecords,
      entries: limits.maxEntries,
      decodedBytes: limits.maxDecodedBytes
    }),
    encode: (budget) => ({
      maxEncodedBytes: budget.encodedBytes,
      maxRecords: budget.records,
      maxEntries: budget.entries,
      maxDecodedBytes: budget.decodedBytes
    })
  })
))

/** @internal */
export const DeltaBudgetFromLimits = SnapshotDeltaLimits.pipe(Schema.decodeTo(
  DeltaBudget,
  SchemaTransformation.transform({
    decode: (limits) => ({
      encodedBytes: limits.maxEncodedBytes,
      records: limits.maxDeltaRecords,
      entries: limits.maxEntries,
      decodedBytes: limits.maxDecodedDeltaBytes,
      identityBytes: limits.maxIdentityBytes,
      baseRecords: limits.maxBaseRecords,
      targetRecords: limits.maxTargetRecords,
      outputRecords: limits.maxOutputRecords,
      outputBytes: limits.maxOutputBytes,
      inheritedRecords: limits.maxInheritedRecords
    }),
    encode: (budget) => ({
      maxEncodedBytes: budget.encodedBytes,
      maxIdentityBytes: budget.identityBytes,
      maxDeltaRecords: budget.records,
      maxDecodedDeltaBytes: budget.decodedBytes,
      maxBaseRecords: budget.baseRecords,
      maxTargetRecords: budget.targetRecords,
      maxEntries: budget.entries,
      maxOutputRecords: budget.outputRecords,
      maxOutputBytes: budget.outputBytes,
      maxInheritedRecords: budget.inheritedRecords
    })
  })
))
