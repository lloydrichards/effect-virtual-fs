import { assert, describe, it } from "@effect/vitest"
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { type Connection, handleCall, type RpcHandlers, RpcPolicyDenied } from "../src/internal/rpc.js"
import { make, XdrCodec, XdrEncodeError } from "../src/internal/xdr.js"

const limits = {
  maxOpaqueBytes: ByteSize.bytes(128),
  maxStringBytes: ByteSize.bytes(32),
  maxArrayElements: 8,
  maxAuthBytes: ByteSize.bytes(64),
  maxMachineNameBytes: ByteSize.bytes(12),
  maxSupplementaryGroups: 2,
  maxRecordBytes: ByteSize.kibibytes(128)
}

const none = new Uint8Array(8)

const encodeAuth = (flavor: number, body: Uint8Array) =>
  Effect.gen(function*() {
    const writer = yield* make.openWriter(limits, 128)
    yield* writer.write(XdrCodec.uint32, flavor)
    yield* writer.write(XdrCodec.opaque(), body)

    return yield* writer.finish
  })

const call = (options: {
  xid?: number
  rpcVersion?: number
  program?: number
  version?: number
  procedure?: number
  credential?: Uint8Array
  verifier?: Uint8Array
  body?: Uint8Array
} = {}) =>
  Effect.gen(function*() {
    const writer = yield* make.openWriter(limits, 128 * 1024)
    yield* writer.write(XdrCodec.uint32, options.xid ?? 42)
    yield* writer.write(XdrCodec.uint32, 0)
    yield* writer.write(XdrCodec.uint32, options.rpcVersion ?? 2)
    yield* writer.write(XdrCodec.uint32, options.program ?? 100003)
    yield* writer.write(XdrCodec.uint32, options.version ?? 4)
    yield* writer.write(XdrCodec.uint32, options.procedure ?? 0)
    yield* writer.appendEncoded(options.credential ?? none)
    yield* writer.appendEncoded(options.verifier ?? none)
    yield* writer.appendEncoded(options.body ?? new Uint8Array())

    return yield* writer.finish
  })

const fields = (reply: Uint8Array) =>
  Effect.gen(function*() {
    const reader = yield* make.openReader(reply, limits)
    const result: Array<number> = []

    while ((yield* reader.remaining) >= 4) result.push(yield* reader.read(XdrCodec.uint32))

    return result
  })

const connection: Connection = { id: 0, send: () => Effect.succeed(true) }

const noDisconnect = () => Effect.void

const handler: RpcHandlers = {
  compound: ({ arguments: value }) => Effect.succeed(value),
  disconnect: noDisconnect,
  callbackReply: () => Effect.void
}

const encodeAuthSys = (groups: ReadonlyArray<number>) =>
  Effect.gen(function*() {
    const writer = yield* make.openWriter(limits, 128)
    yield* writer.write(XdrCodec.uint32, 1)
    yield* writer.write(XdrCodec.string(), "machine")
    yield* writer.write(XdrCodec.uint32, 501)
    yield* writer.write(XdrCodec.uint32, 20)
    yield* writer.write(XdrCodec.array(XdrCodec.uint32), groups)

    return yield* writer.finish
  })

describe("ONC RPC", () => {
  it.effect("should return policy denial when a COMPOUND call is refused", () =>
    Effect.gen(function*() {
      const refused: RpcHandlers = {
        ...handler,
        compound: () => Effect.fail(new RpcPolicyDenied())
      }

      const response = yield* handleCall(connection, yield* call({ procedure: 1 }), limits, refused)

      assert.deepStrictEqual(yield* fields(response!), [42, 1, 1, 1, 7])
    }))

  it.effect("should route NULL and opaque COMPOUND calls while echoing the XID", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(
        yield* fields((yield* handleCall(connection, yield* call({ xid: 99 }), limits, handler))!),
        [
          99,
          1,
          0,
          0,
          0,
          0
        ]
      )
      const body = new Uint8Array([1, 2, 3, 4])
      const reply = (yield* handleCall(connection, yield* call({ xid: 7, procedure: 1, body }), limits, handler))!
      assert.deepStrictEqual(yield* fields(reply), [7, 1, 0, 0, 0, 0, 0x01020304])
    }))

  it.effect("should return MSG_DENIED when RPC version or authentication is rejected", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(
        yield* fields((yield* handleCall(connection, yield* call({ rpcVersion: 3 }), limits, handler))!),
        [
          42,
          1,
          1,
          0,
          2,
          2
        ]
      )
      const unknownAuth = yield* encodeAuth(9, new Uint8Array())
      assert.deepStrictEqual(
        yield* fields((yield* handleCall(connection, yield* call({ credential: unknownAuth }), limits, handler))!),
        [
          42,
          1,
          1,
          1,
          1
        ]
      )
      const gss = yield* encodeAuth(6, new Uint8Array([0, 0, 0, 1]))
      assert.deepStrictEqual(
        yield* fields(
          (yield* handleCall(connection, yield* call({ credential: gss, procedure: 1 }), limits, handler))!
        ),
        [42, 1, 1, 1, 5]
      )
      const invalidVerifier = yield* encodeAuth(1, new Uint8Array())
      assert.deepStrictEqual(
        yield* fields((yield* handleCall(connection, yield* call({ verifier: invalidVerifier }), limits, handler))!),
        [
          42,
          1,
          1,
          1,
          3
        ]
      )
      assert.deepStrictEqual(
        yield* fields(
          (yield* handleCall(connection, yield* call({ verifier: new Uint8Array([0, 0, 0]) }), limits, handler))!
        ),
        [42, 1, 1, 1, 3]
      )
      const truncatedVerifier = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 1])
      assert.deepStrictEqual(
        yield* fields((yield* handleCall(connection, yield* call({ verifier: truncatedVerifier }), limits, handler))!),
        [
          42,
          1,
          1,
          1,
          3
        ]
      )
    }))

  it.effect("should return MSG_ACCEPTED errors when routing fields or arguments are invalid", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(
        yield* fields((yield* handleCall(connection, yield* call({ program: 1 }), limits, handler))!),
        [
          42,
          1,
          0,
          0,
          0,
          1
        ]
      )
      assert.deepStrictEqual(
        yield* fields((yield* handleCall(connection, yield* call({ version: 3 }), limits, handler))!),
        [
          42,
          1,
          0,
          0,
          0,
          2,
          4,
          4
        ]
      )
      assert.deepStrictEqual(
        yield* fields((yield* handleCall(connection, yield* call({ procedure: 9 }), limits, handler))!),
        [
          42,
          1,
          0,
          0,
          0,
          3
        ]
      )
      assert.deepStrictEqual(
        yield* fields((yield* handleCall(connection, (yield* call()).subarray(0, 8), limits, handler))!),
        [
          42,
          1,
          0,
          0,
          0,
          4
        ]
      )
    }))

  it.effect("should decode bounded AUTH_SYS credentials when fields are valid", () =>
    Effect.gen(function*() {
      const authBody = yield* encodeAuthSys([20, 80])
      const credential = yield* encodeAuth(1, authBody)
      let observed: unknown
      yield* handleCall(connection, yield* call({ procedure: 1, credential }), limits, {
        compound: (value) => {
          observed = value.credentials

          return Effect.succeed(new Uint8Array())
        },
        disconnect: noDisconnect,
        callbackReply: () => Effect.void
      })
      assert.deepStrictEqual(observed, {
        _tag: "Sys",
        stamp: 1,
        machineName: "machine",
        uid: 501,
        gid: 20,
        supplementaryGroups: [20, 80]
      })

      const tooMany = yield* encodeAuthSys([1, 2, 3])

      const rejected = (yield* handleCall(
        connection,
        yield* call({ credential: yield* encodeAuth(1, tooMany) }),
        limits,
        handler
      ))!

      assert.deepStrictEqual(yield* fields(rejected), [42, 1, 1, 1, 1])
    }))

  it.effect("should append the COMPOUND body as raw bytes when replying", () =>
    Effect.gen(function*() {
      const payload = new Uint8Array([0xaa, 0xbb, 0xcc])

      const reply = (yield* handleCall(connection, yield* call({ procedure: 1 }), limits, {
        ...handler,
        compound: () => Effect.succeed(payload)
      }))!

      assert.deepStrictEqual(reply.slice(24), payload)
      assert.strictEqual(reply.length, 27)
    }))

  it.effect("should fail reply encoding when the record ceiling is too small", () =>
    Effect.gen(function*() {
      const result = yield* Effect.result(handleCall(connection, yield* call(), {
        ...limits,
        maxRecordBytes: ByteSize.bytes(20)
      }, handler))

      assert.isTrue(Result.isFailure(result))

      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, XdrEncodeError)
        assert.strictEqual(result.failure.reason, "output-limit")
      }
    }))

  it.effect("should omit a reply when the XID cannot be decoded", () =>
    Effect.gen(function*() {
      assert.isUndefined(yield* handleCall(connection, new Uint8Array(), limits, handler))
      assert.isUndefined(yield* handleCall(connection, new Uint8Array([1, 2, 3]), limits, handler))
    }))
})
