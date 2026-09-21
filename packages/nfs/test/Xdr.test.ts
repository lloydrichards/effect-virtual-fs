import { assert, describe, it } from "@effect/vitest"
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { compile, layer, make, Xdr, XdrCodec } from "../src/internal/xdr.js"

const limits = {
  maxOpaqueBytes: ByteSize.bytes(16),
  maxStringBytes: ByteSize.bytes(8),
  maxArrayElements: 3
}

const words = XdrCodec.struct({ a: XdrCodec.uint32, b: XdrCodec.int32, c: XdrCodec.uint64, d: XdrCodec.boolean })

describe("XDR", () => {
  it.effect("round trips big-endian integer boundaries and golden bytes", () =>
    Effect.gen(function*() {
      const value = { a: 0xffff_ffff, b: -0x8000_0000, c: 0xffff_ffff_ffff_ffffn, d: true }
      const bytes = yield* (make.encode(value, words, limits, 64))
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
      assert.deepStrictEqual(yield* (make.decode(bytes, limits, words)), value)
      assert.strictEqual(
        (yield* (Effect.flip(make.encode({ ...value, a: 0x1_0000_0000 }, words, limits, 64)))).reason,
        "range"
      )
    }))

  it.effect("handles opaque alignment, strings, arrays, and discriminants", () =>
    Effect.gen(function*() {
      const description = XdrCodec.struct({
        blob: XdrCodec.opaque(),
        text: XdrCodec.string(),
        values: XdrCodec.array(XdrCodec.uint32),
        choice: XdrCodec.discriminant({ 1: XdrCodec.uint32, 2: XdrCodec.boolean })
      })

      const value = {
        blob: new Uint8Array([1, 2, 3]),
        text: "hi",
        values: [7, 8],
        choice: { tag: 2, value: true }
      } as const

      const bytes = yield* (make.encode(value, description, limits, 64))
      assert.strictEqual(
        Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
        "000000030102030000000002686900000000000200000007000000080000000200000001"
      )
      assert.deepStrictEqual(yield* (make.decode(bytes, limits, description)), value)
    }))

  it.effect("reports wire errors with offset, path and reason", () =>
    Effect.gen(function*() {
      const description = XdrCodec.struct({ value: XdrCodec.boolean })
      const failure = yield* (Effect.flip(make.decode(new Uint8Array([0, 0, 0, 2]), limits, description)))
      assert.strictEqual(failure.reason, "invalid-boolean")
      assert.strictEqual(failure.offset, 0)
      assert.deepStrictEqual(failure.path, ["value"])
      assert.strictEqual(
        (yield* (Effect.flip(make.decode(new Uint8Array([0, 0, 0]), limits, XdrCodec.uint32)))).reason,
        "truncated"
      )
      assert.strictEqual(
        (yield* (Effect.flip(make.decode(new Uint8Array([0, 0, 0, 1, 1, 2, 3, 9]), limits, XdrCodec.opaque())))).reason,
        "padding"
      )
      assert.strictEqual(
        (yield* (Effect.flip(make.decode(new Uint8Array([0, 0, 0, 17]), limits, XdrCodec.opaque())))).reason,
        "length-limit"
      )
      assert.strictEqual(
        (yield* (Effect.flip(make.decode(new Uint8Array([0, 0, 0, 4]), limits, XdrCodec.array(XdrCodec.uint32)))))
          .reason,
        "length-limit"
      )
    }))

  it.effect("makes a failed composite read atomic and seals only after exact consumption", () =>
    Effect.gen(function*() {
      const reader = yield* (make.openReader(new Uint8Array([0, 0, 0, 7]), limits))
      const pair = XdrCodec.struct({ first: XdrCodec.uint32, second: XdrCodec.uint32 })
      assert.strictEqual((yield* (Effect.flip(reader.read(pair)))).reason, "truncated")
      assert.strictEqual(yield* (reader.remaining), 4)
      assert.strictEqual(yield* (reader.read(XdrCodec.uint32)), 7)
      yield* (reader.finish)
      assert.strictEqual((yield* (Effect.flip(reader.read(XdrCodec.uint32)))).reason, "sealed")
    }))

  it.effect("serializes repeated reader Effects and copies opaque bytes", () =>
    Effect.gen(function*() {
      const source = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 2])
      const reader = yield* (make.openReader(source, limits))
      source[3] = 99
      const read = reader.read(XdrCodec.uint32)
      assert.strictEqual(yield* read, 1)
      assert.strictEqual(yield* read, 2)
      yield* (reader.finish)
      const opaque = new Uint8Array([0, 0, 0, 1, 5, 0, 0, 0])
      const value = yield* (make.decode(opaque, limits, XdrCodec.opaque()))
      opaque[4] = 8
      assert.strictEqual(value[0], 5)
    }))

  it.effect("serializes concurrent reader and writer sessions", () =>
    Effect.gen(function*() {
      const values = Array.from({ length: 32 }, (_, index) => index + 1)

      const source = yield* make.encode(values, XdrCodec.fixedArray(XdrCodec.uint32, values.length), {
        ...limits,
        maxArrayElements: values.length
      }, values.length * 4)

      const reader = yield* make.openReader(source, limits)
      const read = reader.read(XdrCodec.uint32)
      const decoded = yield* Effect.forEach(values, () => read, { concurrency: "unbounded" })

      assert.deepStrictEqual([...decoded].sort((a, b) => a - b), values)
      yield* reader.finish

      const writer = yield* make.openWriter(limits, values.length * 4)
      yield* Effect.forEach(values, (value) => writer.write(XdrCodec.uint32, value), { concurrency: "unbounded" })

      const encoded = yield* writer.finish

      const decodedWrites = yield* make.decode(
        encoded,
        { ...limits, maxArrayElements: values.length },
        XdrCodec.fixedArray(XdrCodec.uint32, values.length)
      )

      assert.deepStrictEqual([...decodedWrites].sort((a, b) => a - b), values)
    }))

  it.effect("keeps failed writes atomic, copies raw bytes, snapshots, and seals", () =>
    Effect.gen(function*() {
      const writer = yield* (make.openWriter(limits, 12))
      const write = writer.write(XdrCodec.uint32, 7)
      yield* write
      assert.strictEqual(
        (yield* (Effect.flip(writer.write(XdrCodec.array(XdrCodec.uint32), [1, 2])))).reason,
        "output-limit"
      )
      assert.strictEqual(yield* (writer.length), 4)
      const raw = new Uint8Array([9, 8, 7, 6])
      yield* (writer.appendEncoded(raw))
      raw[0] = 0
      const snapshot = yield* (writer.bytes)
      snapshot[0] = 0
      assert.deepStrictEqual([...yield* (writer.finish)], [0, 0, 0, 7, 9, 8, 7, 6])
      assert.strictEqual((yield* (Effect.flip(writer.write(XdrCodec.uint32, 1)))).reason, "sealed")
    }))

  it.effect("compiles a whole-value Schema.Codec with explicit validation and limits", () =>
    Effect.gen(function*() {
      const description = XdrCodec.struct({ value: XdrCodec.uint32 })
      const schema = compile(description, Schema.Struct({ value: Schema.Finite }), limits, 4)
      const bytes = yield* (Schema.encodeEffect(schema)({ value: 3 }))
      assert.deepStrictEqual([...bytes], [0, 0, 0, 3])
      assert.deepStrictEqual(yield* (Schema.decodeEffect(schema)(bytes)), { value: 3 })
      assert.isDefined(yield* (Effect.flip(Schema.decodeEffect(schema)(new Uint8Array([0, 0, 0])))))
      assert.isDefined(yield* (Effect.flip(Schema.encodeEffect(schema)({ value: -1 }))))
    }))

  it.effect("rejects oversized primitive and composite output before building a result", () =>
    Effect.gen(function*() {
      const large = new Uint8Array(1024 * 1024)
      const wideLimits = { ...limits, maxOpaqueBytes: ByteSize.bytes(large.length) }
      const fixed = yield* (Effect.flip(make.encode(large, XdrCodec.fixedOpaque(large.length), wideLimits, 8)))
      assert.strictEqual(fixed.reason, "output-limit")
      const opaque = yield* (Effect.flip(make.encode(large, XdrCodec.opaque(), wideLimits, 8)))
      assert.strictEqual(opaque.reason, "output-limit")
      const nested = XdrCodec.struct({ prefix: XdrCodec.uint32, body: XdrCodec.fixedOpaque(large.length) })
      const composite = yield* (Effect.flip(make.encode({ prefix: 1, body: large }, nested, wideLimits, 8)))
      assert.strictEqual(composite.reason, "output-limit")
      assert.deepStrictEqual(composite.path, ["body"])
      // SAFETY: This intentionally presents a malformed runtime value to the typed codec.
      const spoofed = Object.create(null, { [Symbol.toStringTag]: { value: "BigInt" } }) as bigint
      const invalid = yield* Effect.flip(make.encode(spoofed, XdrCodec.uint64, wideLimits, 8))
      assert.strictEqual(invalid.reason, "range")
    }))

  it.effect("provides reader and writer sessions through the Xdr service", () =>
    Effect.gen(function*() {
      const bytes = yield* (
        Effect.gen(function*() {
          const xdr = yield* Xdr
          const writer = yield* xdr.openWriter(limits, 8)
          yield* writer.write(XdrCodec.uint32, 7)

          return yield* writer.finish
        }).pipe(Effect.provide(layer))
      )

      assert.strictEqual(yield* (make.decode(bytes, limits, XdrCodec.uint32)), 7)
    }))

  it.effect("selects a dependent body codec from the preceding value", () =>
    Effect.gen(function*() {
      const description = XdrCodec.dependent(XdrCodec.uint32, (tag) => tag === 1 ? XdrCodec.uint32 : undefined)
      const bytes = yield* (make.encode({ head: 1, body: 9 }, description, limits, 8))
      assert.deepStrictEqual(yield* (make.decode(bytes, limits, description)), { head: 1, body: 9 })
      assert.strictEqual(
        (yield* (Effect.flip(make.decode(new Uint8Array([0, 0, 0, 2]), limits, description)))).reason,
        "discriminant"
      )
    }))
})
