// Generated from Effect PR #9960 by scripts/sync.mjs. Edit the snapshot or generator, then run sync.
import type * as BytePath from "../src/compat/BytePath.js"
import * as Schema from "../src/compat/Schema.js"
import { describe, expect, it } from "tstyche"

describe("BytePath", () => {
  it("should reject raw values when a BytePath is required", () => {
    expect<Uint8Array>().type.not.toBeAssignableTo<BytePath.BytePath>()
    expect<string>().type.not.toBeAssignableTo<BytePath.BytePath>()
  })

  it("should distinguish values from encoded bytes when composing BytePath schemas", () => {
    expect<typeof Schema.BytePath.Type>().type.toBe<BytePath.BytePath>()
    expect<typeof Schema.BytePath.Encoded>().type.toBe<BytePath.BytePath>()
    expect<typeof Schema.BytePathFromBytes.Type>().type.toBe<BytePath.BytePath>()
    expect<typeof Schema.BytePathFromBytes.Encoded>().type.toBe<Uint8Array>()
    expect<typeof Schema.BytePathFromBytes.DecodingServices>().type.toBe<never>()
    expect<typeof Schema.BytePathFromBytes.EncodingServices>().type.toBe<never>()
    const json = Schema.toCodecJson(Schema.BytePathFromBytes)
    expect<typeof json.Type>().type.toBe<BytePath.BytePath>()
  })
})
