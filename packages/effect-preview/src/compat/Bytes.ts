// Generated from Effect PR #9960 by scripts/sync.mjs. Edit the snapshot or generator, then run sync.
export * from "effect/Bytes"
import * as Data from "effect/Data"
import { identity } from "effect/Function"
import * as Result from "effect/Result"

/**
 * Error returned when a byte view has an unsupported type or unusable backing storage.
 *
 * @see {@link byteLength} for validating a view and reading its length
 * @stability unstable
 * @category errors
 * @since 4.1.0
 */
export class ByteViewError extends Data.TaggedError("ByteViewError")<{
  readonly reason: "InvalidInput" | "SharedBuffer" | "DetachedBuffer" | "OutOfBounds"
}> {}

/**
 * Returns the actual byte length of an attached, non-shared `Uint8Array` view.
 *
 * **Details**
 *
 * Accepts same-realm Uint8Arrays, including empty arrays, subviews and Node
 * Buffers. Built-in getters ignore shadowed instance properties and custom
 * iterators. The input bytes are neither copied nor modified.
 *
 * **Gotchas**
 *
 * Shared or detached buffers and out-of-bounds resizable-buffer views fail.
 * A successful check does not prevent the buffer from being resized or
 * detached later; validate again when using a view after external code runs.
 *
 * **Example** (Measuring a view with a shadowed length)
 *
 * ```ts import.meta.vitest
 * import * as Bytes from "./Bytes.js"
import { Result } from "effect"
 *
 * const bytes = new Uint8Array([10, 20, 30, 40])
 * Object.defineProperty(bytes, "length", { value: 99 })
 *
 * Result.getOrThrow(Bytes.byteLength(bytes)) // => 4
 * Result.getOrThrow(Bytes.byteLength(bytes.subarray(1, 3))) // => 2
 * ```
 *
 * @see {@link ByteViewError} for invalid-view reasons
 * @stability unstable
 * @category getters
 * @since 4.1.0
 */
export const byteLength = (input: unknown): Result.Result<number, ByteViewError> => {
  let reason: ByteViewError["reason"] = "InvalidInput"
  return Result.flatMap(
    Result.try({
      try: () => {
        if (!(input instanceof Uint8Array)) return Result.fail(new ByteViewError({ reason }))
        const buffer = Reflect.get(Uint8Array.prototype, "buffer", input)
        reason = "SharedBuffer"
        Reflect.get(ArrayBuffer.prototype, "byteLength", buffer)
        reason = "DetachedBuffer"
        const attached = new Uint8Array(buffer, 0, 0)
        reason = "OutOfBounds"
        // A zero-byte set validates view bounds even when byteLength would report zero.
        Uint8Array.prototype.set.call(input, attached)
        const length: number = Reflect.get(Uint8Array.prototype, "byteLength", input)
        return Result.succeed(length)
      },
      catch: () => new ByteViewError({ reason })
    }),
    identity
  )
}
