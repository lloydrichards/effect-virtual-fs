// Generated from Effect PR #9960 by scripts/sync.mjs. Edit the snapshot or generator, then run sync.
import * as DateTime from "../src/compat/DateTime.js"
import type * as Result from "effect/Result"
import * as Schema from "../src/compat/Schema.js"
import { describe, expect, it } from "tstyche"

describe("DateTime.UnixNano", () => {
  it("should reject incompatible inputs when constructing or consuming exact instants", () => {
    const value = DateTime.unixNanoFromNanoseconds(1n)
    expect(value).type.toBe<DateTime.UnixNano>()
    expect(value).type.toBeAssignableTo<bigint>()
    expect(value).type.not.toBeAssignableTo<DateTime.DateTime>()
    expect(value).type.not.toBeAssignableTo<DateTime.DateTime.Input>()
    expect({ epochMilliseconds: 1 }).type.toBeAssignableTo<DateTime.DateTime.Instant>()
    expect(DateTime.makeUnsafe({ epochMilliseconds: 1 })).type.toBe<DateTime.Utc>()
    expect<bigint>().type.not.toBeAssignableTo<DateTime.UnixNano>()
    expect(DateTime.unixNanoToNanoseconds(value)).type.toBe<bigint>()
    // @ts-expect-error is not assignable to
    DateTime.unixNanoFromNanoseconds(1)
    // @ts-expect-error is not assignable to
    DateTime.unixNanoFromSeconds("1")
    // @ts-expect-error is not assignable to
    DateTime.unixNanoFromMilliseconds("1")
    // @ts-expect-error is not assignable to
    DateTime.unixNanoToDate(1n)
    // @ts-expect-error is not assignable to
    DateTime.unixNanoFromSeconds(1, { precision: "round" })
  })

  it("should infer branded instants and UTC results when decoding or converting", () => {
    expect(Schema.decodeUnknownResult(Schema.UnixNano)(1n)).type.toBe<
      Result.Result<DateTime.UnixNano, Schema.SchemaError>
    >()
    expect(DateTime.unixNanoToDateTime(DateTime.unixNanoFromNanoseconds(0n))).type.toBe<
      Result.Result<DateTime.Utc, DateTime.UnixNanoConversionError>
    >()
  })

  it("should infer conversion errors when decoding and reject unknown error units", () => {
    const fields = { reason: "InvalidInput", direction: "toUnixNano", unit: "seconds" } as const
    expect(Schema.decodeUnknownResult(Schema.UnixNanoConversionError)({})).type.toBe<
      Result.Result<DateTime.UnixNanoConversionError, Schema.SchemaError>
    >()
    expect<DateTime.UnixNano.ConversionReason["reason"]>().type.toBe<"InvalidInput" | "OutOfRange" | "PrecisionLoss">()
    // @ts-expect-error is not assignable to
    const invalid = new DateTime.UnixNanoConversionError({ ...fields, unit: "minutes" })
    void invalid
  })
})
