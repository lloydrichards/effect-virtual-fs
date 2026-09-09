/**
 * Opaque virtual filesystem snapshots and their decoding limits.
 *
 * Snapshots contain a volume's reachable namespace and metadata, but exclude
 * callers, open handles, watch subscriptions, and unlinked content. Use the
 * encoding, decoding, and restoration functions in `VirtualFileSystem`.
 *
 * @since 0.1.0
 */
import * as Data from "effect/Data"
import * as Schema from "effect/Schema"

const Natural = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/**
 * Type identifier for opaque filesystem snapshots.
 *
 * @category type ids
 * @since 0.1.0
 */
export const SnapshotTypeId = Symbol("@effect-vfs/core/Snapshot")

/**
 * Type identifier for opaque filesystem snapshots.
 *
 * @category type ids
 * @since 0.1.0
 */
export type SnapshotTypeId = typeof SnapshotTypeId

/**
 * An immutable, opaque capture of a virtual filesystem volume.
 *
 * @category models
 * @since 0.1.0
 */
export interface Snapshot {
  readonly [SnapshotTypeId]: SnapshotTypeId
}

/**
 * Describes a snapshot encoding, decoding, structure, or resource-limit failure.
 *
 * @category errors
 * @since 0.1.0
 */
export class ImageError extends Data.TaggedError("ImageError")<{
  /** Machine-readable encoding, version, structure, or limit failure. */
  readonly code: "InvalidEncoding" | "UnsupportedVersion" | "InvalidStructure" | "LimitExceeded"
  /** Input area or configured limit associated with the failure, when available. */
  readonly field?: string
}> {}

/**
 * Schema for the mandatory resource limits applied while decoding a snapshot.
 *
 * @category schemas
 * @since 0.1.0
 */
export const DecodeLimits = Schema.Struct({
  /** Maximum accepted encoded input length in bytes. */
  maxEncodedBytes: Natural,
  /** Maximum number of stored metadata and content records. */
  maxRecords: Natural,
  /** Maximum number of namespace entries. */
  maxEntries: Natural,
  /** Maximum combined decoded byte content. */
  maxDecodedBytes: Natural
})

/**
 * Resource limits applied while decoding a snapshot.
 *
 * @category models
 * @since 0.1.0
 */
export type DecodeLimits = typeof DecodeLimits.Type
