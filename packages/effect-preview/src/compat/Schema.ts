// Generated from Effect PR #9960 by scripts/sync.mjs. Edit the snapshot or generator, then run sync.
export * from "effect/Schema"
import * as BytePath_ from "./BytePath.js"
import * as DateTime from "./DateTime.js"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Result_ from "effect/Result"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { declare, link, Uint8Array, decodeTo, BigInt, brand, Struct, Literals, TaggedStruct, instanceOf } from "effect/Schema"
const bytePathFromBytes = SchemaTransformation.transformEffect({
  decode: (input: globalThis.Uint8Array, options) => {
    const result = BytePath_.fromBytes(input)
    return Result_.isSuccess(result)
      ? Effect.succeed(result.success)
      : Effect.fail(
        new SchemaIssue.InvalidValue({ message: result.failure.message, cause: result.failure }, input, options)
      )
  },
  encode: (value: BytePath_.BytePath) => Effect.succeed(BytePath_.toBytes(value))
})

/**
 * Type-level representation of {@link BytePath}.
 *
 * @stability unstable
 * @category models
 * @since 4.1.0
 */
export interface BytePath extends declare<BytePath_.BytePath> {
  readonly "Rebuild": BytePath
}

/**
 * Schema for genuine immutable POSIX byte-path values. Its derived JSON codec
 * uses Base64 and preserves arbitrary bytes, including invalid UTF-8.
 *
 * @see {@link BytePathFromBytes} for constructing paths from byte arrays
 * @stability unstable
 * @category schemas
 * @since 4.1.0
 */
export const BytePath: BytePath = declare(BytePath_.isBytePath, {
  identifier: "BytePath",
  representation: {
    id: "effect/schema/BytePath",
    payload: null
  },
  toCode: () => ({
    runtime: `bytePathSchema`,
    Type: `BytePathType.BytePath`,
    importDeclarations: [`import { BytePath as bytePathSchema } from "@effect-vfs/effect-preview/Schema"`, `import type * as BytePathType from "@effect-vfs/effect-preview/BytePath"`]
  }),
  toCodecJson: () => link<BytePath_.BytePath>()(Uint8Array, bytePathFromBytes),
  toEquivalence: () => Equal.equals
})

/**
 * Type-level representation of {@link BytePathFromBytes}.
 *
 * @stability unstable
 * @category models
 * @since 4.1.0
 */
export interface BytePathFromBytes extends decodeTo<BytePath, Uint8Array> {
  readonly "Rebuild": BytePathFromBytes
}

/**
 * Schema for byte paths encoded as Uint8Arrays, with copying on decode and
 * encode. Accepts same-realm arrays and rejects NUL, shared buffers, detached
 * buffers and out-of-bounds views. Its derived JSON codec uses Base64.
 *
 * @see {@link BytePath} for validating already-constructed values
 * @stability unstable
 * @category schemas
 * @since 4.1.0
 */
export const BytePathFromBytes: BytePathFromBytes = Uint8Array.pipe(
  decodeTo(BytePath, bytePathFromBytes)
).annotate({ identifier: "BytePathFromBytes" })

/**
 * Schema for exact signed Unix epoch nanoseconds with the `DateTime.UnixNano` brand.
 *
 * **Details**
 *
 * Accepts every `bigint` without a date-range restriction. Strings and numbers
 * fail decoding with `SchemaError`.
 *
 * **Example** (Decoding exact nanoseconds)
 *
 * ```ts import.meta.vitest
 * import { Result, Schema } from "effect"
 *
 * Result.getOrThrow(Schema.decodeUnknownResult(Schema.UnixNano)(123n)) // => 123n
 * ```
 *
 * @stability experimental
 * @category schemas
 * @since 4.0.7
 */
export const UnixNano = BigInt.pipe(brand("UnixNano"))

/**
 * Schema for a Unix nanosecond conversion failure's reason, direction, and unit.
 *
 * @stability experimental
 * @category schemas
 * @since 4.0.7
 */
export const UnixNanoConversionReason = Struct({
  reason: Literals(["InvalidInput", "OutOfRange", "PrecisionLoss"]),
  direction: Literals(["toUnixNano", "fromUnixNano"]),
  unit: Literals(["nanoseconds", "seconds", "milliseconds", "Date", "DateTime"])
})

/**
 * Type-level representation of {@link UnixNanoConversionError}.
 *
 * @stability experimental
 * @category models
 * @since 4.0.7
 */
export interface UnixNanoConversionError extends
  decodeTo<
    instanceOf<DateTime.UnixNanoConversionError>,
    TaggedStruct<"ConversionError", typeof UnixNanoConversionReason.fields>
  >
{
  readonly "Rebuild": UnixNanoConversionError
}

/**
 * Schema that decodes tagged fields into a `DateTime.UnixNanoConversionError`.
 *
 * **Details**
 *
 * Encoding returns the error's tag, reason, direction, and unit. Input objects
 * and stack traces are not included.
 *
 * @stability experimental
 * @category schemas
 * @since 4.0.7
 */
export const UnixNanoConversionError: UnixNanoConversionError = TaggedStruct(
  "ConversionError",
  UnixNanoConversionReason.fields
).pipe(
  decodeTo(
    instanceOf(DateTime.UnixNanoConversionError),
    SchemaTransformation.transform({
      decode: (fields) => new DateTime.UnixNanoConversionError(fields),
      encode: (error) => ({ _tag: error._tag, reason: error.reason, direction: error.direction, unit: error.unit })
    })
  )
)

