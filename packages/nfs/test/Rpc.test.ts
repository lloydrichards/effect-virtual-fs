import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { handleCall } from "../src/internal/rpc.js"
import { Reader, Writer } from "../src/internal/xdr.js"

const limits = {
  maxOpaqueBytes: 128,
  maxStringBytes: 32,
  maxArrayElements: 8,
  maxAuthBytes: 64,
  maxMachineNameBytes: 12,
  maxSupplementaryGroups: 2
}
const none = new Writer().uint32(0).opaque(new Uint8Array()).bytes()
const call = (options: {
  xid?: number
  rpcVersion?: number
  program?: number
  version?: number
  procedure?: number
  credential?: Uint8Array
  verifier?: Uint8Array
  body?: Uint8Array
} = {}): Uint8Array => {
  const header = new Writer()
    .uint32(options.xid ?? 42).uint32(0).uint32(options.rpcVersion ?? 2)
    .uint32(options.program ?? 100003).uint32(options.version ?? 4).uint32(options.procedure ?? 0)
    .bytes()
  const parts = [header, options.credential ?? none, options.verifier ?? none, options.body ?? new Uint8Array()]
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}
const fields = (reply: Uint8Array): ReadonlyArray<number> => {
  const reader = new Reader(reply, limits)
  const result: Array<number> = []
  while (reader.remaining >= 4) result.push(reader.uint32())
  return result
}
const handler = { compound: ({ arguments: value }: { readonly arguments: Uint8Array }) => Effect.succeed(value) }

describe("ONC RPC", () => {
  it.effect("routes NULL and opaque COMPOUND arguments and echoes the XID", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(fields((yield* handleCall(call({ xid: 99 }), limits, handler))!), [99, 1, 0, 0, 0, 0])
      const body = new Uint8Array([1, 2, 3, 4])
      const reply = (yield* handleCall(call({ xid: 7, procedure: 1, body }), limits, handler))!
      assert.deepStrictEqual(fields(reply), [7, 1, 0, 0, 0, 0, 0x01020304])
    }))

  it.effect("uses MSG_DENIED for RPC mismatch and authentication rejection", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(fields((yield* handleCall(call({ rpcVersion: 3 }), limits, handler))!), [
        42,
        1,
        1,
        0,
        2,
        2
      ])
      const unknownAuth = new Writer().uint32(9).opaque(new Uint8Array()).bytes()
      assert.deepStrictEqual(fields((yield* handleCall(call({ credential: unknownAuth }), limits, handler))!), [
        42,
        1,
        1,
        1,
        1
      ])
      const invalidVerifier = new Writer().uint32(1).opaque(new Uint8Array()).bytes()
      assert.deepStrictEqual(fields((yield* handleCall(call({ verifier: invalidVerifier }), limits, handler))!), [
        42,
        1,
        1,
        1,
        3
      ])
      assert.deepStrictEqual(
        fields((yield* handleCall(call({ verifier: new Uint8Array([0, 0, 0]) }), limits, handler))!),
        [42, 1, 1, 1, 3]
      )
      const truncatedVerifier = new Writer().uint32(0).uint32(4).uint32(1).bytes()
      assert.deepStrictEqual(fields((yield* handleCall(call({ verifier: truncatedVerifier }), limits, handler))!), [
        42,
        1,
        1,
        1,
        3
      ])
    }))

  it.effect("uses MSG_ACCEPTED failures for unknown program, version, procedure, and malformed arguments", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(fields((yield* handleCall(call({ program: 1 }), limits, handler))!), [42, 1, 0, 0, 0, 1])
      assert.deepStrictEqual(fields((yield* handleCall(call({ version: 3 }), limits, handler))!), [
        42,
        1,
        0,
        0,
        0,
        2,
        4,
        4
      ])
      assert.deepStrictEqual(fields((yield* handleCall(call({ procedure: 9 }), limits, handler))!), [42, 1, 0, 0, 0, 3])
      assert.deepStrictEqual(fields((yield* handleCall(call().subarray(0, 8), limits, handler))!), [42, 1, 0, 0, 0, 4])
    }))

  it.effect("decodes bounded AUTH_SYS as untrusted data", () =>
    Effect.gen(function*() {
      const authBody = new Writer().uint32(1).string("machine").uint32(501).uint32(20).array(
        [20, 80],
        (writer, value) => writer.uint32(value)
      ).bytes()
      const credential = new Writer().uint32(1).opaque(authBody).bytes()
      let observed: unknown
      yield* handleCall(call({ procedure: 1, credential }), limits, {
        compound: (value) => {
          observed = value.credentials
          return Effect.succeed(new Uint8Array())
        }
      })
      assert.deepStrictEqual(observed, {
        _tag: "Sys",
        stamp: 1,
        machineName: "machine",
        uid: 501,
        gid: 20,
        supplementaryGroups: [20, 80]
      })

      const tooMany = new Writer().uint32(1).string("machine").uint32(501).uint32(20).array(
        [1, 2, 3],
        (writer, value) => writer.uint32(value)
      ).bytes()
      const rejected =
        (yield* handleCall(call({ credential: new Writer().uint32(1).opaque(tooMany).bytes() }), limits, handler))!
      assert.deepStrictEqual(fields(rejected), [42, 1, 1, 1, 1])
    }))

  it.effect("does not fabricate a reply without a decodable XID", () =>
    Effect.gen(function*() {
      assert.isUndefined(yield* handleCall(new Uint8Array(), limits, handler))
      assert.isUndefined(yield* handleCall(new Uint8Array([1, 2, 3]), limits, handler))
    }))
})
