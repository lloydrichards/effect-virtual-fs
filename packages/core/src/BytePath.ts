/**
 * Opaque, byte-preserving filesystem paths.
 *
 * A `BytePath` stores the exact bytes of a path component so that names which
 * are not valid UTF-8 survive a round trip through the virtual filesystem.
 *
 * @since 0.1.0
 */
import type * as Equal from "effect/Equal"
import type { Pipeable } from "effect/Pipeable"
import * as Schema from "effect/Schema"
import * as Internal from "./internal/bytePath.js"

/**
 * Type identifier for opaque byte-preserving filesystem paths.
 *
 * @category type IDs
 * @since 0.1.0
 */
export const BytePathId: "@effect-vfs/core/BytePath" = Internal.BytePathId

/**
 * Type identifier for opaque byte-preserving filesystem paths.
 *
 * @category type IDs
 * @since 0.1.0
 */
export type BytePathId = typeof BytePathId

/**
 * An opaque path that preserves arbitrary non-NUL bytes without UTF-8 conversion.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * // A name that is not valid UTF-8 still round-trips exactly.
 * const program = Effect.gen(function*() {
 *   const caller = yield* (yield* Vfs.make()).caller()
 *   const path = yield* Vfs.pathFromBytes(new Uint8Array([47, 0xff, 0xfe]))
 *
 *   yield* caller.writeFile(path, new Uint8Array([1]), {
 *     access: "write",
 *     create: "exclusive"
 *   })
 *
 *   // `readDirectory` fails `UnrepresentableName` here; the byte variant keeps it.
 *   return yield* caller.readDirectoryBytes("/")
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // [ Uint8Array(2) [ 255, 254 ] ]
 * ```
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
