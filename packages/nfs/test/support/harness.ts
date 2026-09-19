import { assert } from "@effect/vitest"
import { Effect } from "effect"
import * as ByteSize from "effect/ByteSize"
import { type Nfs4Handler, type Nfs4Limits, Operation, Status } from "../../src/internal/nfs4.js"
import type { Connection, Credentials } from "../../src/internal/rpc.js"
import { Reader, Writer } from "../../src/internal/xdr.js"

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

export const call = (
  operations: ReadonlyArray<(writer: Writer) => void>,
  tag = "probe",
  on: Connection = defaultConnection,
  credentials: Credentials = { _tag: "None" }
) => {
  const writer = new Writer().string(tag).uint32(1).uint32(operations.length)

  for (const operation of operations) operation(writer)

  return { connection: on, credentials, arguments: writer.bytes() }
}

export const statuses = (response: Uint8Array) => {
  const reader = new Reader(response, limits)
  const status = reader.uint32()
  const tag = reader.string()
  const count = reader.uint32()
  const operations: Array<readonly [number, number]> = []

  for (let index = 0; index < count; index++) {
    const code = reader.uint32()
    const operationStatus = reader.uint32()
    operations.push([code, operationStatus])

    if (operationStatus === Status.OK && code === Operation.GETFH) reader.opaque()

    if (operationStatus === Status.OK && code === Operation.SEQUENCE) {
      reader.fixedOpaque(16)

      for (let field = 0; field < 5; field++) reader.uint32()
    }
  }

  return { status, tag, operations }
}

export const exchangeId = (owner: string, verifier = new Uint8Array(8)) => (writer: Writer) => {
  writer.uint32(Operation.EXCHANGE_ID).fixedOpaque(verifier).string(owner).uint32(0).uint32(0).uint32(0)
}

export const channel = (
  writer: Writer,
  slots: number,
  options: Partial<{
    readonly maxRequest: number
    readonly maxResponse: number
    readonly maxCachedResponse: number
    readonly maxOperations: number
  }> = {}
) => {
  writer.uint32(0).uint32(options.maxRequest ?? 65_536).uint32(options.maxResponse ?? 65_536)
    .uint32(options.maxCachedResponse ?? 65_536).uint32(options.maxOperations ?? 32).uint32(slots).uint32(0)
}

export const authSysCallback = (writer: Writer) => {
  writer.uint32(1).uint32(0x6aa6_6b2d).string("Lloyds-Mech.local").uint32(0).uint32(0)
    .array(Array.from({ length: 16 }, (_, index) => index), (item, group) => item.uint32(group))
}

export const startSession = (
  handler: Nfs4Handler,
  owner: string,
  fore: Parameters<typeof channel>[2] = {},
  verifier = new Uint8Array(8),
  on: Connection = defaultConnection,
  /** Above zero, asks for CREATE_SESSION4_FLAG_CONN_BACK_CHAN and this many backchannel slots. */
  backSlots = 0,
  /** csa_sec_parms: the callback credentials the client authorizes. Defaults to AUTH_NONE. */
  security: (writer: Writer) => void = (writer) => writer.array([0], (item, flavor) => item.uint32(flavor)),
  credentials: Credentials = { _tag: "None" }
) =>
  Effect.gen(function*() {
    const exchange = new Reader(
      yield* handler.compound(call([exchangeId(owner, verifier)], "probe", on, credentials)),
      limits
    )

    assert.strictEqual(exchange.uint32(), Status.OK)
    exchange.string()
    exchange.uint32()
    exchange.uint32()
    exchange.uint32()
    const client = exchange.uint64()

    const create = yield* handler.compound(call(
      [(writer) => {
        writer.uint32(Operation.CREATE_SESSION).uint64(client).uint32(1).uint32(backSlots > 0 ? 2 : 0)
        channel(writer, 2, fore)
        channel(writer, backSlots)
        writer.uint32(callbackProgram)
        security(writer)
      }],
      "probe",
      on,
      credentials
    ))

    const response = new Reader(create, limits)
    assert.strictEqual(response.uint32(), Status.OK)
    response.string()
    response.uint32()
    response.uint32()
    response.uint32()

    return { client, session: response.fixedOpaque(16) }
  })

export const sequence = (session: Uint8Array, sequence: number, cache = false, slot = 0) => (writer: Writer) =>
  writer.uint32(Operation.SEQUENCE).fixedOpaque(session).uint32(sequence).uint32(slot).uint32(1).boolean(cache)

export const openByName = (client: bigint, name: string, access = 1, deny = 0) => (writer: Writer) =>
  writer.uint32(Operation.OPEN).uint32(0).uint32(access).uint32(deny).uint64(client).string("owner")
    .uint32(0).uint32(0).string(name)

export const openReadOnly = (client: bigint, name: string) => openByName(client, name)

export const parseOpen = (bytes: Uint8Array) => {
  const reader = new Reader(bytes, limits)
  assert.strictEqual(reader.uint32(), Status.OK)
  reader.string()
  reader.uint32()
  assert.strictEqual(reader.uint32(), Operation.SEQUENCE)
  assert.strictEqual(reader.uint32(), Status.OK)
  reader.fixedOpaque(16)

  for (let field = 0; field < 5; field++) reader.uint32()
  assert.strictEqual(reader.uint32(), Operation.PUTROOTFH)
  assert.strictEqual(reader.uint32(), Status.OK)
  assert.strictEqual(reader.uint32(), Operation.OPEN)
  assert.strictEqual(reader.uint32(), Status.OK)
  const stateid = reader.fixedOpaque(16)
  const atomic = reader.boolean()
  reader.uint64()
  reader.uint64()
  reader.uint32()
  reader.array((item) => item.uint32())
  reader.uint32()
  assert.strictEqual(reader.uint32(), Operation.GETFH)
  assert.strictEqual(reader.uint32(), Status.OK)

  return { stateid, atomic, filehandle: reader.opaque() }
}

export const stateidWithSequence = (stateid: Uint8Array, sequence: number) => {
  const copy = new Uint8Array(stateid)
  new DataView(copy.buffer).setUint32(0, sequence)

  return copy
}
