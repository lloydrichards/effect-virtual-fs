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
  birthtimeNs: Timestamp,
  /** The object's revision, advanced by every committed change to it. */
  revision: Schema.BigInt
})

/**
 * Metadata of a filesystem object, including its revision.
 *
 * @category models
 * @since 0.6.0
 */
export type Metadata = typeof Metadata.Type

/**
 * Mask of the file-type bits in a POSIX `st_mode`.
 *
 * @category constants
 * @since 0.6.0
 */
export const S_IFMT = 0o170000

/**
 * File-type bits of a regular file in a POSIX `st_mode`.
 *
 * @category constants
 * @since 0.6.0
 */
export const S_IFREG = 0o100000

/**
 * File-type bits of a directory in a POSIX `st_mode`.
 *
 * @category constants
 * @since 0.6.0
 */
export const S_IFDIR = 0o040000

/**
 * File-type bits of a symbolic link in a POSIX `st_mode`.
 *
 * @category constants
 * @since 0.6.0
 */
export const S_IFLNK = 0o120000

const FILE_TYPE_BITS = { directory: S_IFDIR, file: S_IFREG, symlink: S_IFLNK } as const

/**
 * The POSIX `st_mode` of an object: the file-type bits of its `kind` joined
 * with its permission `mode`. `mode` itself never carries type bits, so the
 * kind has a single source.
 *
 * A volume has no device nodes, so a `stat` built from metadata reports `dev`
 * and `rdev` as 0, and `(dev, ino)` identifies an object only within one volume.
 *
 * @example
 * ```ts
 * import { S_IFDIR, S_IFMT, typedMode } from "@effect-vfs/core/Metadata"
 *
 * const stMode = typedMode({ kind: "directory", mode: 0o755 })
 *
 * console.log(stMode.toString(8)) // "40755"
 * console.log((stMode & S_IFMT) === S_IFDIR) // true
 * ```
 *
 * @category getters
 * @since 0.6.0
 */
export const typedMode = (metadata: Pick<Metadata, "kind" | "mode">): number =>
  FILE_TYPE_BITS[metadata.kind] | metadata.mode

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
