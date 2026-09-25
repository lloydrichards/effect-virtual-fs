/**
 * Metadata schemas for virtual filesystem objects: timestamps, permission modes,
 * the metadata record every observation returns, and the owner and time updates
 * that mutations accept.
 *
 * @since 0.6.0
 */
import * as Schema from "effect/Schema"

const MAX_TIMESTAMP = 10n ** 128n - 1n

/**
 * Schema for a timestamp in nanoseconds since the Unix epoch. Values stay
 * within 128 decimal digits so they round-trip through snapshot encodings.
 *
 * @category schemas
 * @since 0.6.0
 */
export const Timestamp = Schema.BigInt.check(
  Schema.isGreaterThanOrEqualToBigInt(-MAX_TIMESTAMP),
  Schema.isLessThanOrEqualToBigInt(MAX_TIMESTAMP)
)

/**
 * A timestamp in nanoseconds since the Unix epoch.
 *
 * @category models
 * @since 0.6.0
 */
export type Timestamp = typeof Timestamp.Type

/**
 * Schema for a POSIX permission mode: the permission, setuid, setgid and sticky
 * bits without any file-type bits.
 *
 * @category schemas
 * @since 0.6.0
 */
export const Mode = Schema.Natural.check(Schema.isLessThanOrEqualTo(0o7777))

/**
 * A POSIX permission mode.
 *
 * @category models
 * @since 0.6.0
 */
export type Mode = typeof Mode.Type

/**
 * Schema for the metadata of a filesystem object.
 *
 * @category schemas
 * @since 0.6.0
 */
export const Metadata = Schema.Struct({
  kind: Schema.Literals(["directory", "file", "symlink"]),
  ino: Schema.BigInt,
  nlink: Schema.Natural,
  size: Schema.BigInt,
  uid: Schema.Natural,
  gid: Schema.Natural,
  mode: Mode,
  atimeNs: Timestamp,
  mtimeNs: Timestamp,
  ctimeNs: Timestamp,
  birthtimeNs: Timestamp
})

/**
 * Metadata of a filesystem object.
 *
 * @category models
 * @since 0.6.0
 */
export type Metadata = typeof Metadata.Type

/**
 * Schema for an ownership update; an omitted field keeps its current value.
 *
 * @category schemas
 * @since 0.6.0
 */
export const OwnerUpdate = Schema.Struct({
  uid: Schema.optionalKey(Schema.Natural),
  gid: Schema.optionalKey(Schema.Natural)
})

/**
 * An ownership update.
 *
 * @category models
 * @since 0.6.0
 */
export type OwnerUpdate = typeof OwnerUpdate.Type

/**
 * Schema for one timestamp update: the current time, no change, or an explicit value.
 *
 * @category schemas
 * @since 0.6.0
 */
export const TimeUpdate = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("now") }),
  Schema.Struct({ kind: Schema.Literal("omit") }),
  Schema.Struct({ kind: Schema.Literal("value"), nanoseconds: Timestamp })
])

/**
 * One timestamp update.
 *
 * @category models
 * @since 0.6.0
 */
export type TimeUpdate = typeof TimeUpdate.Type

/**
 * Schema for the access and modification time updates a mutation applies together.
 *
 * @category schemas
 * @since 0.6.0
 */
export const Times = Schema.Struct({ access: TimeUpdate, modification: TimeUpdate })

/**
 * Access and modification time updates.
 *
 * @category models
 * @since 0.6.0
 */
export type Times = typeof Times.Type
