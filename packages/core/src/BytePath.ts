import * as Schema from "effect/Schema"

export const BytePathId = Symbol("@effect-vfs/core/BytePath")

const bytePaths = new WeakMap<BytePath, Uint8Array>()

/**
 * An opaque path that preserves arbitrary non-NUL bytes without UTF-8 conversion.
 *
 * @category models
 * @since 0.1.0
 */
export interface BytePath {
  readonly [BytePathId]: true
}

/**
 * Schema for an opaque byte-preserving filesystem path.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BytePath = Schema.declare<BytePath>((value): value is BytePath =>
  typeof value === "object" && value !== null && bytePaths.has(value as BytePath)
)

export const make = (bytes: Uint8Array): BytePath => {
  const path: BytePath = Object.freeze({ [BytePathId]: true as const })
  bytePaths.set(path, bytes)
  return path
}

export const getBytes = (path: BytePath): Uint8Array | undefined => bytePaths.get(path)
