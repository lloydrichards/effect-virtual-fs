import type * as Equal from "effect/Equal"
import type { Pipeable } from "effect/Pipeable"
import * as Schema from "effect/Schema"
import * as Internal from "./internal/bytePath.js"

/**
 * Type identifier for opaque byte-preserving filesystem paths.
 *
 * @category type ids
 * @since 0.1.0
 */
export const BytePathId: "@effect-vfs/core/BytePath" = Internal.BytePathId

/**
 * Type identifier for opaque byte-preserving filesystem paths.
 *
 * @category type ids
 * @since 0.1.0
 */
export type BytePathId = typeof BytePathId

/**
 * An opaque path that preserves arbitrary non-NUL bytes without UTF-8 conversion.
 *
 * @category models
 * @since 0.1.0
 */
export interface BytePath extends Equal.Equal, Pipeable {
  readonly [BytePathId]: BytePathId
}

/**
 * Schema for an opaque byte-preserving filesystem path.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BytePath = Schema.declare<BytePath>(Internal.isBytePath)
