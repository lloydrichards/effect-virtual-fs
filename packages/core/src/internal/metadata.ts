import * as Schema from "effect/Schema"

const MAX_TIMESTAMP = 10n ** 128n - 1n

/** @internal */
export const Timestamp = Schema.BigInt.check(
  Schema.isGreaterThanOrEqualToBigInt(-MAX_TIMESTAMP),
  Schema.isLessThanOrEqualToBigInt(MAX_TIMESTAMP)
)

/** @internal */
export const TimestampFromString = Schema.BigIntFromString.check(
  Schema.isGreaterThanOrEqualToBigInt(-MAX_TIMESTAMP),
  Schema.isLessThanOrEqualToBigInt(MAX_TIMESTAMP)
)

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
