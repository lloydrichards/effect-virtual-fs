import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"

const MAX_TIMESTAMP = 10n ** 128n - 1n

/** @internal */
export const Timestamp = Schema.BigInt.check(
  Schema.isGreaterThanOrEqualToBigInt(-MAX_TIMESTAMP),
  Schema.isLessThanOrEqualToBigInt(MAX_TIMESTAMP)
)

/** @internal */
export const TimestampFromString = Schema.String
  .check(Schema.isPattern(/^-?[0-9]{1,128}$/))
  .pipe(Schema.decodeTo(Timestamp, SchemaTransformation.bigintFromString))

/** @internal */
export const StoredMetadata = Schema.Struct({
  uid: Schema.Natural,
  gid: Schema.Natural,
  mode: Schema.Natural.check(Schema.isLessThanOrEqualTo(0o7777)),
  atimeNs: TimestampFromString,
  mtimeNs: TimestampFromString,
  ctimeNs: TimestampFromString,
  birthtimeNs: TimestampFromString
})

/** @internal */
export type StoredMetadata = typeof StoredMetadata.Type
