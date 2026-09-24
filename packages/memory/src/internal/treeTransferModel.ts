/**
 * Schemas and presets shared by the public tree transfer module and its engine.
 *
 * @internal
 * @since 0.6.0
 */
import * as ByteSize from "effect/ByteSize"
import * as Schema from "effect/Schema"

/** @internal */
export const TreeTransferLimitsSchema = Schema.Struct({
  maxEntries: Schema.Natural,
  maxBytes: Schema.ByteSize,
  maxFileBytes: Schema.ByteSize,
  maxDepth: Schema.Natural,
  maxPathBytes: Schema.ByteSize
})

/** @internal */
export const makeLimits = (limits: typeof TreeTransferLimitsSchema.Type): typeof TreeTransferLimitsSchema.Type =>
  Object.freeze({ ...limits })

/** @internal */
export const defaultLimits = makeLimits({
  maxEntries: 100_000,
  maxBytes: ByteSize.gibibytes(1),
  maxFileBytes: ByteSize.mebibytes(256),
  maxDepth: 256,
  maxPathBytes: ByteSize.kibibytes(4)
})

/** @internal */
export const constrainedLimits = makeLimits({
  maxEntries: 10_000,
  maxBytes: ByteSize.mebibytes(64),
  maxFileBytes: ByteSize.mebibytes(8),
  maxDepth: 64,
  maxPathBytes: ByteSize.kibibytes(1)
})
