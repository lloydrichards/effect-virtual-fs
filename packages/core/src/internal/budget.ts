import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { DecodeLimits } from "../Snapshot.js"
import { SnapshotDeltaLimits } from "../SnapshotDelta.js"

const documentFields = {
  encodedBytes: Schema.ByteSize,
  records: Schema.Natural,
  entries: Schema.Natural,
  decodedBytes: Schema.ByteSize
}

/** @internal */
export const Budget = Schema.Struct({
  ...documentFields,
  lineBytes: Schema.ByteSize
})

/** @internal */
export type Budget = typeof Budget.Type

/** @internal */
export const DeltaBudget = Schema.Struct({
  ...documentFields,
  identityBytes: Schema.ByteSize,
  baseRecords: Schema.Natural,
  targetRecords: Schema.Natural,
  outputRecords: Schema.Natural,
  outputBytes: Schema.ByteSize,
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
      decodedBytes: limits.maxDecodedBytes,
      // The encoded input bounds any line when maxLineBytes is absent.
      lineBytes: limits.maxLineBytes ?? limits.maxEncodedBytes
    }),
    encode: (budget) => ({
      maxEncodedBytes: budget.encodedBytes,
      maxRecords: budget.records,
      maxEntries: budget.entries,
      maxDecodedBytes: budget.decodedBytes,
      maxLineBytes: budget.lineBytes
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
