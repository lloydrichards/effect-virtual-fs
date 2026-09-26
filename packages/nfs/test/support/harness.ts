import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { assert } from "@effect/vitest"
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import { type ExportLimits, makeExport, type NfsExport } from "../../src/internal/export.js"
import {
  makeNfs4Handler,
  type Nfs4Handler,
  type Nfs4Limits,
  type Nfs4Options,
  Operation,
  Status
} from "../../src/internal/nfs4.js"
import type { Connection, Credentials } from "../../src/internal/rpc.js"
import { type EncoderSession, make, XdrCodec, type XdrEncodeError } from "../../src/internal/xdr.js"

export const generation = new Uint8Array(16).fill(7)

/** An arbitrary callback program number, in the transient range clients pick from. */
export const callbackProgram = 0x4000_0001

export const limits: Nfs4Limits = {
  maxOpaqueBytes: ByteSize.bytes(65_536),
  maxStringBytes: ByteSize.bytes(1_024),
  maxArrayElements: 128,
  maxRecordBytes: ByteSize.bytes(65_536),
  maxCompoundBytes: ByteSize.bytes(65_536),
  maxOperations: 32,
  maxBitmapWords: 4,
  maxClients: 4,
  maxPendingClientReplacements: 1,
  maxSessions: 4,
  maxSlotsPerSession: 4,
  maxReplayBytes: ByteSize.bytes(65_536),
  maxOpens: 8,
  maxLockOwners: 8,
  maxLocks: 32,
  maxOwnerBytes: ByteSize.bytes(1_024),
  maxReadBytes: ByteSize.bytes(4_096),
  maxWriteBytes: ByteSize.bytes(4_096),
  maxReaddirEntries: 32,
  maxReaddirReplyBytes: ByteSize.bytes(16_384),
  maxNameBytes: ByteSize.bytes(255)
}

export const EXPORT_LIMITS: ExportLimits = { maxNameBytes: ByteSize.bytes(255) }

export const HANDLER_OPTIONS: Nfs4Options = {
  leaseDurationSeconds: 30,
  callbackTimeout: "1 second",
  generation,
  now: () => 0,
  limits
}

/** What a test changes about the export. */
export interface ExportOverrides {
  readonly limits?: Partial<ExportLimits>
}

export interface HandlerOverrides extends Partial<Nfs4Options> {
  readonly export?: ExportOverrides
}

/** The export of the volume in context, read through `caller`. */
export const exportFor = Effect.fnUntraced(function*(caller: Vfs.Caller, overrides: ExportOverrides = {}) {
  const volume = yield* Vfs.Volume

  return makeExport(volume, caller, { ...EXPORT_LIMITS, ...overrides.limits })
})

export const handlerFor = (export_: NfsExport, overrides: Partial<Nfs4Options> = {}) =>
  makeNfs4Handler(export_, { ...HANDLER_OPTIONS, ...overrides })

/** The export over `caller` and the handler serving it. */
export const makeHandler = (caller: Vfs.Caller, { export: exportOverrides, ...overrides }: HandlerOverrides = {}) =>
  Effect.flatMap(exportFor(caller, exportOverrides), (export_) => handlerFor(export_, overrides))

/**
 * Distinct connections let a test exercise trunking without a socket. `onSend` receives anything
 * the server writes down this connection's backchannel; the default drops it and reports success,
 * which stands in for a client that never answers.
 */
export const connection = (
  id = 0,
  onSend: (message: Uint8Array) => boolean = () => true
): Connection => ({ id, send: (message) => Effect.succeed(onSend(message)) })

const defaultConnection = connection()

export type WriteOperation = (writer: EncoderSession) => Effect.Effect<void, XdrEncodeError>

export const call = (
  operations: ReadonlyArray<WriteOperation>,
  tag = "probe",
  on: Connection = defaultConnection,
  credentials: Credentials = { _tag: "None" }
) =>
  Effect.gen(function*() {
    const writer = yield* make.openWriter(limits, ByteSize.toNumberUnsafe(limits.maxCompoundBytes))
    yield* writer.write(XdrCodec.string(), tag)
    yield* writer.write(XdrCodec.uint32, 1)
    yield* writer.write(XdrCodec.uint32, operations.length)

    for (const operation of operations) yield* operation(writer)

    return { connection: on, credentials, arguments: yield* writer.finish }
  })

export const statuses = (response: Uint8Array) =>
  Effect.gen(function*() {
    const reader = yield* make.openReader(response, limits)
    const status = yield* reader.read(XdrCodec.uint32)
    const tag = yield* reader.read(XdrCodec.string())
    const count = yield* reader.read(XdrCodec.uint32)
    const operations: Array<readonly [number, number]> = []

    for (let index = 0; index < count; index++) {
      const code = yield* reader.read(XdrCodec.uint32)
      const operationStatus = yield* reader.read(XdrCodec.uint32)
      operations.push([code, operationStatus])

      if (operationStatus === Status.OK && code === Operation.GETFH) yield* reader.read(XdrCodec.opaque())

      if (operationStatus === Status.OK && code === Operation.SEQUENCE) {
        yield* reader.read(XdrCodec.fixedOpaque(16))

        for (let field = 0; field < 5; field++) yield* reader.read(XdrCodec.uint32)
      }
    }

    return { status, tag, operations }
  })

export const exchangeId = (owner: string, verifier = new Uint8Array(8)): WriteOperation => (writer) =>
  Effect.gen(function*() {
    yield* writer.write(XdrCodec.uint32, Operation.EXCHANGE_ID)
    yield* writer.write(XdrCodec.fixedOpaque(8), verifier)
    yield* writer.write(XdrCodec.string(), owner)
    yield* writer.write(XdrCodec.uint32, 0)
    yield* writer.write(XdrCodec.uint32, 0)
    yield* writer.write(XdrCodec.uint32, 0)
  })

export const channel = (
  writer: EncoderSession,
  slots: number,
  options: Partial<{
    readonly maxRequest: number
    readonly maxResponse: number
    readonly maxCachedResponse: number
    readonly maxOperations: number
  }> = {}
) =>
  Effect.gen(function*() {
    yield* writer.write(XdrCodec.uint32, 0)
    yield* writer.write(XdrCodec.uint32, options.maxRequest ?? 65_536)
    yield* writer.write(XdrCodec.uint32, options.maxResponse ?? 65_536)
    yield* writer.write(XdrCodec.uint32, options.maxCachedResponse ?? 65_536)
    yield* writer.write(XdrCodec.uint32, options.maxOperations ?? 32)
    yield* writer.write(XdrCodec.uint32, slots)
    yield* writer.write(XdrCodec.uint32, 0)
  })

export const authSysCallback = (writer: EncoderSession) =>
  Effect.gen(function*() {
    yield* writer.write(XdrCodec.uint32, 1)
    yield* writer.write(XdrCodec.uint32, 0x6aa6_6b2d)
    yield* writer.write(XdrCodec.string(), "Lloyds-Mech.local")
    yield* writer.write(XdrCodec.uint32, 0)
    yield* writer.write(XdrCodec.uint32, 0)
    yield* writer.write(XdrCodec.array(XdrCodec.uint32), Array.from({ length: 16 }, (_, index) => index))
  })

export const startSession = (
  handler: Nfs4Handler,
  owner: string,
  fore: Parameters<typeof channel>[2] = {},
  verifier = new Uint8Array(8),
  on: Connection = defaultConnection,
  /** Above zero, asks for CREATE_SESSION4_FLAG_CONN_BACK_CHAN and this many backchannel slots. */
  backSlots = 0,
  /** csa_sec_parms: the callback credentials the client authorizes. Defaults to AUTH_NONE. */
  security: WriteOperation = (writer) => writer.write(XdrCodec.array(XdrCodec.uint32), [0]),
  credentials: Credentials = { _tag: "None" }
) =>
  Effect.gen(function*() {
    const exchange = yield* make.openReader(
      yield* handler.compound(yield* call([exchangeId(owner, verifier)], "probe", on, credentials)),
      limits
    )

    assert.strictEqual(yield* exchange.read(XdrCodec.uint32), Status.OK)
    yield* exchange.read(XdrCodec.string())
    yield* exchange.read(XdrCodec.uint32)
    yield* exchange.read(XdrCodec.uint32)
    yield* exchange.read(XdrCodec.uint32)
    const client = yield* exchange.read(XdrCodec.uint64)

    const create = yield* handler.compound(
      yield* call(
        [(writer) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.CREATE_SESSION)
            yield* writer.write(XdrCodec.uint64, client)
            yield* writer.write(XdrCodec.uint32, 1)
            yield* writer.write(XdrCodec.uint32, backSlots > 0 ? 2 : 0)
            yield* channel(writer, 2, fore)
            yield* channel(writer, backSlots)
            yield* writer.write(XdrCodec.uint32, callbackProgram)
            yield* security(writer)
          })],
        "probe",
        on,
        credentials
      )
    )

    const response = yield* make.openReader(create, limits)
    assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.OK)
    yield* response.read(XdrCodec.string())
    yield* response.read(XdrCodec.uint32)
    yield* response.read(XdrCodec.uint32)
    yield* response.read(XdrCodec.uint32)

    return { client, session: yield* response.read(XdrCodec.fixedOpaque(16)) }
  })

export const sequence = (session: Uint8Array, sequence: number, cache = false, slot = 0): WriteOperation => (writer) =>
  Effect.gen(function*() {
    yield* writer.write(XdrCodec.uint32, Operation.SEQUENCE)
    yield* writer.write(XdrCodec.fixedOpaque(16), session)
    yield* writer.write(XdrCodec.uint32, sequence)
    yield* writer.write(XdrCodec.uint32, slot)
    yield* writer.write(XdrCodec.uint32, 1)
    yield* writer.write(XdrCodec.boolean, cache)
  })

export const openByName = (client: bigint, name: string, access = 1, deny = 0): WriteOperation => (writer) =>
  Effect.gen(function*() {
    yield* writer.write(XdrCodec.uint32, Operation.OPEN)
    yield* writer.write(XdrCodec.uint32, 0)
    yield* writer.write(XdrCodec.uint32, access)
    yield* writer.write(XdrCodec.uint32, deny)
    yield* writer.write(XdrCodec.uint64, client)
    yield* writer.write(XdrCodec.string(), "owner")
    yield* writer.write(XdrCodec.uint32, 0)
    yield* writer.write(XdrCodec.uint32, 0)
    yield* writer.write(XdrCodec.string(), name)
  })

export const openReadOnly = (client: bigint, name: string) => openByName(client, name)

export const parseOpen = (bytes: Uint8Array) =>
  Effect.gen(function*() {
    const reader = yield* make.openReader(bytes, limits)
    assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
    yield* reader.read(XdrCodec.string())
    yield* reader.read(XdrCodec.uint32)
    assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.SEQUENCE)
    assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
    yield* reader.read(XdrCodec.fixedOpaque(16))

    for (let field = 0; field < 5; field++) yield* reader.read(XdrCodec.uint32)
    assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.PUTROOTFH)
    assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
    assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.OPEN)
    assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
    const stateid = yield* reader.read(XdrCodec.fixedOpaque(16))
    const atomic = yield* reader.read(XdrCodec.boolean)
    yield* reader.read(XdrCodec.uint64)
    yield* reader.read(XdrCodec.uint64)
    yield* reader.read(XdrCodec.uint32)
    yield* reader.read(XdrCodec.array(XdrCodec.uint32))
    yield* reader.read(XdrCodec.uint32)
    assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.GETFH)
    assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)

    return { stateid, atomic, filehandle: yield* reader.read(XdrCodec.opaque()) }
  })

export const stateidWithSequence = (stateid: Uint8Array, sequence: number) => {
  const copy = new Uint8Array(stateid)
  new DataView(copy.buffer).setUint32(0, sequence)

  return copy
}

/** The export over `caller`, the handler serving it, and a confirmed session for `owner`. */
export const openSession = (caller: Vfs.Caller, owner: string, overrides: HandlerOverrides = {}) =>
  Effect.gen(function*() {
    const { export: exportOverrides, ...options } = overrides
    const export_ = yield* exportFor(caller, exportOverrides)
    const handler = yield* handlerFor(export_, options)

    return { export_, handler, ...(yield* startSession(handler, owner)) }
  })
