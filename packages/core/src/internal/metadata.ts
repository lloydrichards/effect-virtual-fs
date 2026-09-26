import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { Timestamp } from "../Metadata.js"
import { ENCODING_CHECK } from "./errors.js"

/** @internal */
export { Timestamp }

const TimestampFromString = Schema.String
  .check(Schema.isPattern(/^-?[0-9]{1,128}$/, { [ENCODING_CHECK]: true }))
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
