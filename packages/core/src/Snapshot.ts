/**
 * Opaque virtual filesystem snapshots and their decoding limits.
 *
 * A snapshot is the immutable value of a volume at one committed state, so
 * capturing one copies nothing. It holds the reachable namespace and metadata,
 * but excludes callers, open handles, watch subscriptions, and unlinked
 * content. Use the encoding, decoding, and restoration functions in
 * `VirtualFileSystem`.
 *
 * @since 0.1.0
 */
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
 * Schema for the mandatory resource limits applied while decoding a snapshot.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import { ByteSize, Effect } from "effect"
 *
 * // All four are required: each bounds a different resource. `maxEncodedBytes`
 * // caps the wire payload before parsing; `maxDecodedBytes` caps memory after it.
 * const limits: Vfs.DecodeLimits = {
 *   maxEncodedBytes: ByteSize.megabytes(4),
 *   maxRecords: 10_000,
 *   maxEntries: 10_000,
 *   maxDecodedBytes: ByteSize.megabytes(16)
 * }
 *
 * const program = Effect.gen(function*() {
 *   const volume = yield* Vfs.make()
 *   const bytes = yield* Vfs.encodeSnapshot(yield* volume.snapshot)
 *
 *   yield* Vfs.decodeSnapshot(bytes, limits)
 *
 *   return "accepted"
 * })
 *
 * Effect.runPromise(program).then(console.log)
 * // accepted
 * ```
 *
 * @category schemas
 * @since 0.1.0
 */
export const DecodeLimits = Schema.Struct({
  /** Maximum accepted encoded input length in bytes. */
  maxEncodedBytes: Schema.ByteSize,
  /** Maximum number of stored objects, one node each, the root included. */
  maxRecords: Schema.Natural,
  /** Maximum number of namespace entries, counting every name of a hard-linked file. */
  maxEntries: Schema.Natural,
  /** Maximum combined decoded bytes of names, file contents and symbolic-link targets. */
  maxDecodedBytes: Schema.ByteSize
})

/**
 * Resource limits applied while decoding a snapshot.
 *
 * @category models
 * @since 0.1.0
 */
export type DecodeLimits = typeof DecodeLimits.Type
