import { assert, describe, it } from "@effect/vitest"
import * as ByteSize from "effect/ByteSize"
import { encodeRecord, RecordDecoder, RecordMarkingError } from "../src/internal/recordMarking.js"

const limits = {
  maxFragmentBytes: ByteSize.bytes(32),
  maxRecordBytes: ByteSize.bytes(64),
  maxFragmentsPerRecord: 8
}
const fragment = (last: boolean, bytes: Uint8Array): Uint8Array => {
  const result = new Uint8Array(bytes.length + 4)
  new DataView(result.buffer).setUint32(0, (last ? 0x8000_0000 : 0) | bytes.length)
  result.set(bytes, 4)
  return result
}
const concat = (...values: ReadonlyArray<Uint8Array>): Uint8Array => {
  const output = new Uint8Array(values.reduce((size, value) => size + value.length, 0))
  let offset = 0
  for (const value of values) {
    output.set(value, offset)
    offset += value.length
  }
  return output
}

describe("ONC RPC record marking", () => {
  it("parses a record across every TCP chunk boundary", () => {
    const encoded = encodeRecord(new Uint8Array([1, 2, 3, 4, 5]))
    for (let split = 0; split < encoded.length; split++) {
      const decoder = new RecordDecoder(limits)
      assert.deepStrictEqual(decoder.push(encoded.subarray(0, split)), [])
      const records = decoder.push(encoded.subarray(split))
      assert.deepStrictEqual(records, [new Uint8Array([1, 2, 3, 4, 5])])
    }
  })

  it("parses multiple fragments, coalesced records, and zero-length fragments", () => {
    const decoder = new RecordDecoder(limits)
    const input = concat(
      fragment(false, new Uint8Array([1, 2])),
      fragment(true, new Uint8Array([3])),
      fragment(true, new Uint8Array())
    )
    assert.deepStrictEqual(decoder.push(input), [new Uint8Array([1, 2, 3]), new Uint8Array()])
  })

  it("bounds fragments and assembled records before retaining their bodies and resets after failure", () => {
    const decoder = new RecordDecoder({
      maxFragmentBytes: ByteSize.bytes(3),
      maxRecordBytes: ByteSize.bytes(4),
      maxFragmentsPerRecord: 2
    })
    assert.throws(() => decoder.push(fragment(true, new Uint8Array(4))), RecordMarkingError)
    assert.strictEqual(decoder.bufferedByteLength, 0)
    assert.throws(
      () => decoder.push(concat(fragment(false, new Uint8Array(3)), fragment(true, new Uint8Array(2)))),
      RecordMarkingError
    )
    assert.strictEqual(decoder.bufferedByteLength, 0)
    assert.deepStrictEqual(decoder.push(fragment(true, new Uint8Array([9]))), [new Uint8Array([9])])
  })

  it("decodes a record delivered one byte at a time", () => {
    const decoder = new RecordDecoder({
      maxFragmentBytes: ByteSize.bytes(1024),
      maxRecordBytes: ByteSize.bytes(1024),
      maxFragmentsPerRecord: 1
    })
    const encoded = encodeRecord(new Uint8Array(512))
    const records = []
    for (const byte of encoded) records.push(...decoder.push(Uint8Array.of(byte)))
    assert.deepStrictEqual(records, [new Uint8Array(512)])
    assert.strictEqual(decoder.bufferedByteLength, 0)
  })

  it("bounds zero-length non-final fragments and resets after rejection", () => {
    const decoder = new RecordDecoder({
      maxFragmentBytes: ByteSize.bytes(0),
      maxRecordBytes: ByteSize.bytes(0),
      maxFragmentsPerRecord: 2
    })
    assert.deepStrictEqual(decoder.push(fragment(false, new Uint8Array())), [])
    assert.deepStrictEqual(decoder.push(fragment(false, new Uint8Array())), [])
    assert.throws(() => decoder.push(fragment(false, new Uint8Array())), RecordMarkingError)
    assert.strictEqual(decoder.bufferedByteLength, 0)
    assert.deepStrictEqual(decoder.push(fragment(true, new Uint8Array())), [new Uint8Array()])
  })
})
