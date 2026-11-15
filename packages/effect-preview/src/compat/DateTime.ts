// Generated from Effect PR #9960 by scripts/sync.mjs. Edit the snapshot or generator, then run sync.
export * from "effect/DateTime"
import * as Internal from "effect/DateTime"
import type { DateTime, Utc } from "effect/DateTime"
import type * as Brand from "effect/Brand"
import * as Data from "effect/Data"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"

/**
 * Exact signed nanoseconds since the Unix/POSIX epoch.
 *
 * **Details**
 *
 * Accepts every `bigint`, including values outside the range of `DateTime`.
 * This type is separate from the millisecond-based `Utc` and `Zoned` types.
 * Use `Schema.UnixNano` to validate unknown input.
 *
 * @see {@link unixNanoFromNanoseconds} for constructing exact instants
 * @see {@link unixNanoToDateTime} for conversion to millisecond-based UTC values
 * @stability experimental
 * @category models
 * @since 4.0.7
 */
export type UnixNano = Brand.Branded<bigint, "UnixNano">

/**
 * Tagged error returned when a Unix nanosecond conversion fails.
 *
 * **Details**
 *
 * Checked conversions return this error in `Result`. Input validation comes
 * before range and precision checks. Unexpected exceptions propagate.
 * The error retains only the reason, direction, and unit.
 * Use `Schema.UnixNanoConversionError` to decode or encode these errors.
 *
 * @stability experimental
 * @category errors
 * @since 4.0.7
 */
export class UnixNanoConversionError extends Data.TaggedError("ConversionError")<UnixNano.ConversionReason> {}

/**
 * Brands exact `bigint` nanoseconds without scaling or range checks.
 *
 * **Gotchas**
 *
 * Throws `TypeError` if an untyped caller supplies a non-bigint value.
 *
 * @stability experimental
 * @category constructors
 * @since 4.0.7
 */
export const unixNanoFromNanoseconds = (value: bigint): UnixNano => {
  if (typeof value !== "bigint") throw new TypeError("Expected bigint nanoseconds")
  return value as UnixNano
}

/**
 * Returns the exact signed `bigint` nanoseconds.
 *
 * @stability experimental
 * @category destructors
 * @since 4.0.7
 */
export const unixNanoToNanoseconds = (value: UnixNano): bigint => value

/**
 * Converts seconds to exact epoch nanoseconds by default.
 *
 * **Details**
 *
 * Multiplies `bigint` input by `1000000000n`. Interprets finite number input using
 * its canonical decimal spelling, including exponent notation, with integer
 * scaling. Rejects `NaN` and infinities. Negative values denote pre-epoch
 * instants, and negative zero becomes zero. No string coercion occurs.
 *
 * **Gotchas**
 *
 * Exact conversion rejects subnanosecond remainders. Explicit `"truncate"`
 * precision discards them toward zero. Digits already lost in a JavaScript
 * number cannot be recovered.
 *
 * @stability experimental
 * @category converting
 * @since 4.0.7
 */
export const unixNanoFromSeconds = (
  value: bigint | number,
  options?: UnixNano.ConversionOptions
): Result.Result<UnixNano, UnixNanoConversionError> => fromScaled(value, 9, "seconds", options)

/**
 * Converts milliseconds to exact epoch nanoseconds by default.
 *
 * **Details**
 *
 * Multiplies `bigint` input by `1000000n`. Interprets finite number input using
 * its canonical decimal spelling, including exponent notation, with integer
 * scaling. Rejects `NaN` and infinities. Negative values denote pre-epoch
 * instants, and negative zero becomes zero. No string coercion occurs.
 *
 * **Gotchas**
 *
 * Exact conversion rejects subnanosecond remainders. Explicit `"truncate"`
 * precision discards them toward zero. Digits already lost in a JavaScript
 * number cannot be recovered.
 *
 * @stability experimental
 * @category converting
 * @since 4.0.7
 */
export const unixNanoFromMilliseconds = (
  value: bigint | number,
  options?: UnixNano.ConversionOptions
): Result.Result<UnixNano, UnixNanoConversionError> => fromScaled(value, 6, "milliseconds", options)

/**
 * Snapshots a valid `Date` once and converts its integer epoch milliseconds.
 *
 * **Gotchas**
 *
 * An invalid `Date` returns `InvalidInput`. Subsequent `Date` mutations cannot
 * change the returned value.
 *
 * @stability experimental
 * @category converting
 * @since 4.0.7
 */
export const unixNanoFromDate = (value: Date): Result.Result<UnixNano, UnixNanoConversionError> => {
  if (!Predicate.isDate(value)) {
    return Result.fail(new UnixNanoConversionError({ reason: "InvalidInput", direction: "toUnixNano", unit: "Date" }))
  }
  return fromInstantMilliseconds(value.getTime(), "Date")
}

/**
 * Converts a UTC or zoned `DateTime` using its instant milliseconds.
 *
 * **Details**
 *
 * Uses instant milliseconds regardless of zone. Rejects malformed inputs and
 * milliseconds that are non-finite, fractional, or outside the inclusive range
 * -8640000000000000 through 8640000000000000 with `InvalidInput`.
 *
 * @stability experimental
 * @category converting
 * @since 4.0.7
 */
export const unixNanoFromDateTime = (value: DateTime): Result.Result<UnixNano, UnixNanoConversionError> => {
  if (!Internal.isDateTime(value) || (!Internal.isUtc(value) && !Internal.isZoned(value))) {
    return Result.fail(
      new UnixNanoConversionError({ reason: "InvalidInput", direction: "toUnixNano", unit: "DateTime" })
    )
  }
  return fromInstantMilliseconds(Internal.toEpochMillis(value), "DateTime")
}

/**
 * Converts epoch nanoseconds to a `Date` with exact millisecond precision by default.
 *
 * **Details**
 *
 * Checks the original nanoseconds against the inclusive range
 * `-8640000000000000000000n` through `8640000000000000000000n` before
 * precision handling. Exact conversion requires divisibility by `1000000n`.
 * Explicit `"truncate"` divides toward zero, then converts the safe integer
 * milliseconds to a number. Each successful call returns a fresh `Date`.
 *
 * **Gotchas**
 *
 * A value one nanosecond outside either boundary returns `OutOfRange`, even
 * when truncation would bring it within range. For `-1n`, exact conversion
 * returns `PrecisionLoss`. `"truncate"` produces epoch millisecond zero.
 *
 * **Example** (Converting an instant before the epoch)
 *
 * ```ts import.meta.vitest
 * import * as DateTime from "./DateTime.js"
import { Result } from "effect"
 *
 * const instant = DateTime.unixNanoFromNanoseconds(-1n)
 * Result.getOrThrow(DateTime.unixNanoToDate(instant, { precision: "truncate" })).getTime() // => 0
 * ```
 *
 * @stability experimental
 * @category converting
 * @since 4.0.7
 */
export const unixNanoToDate = (
  value: UnixNano,
  options?: UnixNano.ConversionOptions
): Result.Result<Date, UnixNanoConversionError> =>
  Result.map(toMilliseconds(value, "Date", options), (milliseconds) => new Date(milliseconds))

/**
 * Converts epoch nanoseconds to a `Utc` with exact millisecond precision by default.
 *
 * **Details**
 *
 * Checks the original nanoseconds against the inclusive range
 * `-8640000000000000000000n` through `8640000000000000000000n` before
 * precision handling. Exact conversion requires divisibility by `1000000n`.
 * Explicit `"truncate"` divides toward zero, then converts the safe integer
 * milliseconds to a number.
 *
 * **Gotchas**
 *
 * A value one nanosecond outside either boundary returns `OutOfRange`, even
 * when truncation would bring it within range. For `-1n`, exact conversion
 * returns `PrecisionLoss`. `"truncate"` produces epoch millisecond zero.
 *
 * @stability experimental
 * @category converting
 * @since 4.0.7
 */
export const unixNanoToDateTime = (
  value: UnixNano,
  options?: UnixNano.ConversionOptions
): Result.Result<Utc, UnixNanoConversionError> =>
  Result.map(toMilliseconds(value, "DateTime", options), (milliseconds) => Internal.makeUnsafe(milliseconds))

/**
 * Types used by Unix nanosecond conversions.
 *
 * @stability experimental
 * @since 4.0.7
 */
export declare namespace UnixNano {
  /**
   * Conversion precision options. The default `"exact"` rejects any remainder.
   * `"truncate"` discards the remainder toward zero.
   *
   * @since 4.0.7
   */
  export interface ConversionOptions {
    readonly precision?: "exact" | "truncate"
  }

  /**
   * A conversion failure's reason, direction, and unit.
   *
   * @since 4.0.7
   */
  export interface ConversionReason {
    readonly reason: "InvalidInput" | "OutOfRange" | "PrecisionLoss"
    readonly direction: "toUnixNano" | "fromUnixNano"
    readonly unit: "nanoseconds" | "seconds" | "milliseconds" | "Date" | "DateTime"
  }
}

const NANOS_PER_MILLS = BigInt("1000000")
const MAX_NANOS = BigInt("8640000000000000000000")

const fromScaled = (
  value: bigint | number,
  scale: number,
  unit: "seconds" | "milliseconds",
  options?: UnixNano.ConversionOptions
): Result.Result<UnixNano, UnixNanoConversionError> => {
  if (typeof value !== "bigint" && (typeof value !== "number" || !Number.isFinite(value))) {
    return Result.fail(new UnixNanoConversionError({ reason: "InvalidInput", direction: "toUnixNano", unit }))
  }

  if (typeof value === "bigint") {
    return Result.succeed(unixNanoFromNanoseconds(value * BigInt("10") ** BigInt(scale)))
  }

  // Number spelling is the contract, rather than its binary floating-point expansion.
  const [coefficient, exponent = "0"] = String(value).toLowerCase().split("e")
  const [whole, fraction = ""] = coefficient.split(".")
  const integer = BigInt(whole + fraction)
  const power = scale + Number(exponent) - fraction.length

  if (power >= 0) return Result.succeed(unixNanoFromNanoseconds(integer * BigInt("10") ** BigInt(power)))

  const divisor = BigInt("10") ** BigInt(-power)

  if (options?.precision !== "truncate" && integer % divisor !== BigInt("0")) {
    return Result.fail(new UnixNanoConversionError({ reason: "PrecisionLoss", direction: "toUnixNano", unit }))
  }

  return Result.succeed(unixNanoFromNanoseconds(integer / divisor))
}

const fromInstantMilliseconds = (
  milliseconds: number,
  unit: "Date" | "DateTime"
): Result.Result<UnixNano, UnixNanoConversionError> => {
  if (!Number.isInteger(milliseconds) || Math.abs(milliseconds) > 8_640_000_000_000_000) {
    return Result.fail(new UnixNanoConversionError({ reason: "InvalidInput", direction: "toUnixNano", unit }))
  }

  return Result.succeed(unixNanoFromNanoseconds(BigInt(milliseconds) * NANOS_PER_MILLS))
}

const toMilliseconds = (
  value: UnixNano,
  unit: "Date" | "DateTime",
  options?: UnixNano.ConversionOptions
): Result.Result<number, UnixNanoConversionError> => {
  if (typeof value !== "bigint") {
    return Result.fail(new UnixNanoConversionError({ reason: "InvalidInput", direction: "fromUnixNano", unit }))
  }

  const nanoseconds = value
  if (nanoseconds < -MAX_NANOS || nanoseconds > MAX_NANOS) {
    return Result.fail(new UnixNanoConversionError({ reason: "OutOfRange", direction: "fromUnixNano", unit }))
  }

  if (options?.precision !== "truncate" && nanoseconds % NANOS_PER_MILLS !== BigInt("0")) {
    return Result.fail(new UnixNanoConversionError({ reason: "PrecisionLoss", direction: "fromUnixNano", unit }))
  }

  return Result.succeed(Number(nanoseconds / NANOS_PER_MILLS))
}
