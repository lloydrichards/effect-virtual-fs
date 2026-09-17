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

/**
 * Type identifier for opaque filesystem snapshots.
 *
 * @category type IDs
 * @since 0.1.0
 */
export const SnapshotTypeId = "@effect-vfs/core/Snapshot" as const

/**
 * Type identifier for opaque filesystem snapshots.
 *
 * @category type IDs
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
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import { ByteSize, Effect } from "effect"
 *
 * // Decoding is a trust boundary. `code` says what went wrong and `field` says
 * // which input or limit it was, so a caller can decline just the bad payload.
 * const program = Effect.gen(function*() {
 *   const volume = yield* Vfs.make()
 *   const bytes = yield* Vfs.encodeSnapshot(yield* volume.snapshot)
 *
 *   return yield* Vfs.decodeSnapshot(bytes, {
 *     maxEncodedBytes: ByteSize.bytes(16),
 *     maxRecords: 10_000,
 *     maxEntries: 10_000,
 *     maxDecodedBytes: ByteSize.megabytes(16)
 *   }).pipe(
 *     Effect.as("accepted"),
 *     Effect.catchTag("ImageError", (error) =>
 *       error.code === "LimitExceeded"
 *         ? Effect.succeed(`declined at ${error.field}`)
 *         : Effect.fail(error))
 *   )
 * })
 *
 * Effect.runPromise(program).then(console.log)
 * // declined at encodedBytes
 * ```
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
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import { ByteSize, Effect, Schema } from "effect"
 *
 * // Each limit bounds a separate resource, so all four are required.
 * const limits: Vfs.DecodeLimits = {
 *   maxEncodedBytes: ByteSize.megabytes(4),
 *   maxRecords: 10_000,
 *   maxEntries: 10_000,
 *   maxDecodedBytes: ByteSize.megabytes(16)
 * }
 *
 * const program = Effect.gen(function*() {
 *   const checked = yield* Schema.decodeEffect(Vfs.DecodeLimits)(limits)
 *   const bytes = yield* Vfs.encodeSnapshot(yield* (yield* Vfs.make()).snapshot)
 *
 *   return yield* Vfs.decodeSnapshot(bytes, checked)
 * })
 * ```
 *
 * @category schemas
 * @since 0.1.0
 */
export const DecodeLimits = Schema.Struct({
  /** Maximum accepted encoded input length in bytes. */
  maxEncodedBytes: Schema.ByteSize,
  /** Maximum number of stored metadata and content records. */
  maxRecords: Schema.Natural,
  /** Maximum number of namespace entries. */
  maxEntries: Schema.Natural,
  /** Maximum combined decoded byte content. */
  maxDecodedBytes: Schema.ByteSize
})

/**
 * Resource limits applied while decoding a snapshot.
 *
 * @category models
 * @since 0.1.0
 */
export type DecodeLimits = typeof DecodeLimits.Type
