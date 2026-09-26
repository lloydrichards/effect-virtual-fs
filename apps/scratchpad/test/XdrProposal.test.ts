import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect } from "effect"
import {
  ChannelAttrsCodec,
  CreateSessionResponseCodec,
  layer,
  previewOperations,
  RpcCallHeader,
  Xdr,
  XdrCodec,
  XdrDecodeError,
  XdrEncodeError
} from "../src/xdr-effect-proposal.js"

const limits = {
  maxOpaqueBytes: ByteSize.bytes(16),
  maxStringBytes: ByteSize.bytes(8),
  maxArrayElements: 3
}

const primitives = XdrCodec.struct({
  word: XdrCodec.uint32,
  signed: XdrCodec.int32,
  wide: XdrCodec.uint64,
  flag: XdrCodec.boolean
})

describe("Effect XDR proposal", () => {
  it.effect("should encode golden bytes and decode values when using primitive codecs", () =>
    Effect.gen(function*() {
      const xdr = yield* Xdr
      const value = { word: 0xffff_ffff, signed: -0x8000_0000, wide: 0xffff_ffff_ffff_ffffn, flag: true }
      const bytes = yield* xdr.encode(value, primitives)
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
      assert.deepStrictEqual(yield* xdr.decode(bytes, limits, primitives), value)
    }).pipe(Effect.provide(layer)))

  it.effect("should round trip an RPC call header when all fields are encoded", () =>
    Effect.gen(function*() {
      const xdr = yield* Xdr
      const call = { xid: 7, messageType: 0, rpcVersion: 2, program: 100003, version: 4, procedure: 1 }
      const bytes = yield* xdr.encode(call, RpcCallHeader)
      assert.deepStrictEqual(yield* xdr.decode(bytes, limits, RpcCallHeader), call)
    }).pipe(Effect.provide(layer)))

  it.effect("should reject an RPC call header when trailing bytes remain", () =>
    Effect.gen(function*() {
      const xdr = yield* Xdr
      const call = { xid: 7, messageType: 0, rpcVersion: 2, program: 100003, version: 4, procedure: 1 }
      const bytes = yield* xdr.encode(call, RpcCallHeader)
      assert.instanceOf(
        yield* Effect.flip(xdr.decode(Uint8Array.from([...bytes, 0]), limits, RpcCallHeader)),
        XdrDecodeError
      )
    }).pipe(Effect.provide(layer)))

  it.effect("should encode exact CREATE_SESSION response bytes when fore and back channels are present", () =>
    Effect.gen(function*() {
      const xdr = yield* Xdr

      const fore = {
        headerPadding: 0,
        maxRequest: 4096,
        maxResponse: 8192,
        maxCachedResponse: 1024,
        maxOperations: 8,
        maxRequests: 4,
        rdmaIrd: [2]
      }

      const back = { ...fore, maxRequests: 2, rdmaIrd: [] }

      const response = {
        sessionId: Uint8Array.from({ length: 16 }, (_, index) => index),
        sequence: 7,
        flags: 2,
        fore,
        back
      }

      const bytes = yield* xdr.encode(response, CreateSessionResponseCodec)
      assert.strictEqual(
        Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
        "000102030405060708090a0b0c0d0e0f0000000700000002000000000000100000002000000004000000000800000004000000010000000200000000000010000000200000000400000000080000000200000000"
      )
      assert.deepStrictEqual(yield* xdr.decode(bytes, limits, CreateSessionResponseCodec), response)
    }).pipe(Effect.provide(layer)))

  it.effect("should round trip channel attributes when an RDMA array is present", () =>
    Effect.gen(function*() {
      const xdr = yield* Xdr

      const fore = {
        headerPadding: 0,
        maxRequest: 4096,
        maxResponse: 8192,
        maxCachedResponse: 1024,
        maxOperations: 8,
        maxRequests: 4,
        rdmaIrd: [2]
      }

      assert.deepStrictEqual(
        yield* xdr.decode(yield* xdr.encode(fore, ChannelAttrsCodec), limits, ChannelAttrsCodec),
        fore
      )
    }).pipe(Effect.provide(layer)))

  it.effect("should reject a channel RDMA array when it exceeds the codec limit", () =>
    Effect.gen(function*() {
      const xdr = yield* Xdr

      const attrs = {
        headerPadding: 0,
        maxRequest: 4096,
        maxResponse: 8192,
        maxCachedResponse: 1024,
        maxOperations: 8,
        maxRequests: 4,
        rdmaIrd: [1, 2]
      }

      const error = yield* Effect.flip(xdr.encode(attrs, ChannelAttrsCodec))
      assert.instanceOf(error, XdrEncodeError)
      assert.strictEqual(error.detail, "XDR array exceeds its element limit")
    }).pipe(Effect.provide(layer)))

  it.effect("should reject decoding when an array limit is invalid", () =>
    Effect.gen(function*() {
      const xdr = yield* Xdr
      assert.instanceOf(
        yield* Effect.flip(
          xdr.decode(Uint8Array.of(0, 0, 0, 1), { ...limits, maxArrayElements: NaN }, XdrCodec.uint32)
        ),
        XdrDecodeError
      )
    }).pipe(Effect.provide(layer)))

  it.effect("should reject decoding when a fixed opaque length is invalid", () =>
    Effect.gen(function*() {
      const xdr = yield* Xdr
      assert.instanceOf(
        yield* Effect.flip(xdr.decode(Uint8Array.of(1, 2, 3, 4), limits, XdrCodec.fixedOpaque(-1))),
        XdrDecodeError
      )
    }).pipe(Effect.provide(layer)))

  it.effect("should reject encoding when a fixed opaque value has the wrong length", () =>
    Effect.gen(function*() {
      const xdr = yield* Xdr
      assert.instanceOf(yield* Effect.flip(xdr.encode(Uint8Array.of(1), XdrCodec.fixedOpaque(2))), XdrEncodeError)
    }).pipe(Effect.provide(layer)))

  it.effect("should reject opaque values when they exceed the codec limit", () =>
    Effect.gen(function*() {
      const xdr = yield* Xdr
      const maximum = ByteSize.bytes(2)

      assert.instanceOf(
        yield* Effect.flip(xdr.encode(Uint8Array.of(1, 2, 3), XdrCodec.opaque(maximum))),
        XdrEncodeError
      )
    }).pipe(Effect.provide(layer)))

  it.effect("should reject UTF-8 values when they exceed the codec limit", () =>
    Effect.gen(function*() {
      const xdr = yield* Xdr
      const maximum = ByteSize.bytes(2)
      assert.instanceOf(yield* Effect.flip(xdr.encode("éé", XdrCodec.string(maximum))), XdrEncodeError)
    }).pipe(Effect.provide(layer)))

  it.effect("should round-trip a UTF-8 value when it fits the codec limit", () =>
    Effect.gen(function*() {
      const xdr = yield* Xdr
      const maximum = ByteSize.bytes(2)
      assert.deepStrictEqual(
        yield* xdr.decode(yield* xdr.encode("é", XdrCodec.string(maximum)), limits, XdrCodec.string(maximum)),
        "é"
      )
    }).pipe(Effect.provide(layer)))

  it.effect("should retain the cursor when a composite session read fails", () =>
    Effect.gen(function*() {
      const xdr = yield* Xdr
      const first = Uint8Array.of(0, 0, 0, 7)
      const structSession = yield* xdr.open(first, limits)
      const pair = XdrCodec.struct({ first: XdrCodec.uint32, second: XdrCodec.uint32 })

      assert.instanceOf(yield* Effect.flip(structSession.read(pair)), XdrDecodeError)
      assert.strictEqual(yield* structSession.remaining, 4)
      assert.strictEqual(yield* structSession.read(XdrCodec.uint32), 7)

      const arraySession = yield* xdr.open(Uint8Array.of(0, 0, 0, 2, 0, 0, 0, 7), limits)
      assert.instanceOf(yield* Effect.flip(arraySession.read(XdrCodec.array(XdrCodec.uint32))), XdrDecodeError)
      assert.strictEqual(yield* arraySession.remaining, 8)
    }).pipe(Effect.provide(layer)))

  it.effect("should retain the cursor when padding is invalid", () =>
    Effect.gen(function*() {
      const xdr = yield* Xdr
      const session = yield* xdr.open(Uint8Array.of(0, 0, 0, 1, 42, 9, 0, 0), limits)
      assert.instanceOf(yield* Effect.flip(session.read(XdrCodec.opaque())), XdrDecodeError)
      assert.strictEqual(yield* session.remaining, 8)
    }).pipe(Effect.provide(layer)))

  it.effect("should retain prior values when a COMPOUND operation is malformed", () =>
    Effect.gen(function*() {
      const xdr = yield* Xdr
      const bytes = yield* xdr.encode([10, 11], XdrCodec.array(XdrCodec.uint32))
      const truncated = bytes.subarray(0, bytes.length - 1)
      const result = yield* previewOperations(truncated, limits)
      assert.deepStrictEqual(result.values, [10])
      assert.instanceOf(result.malformed, XdrDecodeError)
    }).pipe(Effect.provide(layer)))
})
