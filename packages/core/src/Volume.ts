/**
 * Volume identity brands and schemas: durability, identity tokens, construction
 * options, and the change summaries an overlay volume reports.
 *
 * @since 0.6.0
 */
import * as ByteSize from "effect/ByteSize"
import * as Order from "effect/Order"
import * as Schema from "effect/Schema"
import { BytePath } from "./BytePath.js"
import { MAX_FILE_BYTES } from "./internal/limits.js"

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

const Hex128 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/))

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
