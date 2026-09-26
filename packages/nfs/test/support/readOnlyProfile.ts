import { Effect } from "effect"
import * as ByteSize from "effect/ByteSize"
import { type Nfs4Handler, Operation, Status } from "../../src/internal/nfs4.js"
import type { CompoundCall } from "../../src/internal/rpc.js"
import {
  type DecoderSession,
  type EncoderSession,
  make,
  XdrCodec,
  type XdrDecodeError,
  type XdrEncodeError
} from "../../src/internal/xdr.js"
import { call, limits } from "./harness.js"

export const ACCESS_ALL = 0x3f

export const sys = (uid: number, gid: number, groups: ReadonlyArray<number> = []): CompoundCall["credentials"] => ({
  _tag: "Sys",
  stamp: 0,
  machineName: "probe",
  uid,
  gid,
  supplementaryGroups: groups
})

export const callAs = (
  credentials: CompoundCall["credentials"],
  operations: ReadonlyArray<(writer: EncoderSession) => Effect.Effect<void, XdrEncodeError>>
) => Effect.map(call(operations), (request) => ({ ...request, credentials }))

type DecodedBody =
  | void
  | undefined
  | Uint8Array
  | ReadonlyArray<number>
  | { readonly supported: number; readonly access: number }
  | { readonly eof: boolean; readonly data: Uint8Array }
  | { readonly clientid: bigint; readonly sequence: number; readonly flags: number }
  | { readonly session: Uint8Array; readonly sequence: number }
  | { readonly stateid: Uint8Array; readonly delegation: number; readonly why: number }
  | { readonly session: Uint8Array; readonly direction: number; readonly rdma: boolean }

type BodyReader = (reader: DecoderSession) => Effect.Effect<DecodedBody, XdrDecodeError>

export type DecodedReply = {
  readonly status: number
  readonly operations: ReadonlyArray<{ readonly code: number; readonly status: number; readonly value?: unknown }>
}

const skipWords = (reader: DecoderSession, count: number) =>
  Effect.forEach(Array.from({ length: count }), () => reader.read(XdrCodec.uint32), { discard: true })

const bodyReaders = {
  [Operation.SEQUENCE]: (reader) =>
    Effect.gen(function*() {
      yield* reader.read(XdrCodec.fixedOpaque(16))
      yield* skipWords(reader, 5)
    }),
  [Operation.PUTROOTFH]: () => Effect.void,
  [Operation.PUTPUBFH]: () => Effect.void,
  [Operation.PUTFH]: () => Effect.void,
  [Operation.LOOKUP]: () => Effect.void,
  [Operation.VERIFY]: () => Effect.void,
  [Operation.NVERIFY]: () => Effect.void,
  [Operation.FREE_STATEID]: () => Effect.void,
  [Operation.GETFH]: (reader) => reader.read(XdrCodec.opaque()),
  [Operation.ACCESS]: (reader) =>
    Effect.gen(function*() {
      const supported = yield* reader.read(XdrCodec.uint32)
      const access = yield* reader.read(XdrCodec.uint32)

      return { supported, access }
    }),
  [Operation.COMMIT]: (reader) => reader.read(XdrCodec.fixedOpaque(8)),
  [Operation.SECINFO]: (reader) => reader.read(XdrCodec.array(XdrCodec.uint32)),
  [Operation.TEST_STATEID]: (reader) => reader.read(XdrCodec.array(XdrCodec.uint32)),
  [Operation.OPEN_DOWNGRADE]: (reader) => reader.read(XdrCodec.fixedOpaque(16)),
  [Operation.CLOSE]: (reader) => reader.read(XdrCodec.fixedOpaque(16)),
  [Operation.LOCKT]: () => Effect.void,
  [Operation.READLINK]: (reader) => reader.read(XdrCodec.opaque()),
  [Operation.BACKCHANNEL_CTL]: () => Effect.void,
  [Operation.BIND_CONN_TO_SESSION]: (reader) =>
    Effect.gen(function*() {
      const session = yield* reader.read(XdrCodec.fixedOpaque(16))
      const direction = yield* reader.read(XdrCodec.uint32)
      const rdma = yield* reader.read(XdrCodec.boolean)

      return { session, direction, rdma }
    }),
  [Operation.READ]: (reader) =>
    Effect.gen(function*() {
      const eof = yield* reader.read(XdrCodec.boolean)
      const data = yield* reader.read(XdrCodec.opaque())

      return { eof, data }
    }),
  [Operation.OPEN]: (reader) =>
    Effect.gen(function*() {
      const stateid = yield* reader.read(XdrCodec.fixedOpaque(16))
      yield* reader.read(XdrCodec.boolean)
      yield* reader.read(XdrCodec.uint64)
      yield* reader.read(XdrCodec.uint64)
      yield* reader.read(XdrCodec.uint32)
      yield* reader.read(XdrCodec.array(XdrCodec.uint32))
      const delegation = yield* reader.read(XdrCodec.uint32)
      const why = delegation === 3 ? yield* reader.read(XdrCodec.uint32) : -1

      return { stateid, delegation, why }
    }),
  [Operation.LOOKUPP]: () => Effect.void,
  [Operation.SAVEFH]: () => Effect.void,
  [Operation.RESTOREFH]: () => Effect.void,
  [Operation.RECLAIM_COMPLETE]: () => Effect.void,
  [Operation.DESTROY_SESSION]: () => Effect.void,
  [Operation.SECINFO_NO_NAME]: (reader) => reader.read(XdrCodec.array(XdrCodec.uint32)),
  [Operation.EXCHANGE_ID]: (reader) =>
    Effect.gen(function*() {
      const clientid = yield* reader.read(XdrCodec.uint64)
      const sequence = yield* reader.read(XdrCodec.uint32)
      const flags = yield* reader.read(XdrCodec.uint32)
      yield* reader.read(XdrCodec.uint32)
      yield* reader.read(XdrCodec.uint64)
      yield* reader.read(XdrCodec.opaque())
      yield* reader.read(XdrCodec.opaque())
      yield* reader.read(XdrCodec.array(XdrCodec.uint32))

      return { clientid, sequence, flags }
    }),
  [Operation.CREATE_SESSION]: (reader) =>
    Effect.gen(function*() {
      const session = yield* reader.read(XdrCodec.fixedOpaque(16))
      const sequence = yield* reader.read(XdrCodec.uint32)
      yield* reader.read(XdrCodec.uint32)
      yield* Effect.forEach([0, 1], () =>
        Effect.gen(function*() {
          yield* skipWords(reader, 6)
          yield* reader.read(XdrCodec.array(XdrCodec.uint32))
        }), { discard: true })

      return { session, sequence }
    })
} satisfies Readonly<Record<number, BodyReader>>

export const decode = (bytes: Uint8Array) =>
  Effect.gen(function*() {
    const reader = yield* make.openReader(bytes, limits)
    const status = yield* reader.read(XdrCodec.uint32)
    yield* reader.read(XdrCodec.string())
    const count = yield* reader.read(XdrCodec.uint32)
    const operations: Array<{ readonly code: number; readonly status: number; readonly value?: unknown }> = []

    for (let index = 0; index < count; index++) {
      const code = yield* reader.read(XdrCodec.uint32)
      const operationStatus = yield* reader.read(XdrCodec.uint32)

      if (operationStatus !== Status.OK) {
        operations.push({ code, status: operationStatus })
        continue
      }

      // SAFETY: The own-property check proves that a known operation code indexes this table.
      const body = Object.hasOwn(bodyReaders, code) ? bodyReaders[code as keyof typeof bodyReaders] : undefined

      if (body === undefined) throw new Error(`No body reader for operation ${code}`)
      operations.push({ code, status: operationStatus, value: yield* body(reader) })
    }

    yield* reader.finish

    return { status, operations }
  })

export const run = (handler: Nfs4Handler, request: Effect.Effect<CompoundCall, XdrEncodeError>) =>
  Effect.flatMap(request, (call) => Effect.flatMap(handler.compound(call), decode))

export const fattr = (
  writer: EncoderSession,
  attribute: number,
  value: (values: EncoderSession) => Effect.Effect<void, XdrEncodeError>
) =>
  Effect.gen(function*() {
    const values = yield* make.openWriter(limits, ByteSize.toNumberUnsafe(limits.maxCompoundBytes))
    yield* value(values)
    const words = Array.from<number>({ length: Math.floor(attribute / 32) + 1 }).fill(0)
    words[Math.floor(attribute / 32)] = 1 << attribute % 32 >>> 0
    yield* writer.write(XdrCodec.array(XdrCodec.uint32), words)
    yield* writer.write(XdrCodec.opaque(), yield* values.finish)
  })
