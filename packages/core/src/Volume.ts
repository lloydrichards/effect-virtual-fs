/**
 * Volume identity brands and schemas: durability, identity tokens, reference
 * keys, construction options, and the change summaries an overlay volume
 * reports.
 *
 * @since 0.6.0
 */
import * as ByteSize from "effect/ByteSize"
import * as Order from "effect/Order"
import * as Schema from "effect/Schema"
import { BytePath } from "./BytePath.js"
import { Hex128 } from "./internal/hex128.js"
import { MAX_FILE_BYTES } from "./internal/limits.js"
import { MAX_INO, ROOT_INO } from "./internal/volumeState.js"

/**
 * Brand key that marks a volume.
 *
 * @category type IDs
 * @since 0.6.0
 */
export const VolumeId: unique symbol = Symbol.for("@effect-vfs/core/Volume")

/**
 * Brand key that marks a volume.
 *
 * @category type IDs
 * @since 0.6.0
 */
export type VolumeId = typeof VolumeId

/**
 * Schema for the failure boundary a volume's committed mutations survive.
 *
 * @category schemas
 * @since 0.6.0
 */
export const VolumeDurability = Schema.Literals([
  "memory-only",
  "survives-process-crash",
  "survives-operating-system-crash",
  "survives-power-loss"
])

/**
 * The failure boundary a volume's committed mutations survive.
 *
 * @category models
 * @since 0.6.0
 */
export type VolumeDurability = typeof VolumeDurability.Type

const durabilityRank: Readonly<Record<VolumeDurability, number>> = {
  "memory-only": 0,
  "survives-process-crash": 1,
  "survives-operating-system-crash": 2,
  "survives-power-loss": 3
}

/**
 * Weakest-to-strongest ordering for volume durability guarantees.
 *
 * @category ordering
 * @since 0.6.0
 */
export const VolumeDurabilityOrder: Order.Order<VolumeDurability> = Order.mapInput(
  Order.Number,
  (durability: VolumeDurability) => durabilityRank[durability]
)

/**
 * Returns whether `actual` survives at least the failure boundary required by `required`.
 *
 * @category predicates
 * @since 0.6.0
 */
export const isVolumeDurabilityAtLeast = (actual: VolumeDurability, required: VolumeDurability): boolean =>
  VolumeDurabilityOrder(actual, required) >= 0

/**
 * Schema for a volume identity: 128 bits as lowercase hexadecimal, stable
 * across restarts of a durable volume.
 *
 * @category schemas
 * @since 0.6.0
 */
export const VolumeIdentity = Hex128.pipe(Schema.brand("@effect-vfs/core/VolumeIdentity"))

/**
 * A volume identity.
 *
 * @category models
 * @since 0.6.0
 */
export type VolumeIdentity = typeof VolumeIdentity.Type

/**
 * Schema for a volume incarnation: 128 bits as lowercase hexadecimal, minted
 * on every construction.
 *
 * @category schemas
 * @since 0.6.0
 */
export const VolumeIncarnation = Hex128.pipe(Schema.brand("@effect-vfs/core/VolumeIncarnation"))

/**
 * A volume incarnation.
 *
 * @category models
 * @since 0.6.0
 */
export type VolumeIncarnation = typeof VolumeIncarnation.Type

// 128 bits as bytes, carried as base64 like every other byte field on a wire.
const KeyBytes = Schema.Uint8ArrayFromBase64.check(
  Schema.makeFilter((bytes) => bytes.length === 16 ? undefined : "must hold exactly 16 bytes")
)

/**
 * Schema for a reference key: the serialisable name of one object in one
 * volume, for adapters that must name an object outside the process, such as
 * an NFS filehandle.
 *
 * **Details**
 *
 * `identity` is the volume's identity and `epoch` the inode-number namespace
 * the object was numbered in, both as 16 bytes encoded as base64; `ino` is
 * the object's inode number, encoded as a decimal string; `tag` is 16 bytes of
 * HMAC-SHA-256 over the identity, epoch and inode number under a secret only
 * the volume holds, encoded as base64. Inode numbers are small and sequential,
 * so the tag is what keeps a holder of one key from naming a neighbouring
 * object: a key with another inode number or an altered tag fails
 * `InvalidReference`. A volume mints a new epoch and secret whenever its inode
 * numbers start over: a new volume, a snapshot or fixture restore, and an
 * overlay. A live volume keeps both across a reopen, so its keys outlive the
 * process. Turning a key into bytes of a fixed layout stays the adapter's job.
 *
 * @category schemas
 * @since 0.6.0
 */
export const ReferenceKey = Schema.Struct({
  identity: KeyBytes,
  epoch: KeyBytes,
  ino: Schema.BigIntFromString.check(Schema.isBetweenBigInt({ minimum: BigInt(ROOT_INO), maximum: BigInt(MAX_INO) })),
  tag: KeyBytes
})

/**
 * The serialisable name of one object in one volume.
 *
 * @category models
 * @since 0.6.0
 */
export type ReferenceKey = typeof ReferenceKey.Type

/**
 * Schema for volume construction options.
 *
 * @category schemas
 * @since 0.6.0
 */
export const VolumeOptions = Schema.Struct({
  identity: Schema.optionalKey(VolumeIdentity),
  maxEntries: Schema.optionalKey(Schema.Natural),
  maxPendingOperations: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  maxWatchEvents: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(2))),
  maxBytes: Schema.optionalKey(Schema.ByteSize),
  maxFileBytes: Schema.optionalKey(
    Schema.ByteSize.check(
      Schema.makeFilter((size) =>
        ByteSize.isLessThanOrEqualTo(size, ByteSize.bytes(MAX_FILE_BYTES))
          ? undefined
          : `must be at most ${MAX_FILE_BYTES} bytes`
      )
    )
  ),
  maxPathBytes: Schema.optionalKey(
    Schema.ByteSize.check(
      Schema.makeFilter((size) =>
        ByteSize.isGreaterThanOrEqualTo(size, ByteSize.bytes(1)) ? undefined : "must be at least 1 byte"
      )
    )
  )
})

/**
 * Volume construction options.
 *
 * @category models
 * @since 0.6.0
 */
export type VolumeOptions = typeof VolumeOptions.Type

/**
 * Schema for the kinds of filesystem entry an overlay summary reports.
 *
 * @category schemas
 * @since 0.6.0
 */
export const OverlayNodeKind = Schema.Literals(["directory", "file", "symlink"])

/**
 * A kind of filesystem entry in an overlay summary.
 *
 * @category models
 * @since 0.6.0
 */
export type OverlayNodeKind = typeof OverlayNodeKind.Type

/**
 * Schema for one way an overlay entry differs from its base.
 *
 * @category schemas
 * @since 0.6.0
 */
export const OverlayDifference = Schema.Literals([
  "content",
  "mode",
  "uid",
  "gid",
  "atimeNs",
  "mtimeNs",
  "ctimeNs",
  "birthtimeNs"
])

/**
 * One way an overlay entry differs from its base.
 *
 * @category models
 * @since 0.6.0
 */
export type OverlayDifference = typeof OverlayDifference.Type

const OverlayDifferences = Schema.Array(OverlayDifference)

const NonEmptyOverlayDifferences = OverlayDifferences.check(Schema.isMinLength(1))

/**
 * Schema for one summarised change between an overlay and its base.
 *
 * @category schemas
 * @since 0.6.0
 */
export const OverlayChange = Schema.Union([
  Schema.TaggedStruct("Added", { path: BytePath, kind: OverlayNodeKind }),
  Schema.TaggedStruct("Removed", { path: BytePath, kind: OverlayNodeKind }),
  Schema.TaggedStruct("Replaced", {
    path: BytePath,
    beforeKind: OverlayNodeKind,
    afterKind: OverlayNodeKind,
    differences: OverlayDifferences
  }),
  Schema.TaggedStruct("Renamed", {
    from: BytePath,
    to: BytePath,
    kind: OverlayNodeKind,
    differences: OverlayDifferences
  }),
  Schema.TaggedStruct("Updated", { path: BytePath, kind: OverlayNodeKind, differences: NonEmptyOverlayDifferences })
])

/**
 * One summarised change between an overlay and its base.
 *
 * @category models
 * @since 0.6.0
 */
export type OverlayChange = typeof OverlayChange.Type

/**
 * Schema for the options of an overlay change summary.
 *
 * @category schemas
 * @since 0.6.0
 */
export const OverlayChangesOptions = Schema.Struct({
  includeTimestamps: Schema.optionalKey(Schema.Boolean)
})

/**
 * Options of an overlay change summary.
 *
 * @category models
 * @since 0.6.0
 */
export type OverlayChangesOptions = typeof OverlayChangesOptions.Type
