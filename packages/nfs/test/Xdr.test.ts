import { assert, describe, it } from "@effect/vitest"
import { Reader, Writer, XdrDecodeError } from "../src/internal/xdr.js"

const limits = { maxOpaqueBytes: 16, maxStringBytes: 8, maxArrayElements: 3 }

describe("XDR", () => {
  it("tracks encoded length without materializing the result", () => {
    const writer = new Writer().uint32(1).opaque(new Uint8Array([2, 3, 4]))
    assert.strictEqual(writer.length, 12)
    assert.strictEqual(writer.bytes().length, writer.length)
  })

  it("round trips big-endian integer width boundaries and golden bytes", () => {
    const bytes = new Writer().uint32(0xffff_ffff).int32(-0x8000_0000).uint64(0xffff_ffff_ffff_ffffn).boolean(true)
      .bytes()
    assert.deepStrictEqual([...bytes], [
      255,
      255,
      255,
      255,
      128,
      0,
      0,
      0,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      0,
      0,
      0,
      1
    ])
    const reader = new Reader(bytes, limits)
    assert.strictEqual(reader.uint32(), 0xffff_ffff)
    assert.strictEqual(reader.int32(), -0x8000_0000)
    assert.strictEqual(reader.uint64(), 0xffff_ffff_ffff_ffffn)
    assert.isTrue(reader.boolean())
    reader.finish()
    assert.throws(() => new Writer().uint32(0x1_0000_0000), RangeError)
    assert.throws(() => new Writer().int32(-0x8000_0001), RangeError)
    assert.throws(() => new Writer().uint64(0x1_0000_0000_0000_0000n), RangeError)
  })

  it("handles opaque alignment, strings, arrays, and discriminants", () => {
    const bytes = new Writer().opaque(new Uint8Array([1, 2, 3])).string("hi").array(
      [7, 8],
      (writer, value) => writer.uint32(value)
    ).uint32(2).bytes()
    const reader = new Reader(bytes, limits)
    assert.deepStrictEqual(reader.opaque(), new Uint8Array([1, 2, 3]))
    assert.strictEqual(reader.string(), "hi")
    assert.deepStrictEqual(reader.array((item) => item.uint32()), [7, 8])
    assert.strictEqual(reader.discriminant({ 1: "one", 2: "two" }), "two")
    reader.finish()
  })

  it("rejects malformed lengths, nested bounds, truncation, padding, UTF-8, booleans, and discriminants", () => {
    assert.throws(() => new Reader(new Writer().uint32(17).bytes(), limits).opaque(), XdrDecodeError)
    assert.throws(
      () => new Reader(new Writer().uint32(4).bytes(), limits).array((item) => item.uint32()),
      XdrDecodeError
    )
    assert.throws(() => new Reader(new Writer().uint32(9).bytes(), limits).string(), XdrDecodeError)
    assert.throws(() => new Reader(new Uint8Array([0, 0, 0]), limits).uint32(), XdrDecodeError)
    assert.throws(() => new Reader(new Uint8Array([0, 0, 0, 1, 1, 2, 3, 9]), limits).opaque(), XdrDecodeError)
    assert.throws(
      () => new Reader(new Writer().opaque(new Uint8Array([0xff])).bytes(), limits).string(),
      XdrDecodeError
    )
    assert.throws(() => new Reader(new Writer().uint32(2).bytes(), limits).boolean(), XdrDecodeError)
    assert.throws(() => new Reader(new Writer().uint32(9).bytes(), limits).discriminant({ 1: true }), XdrDecodeError)
  })

  it("requires exact message consumption and explicit valid limits", () => {
    const reader = new Reader(new Writer().uint32(1).uint32(2).bytes(), limits)
    reader.uint32()
    assert.throws(() => reader.finish(), XdrDecodeError)
    assert.throws(() => new Reader(new Uint8Array(), { ...limits, maxOpaqueBytes: -1 }), RangeError)
  })

  it("encodes and decodes a one-mebibyte opaque value without argument expansion", () => {
    const value = new Uint8Array(1024 * 1024)
    value[0] = 1
    value[value.length - 1] = 2
    const encoded = new Writer().opaque(value).bytes()
    assert.strictEqual(encoded.length, value.length + 4)
    const reader = new Reader(encoded, { ...limits, maxOpaqueBytes: value.length })
    assert.deepStrictEqual(reader.opaque(), value)
    reader.finish()
  })
})
