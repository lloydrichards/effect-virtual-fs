import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Scope } from "effect"
import * as ByteSize from "effect/ByteSize"
import { makeExport } from "../src/internal/export.js"
import {
  makeNfs4Handler,
  nextSequenceId,
  type Nfs4Handler,
  type Nfs4Limits,
  Operation,
  Status
} from "../src/internal/nfs4.js"
import { Reader, Writer } from "../src/internal/xdr.js"

const generation = new Uint8Array(16).fill(7)

const limits: Nfs4Limits = {
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
  maxOwnerBytes: ByteSize.bytes(1_024),
  maxReadBytes: ByteSize.bytes(4_096),
  maxWriteBytes: ByteSize.bytes(4_096),
  maxReaddirEntries: 32,
  maxReaddirReplyBytes: ByteSize.bytes(16_384),
  maxNameBytes: ByteSize.bytes(255)
}

const call = (operations: ReadonlyArray<(writer: Writer) => void>, tag = "probe") => {
  const writer = new Writer().string(tag).uint32(1).uint32(operations.length)

  for (const operation of operations) operation(writer)

  return { credentials: { _tag: "None" } as const, arguments: writer.bytes() }
}

const statuses = (response: Uint8Array) => {
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

const exchangeId = (owner: string, verifier = new Uint8Array(8)) => (writer: Writer) => {
  writer.uint32(Operation.EXCHANGE_ID).fixedOpaque(verifier).string(owner).uint32(0).uint32(0).uint32(0)
}

const channel = (
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

const authSysCallback = (writer: Writer) => {
  writer.uint32(1).uint32(0x6aa6_6b2d).string("Lloyds-Mech.local").uint32(0).uint32(0)
    .array(Array.from({ length: 16 }, (_, index) => index), (item, group) => item.uint32(group))
}

const startSession = (
  handler: Nfs4Handler,
  owner: string,
  fore: Parameters<typeof channel>[2] = {},
  verifier = new Uint8Array(8)
) =>
  Effect.gen(function*() {
    const exchange = new Reader(yield* handler.compound(call([exchangeId(owner, verifier)])), limits)
    assert.strictEqual(exchange.uint32(), Status.OK)
    exchange.string()
    exchange.uint32()
    exchange.uint32()
    exchange.uint32()
    const client = exchange.uint64()

    const create = yield* handler.compound(call([(writer) => {
      writer.uint32(Operation.CREATE_SESSION).uint64(client).uint32(1).uint32(0)
      channel(writer, 2, fore)
      channel(writer, 0)
      writer.uint32(0).uint32(0)
    }]))

    const response = new Reader(create, limits)
    assert.strictEqual(response.uint32(), Status.OK)
    response.string()
    response.uint32()
    response.uint32()
    response.uint32()

    return { client, session: response.fixedOpaque(16) }
  })

const sequence = (session: Uint8Array, sequence: number, cache = false, slot = 0) => (writer: Writer) =>
  writer.uint32(Operation.SEQUENCE).fixedOpaque(session).uint32(sequence).uint32(slot).uint32(1).boolean(cache)

const openByName = (client: bigint, name: string, access = 1, deny = 0) => (writer: Writer) =>
  writer.uint32(Operation.OPEN).uint32(0).uint32(access).uint32(deny).uint64(client).string("owner")
    .uint32(0).uint32(0).string(name)

const openReadOnly = (client: bigint, name: string) => openByName(client, name)

const parseOpen = (bytes: Uint8Array) => {
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

const stateidWithSequence = (stateid: Uint8Array, sequence: number) => {
  const copy = new Uint8Array(stateid)
  new DataView(copy.buffer).setUint32(0, sequence)

  return copy
}

describe("NFSv4.1 COMPOUND", () => {
  it("wraps client sequence IDs at the uint32 boundary", () => {
    assert.strictEqual(nextSequenceId(1), 2)
    assert.strictEqual(nextSequenceId(0xffff_ffff), 0)
  })

  it("uses the RFC wire numbers for negotiated channel errors", () => {
    assert.strictEqual(Status.REQ_TOO_BIG, 10065)
    assert.strictEqual(Status.REP_TOO_BIG, 10066)
    assert.strictEqual(Status.REP_TOO_BIG_TO_CACHE, 10067)
  })

  it.effect("echoes the tag, executes in order, and stops at a missing LOOKUP", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const export_ = makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) })
      const handler = yield* makeNfs4Handler(export_, { leaseDurationSeconds: 30, generation, now: () => 0, limits })
      const { session } = yield* startSession(handler, "missing-client")

      const response = yield* handler.compound(call([
        sequence(session, 1),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        (writer) => writer.uint32(Operation.LOOKUP).string("missing"),
        (writer) => writer.uint32(Operation.GETFH)
      ], "missing-probe"))

      assert.deepStrictEqual(statuses(response), {
        status: Status.NOENT,
        tag: "missing-probe",
        operations: [[Operation.SEQUENCE, Status.OK], [Operation.PUTROOTFH, Status.OK], [
          Operation.LOOKUP,
          Status.NOENT
        ]]
      })
    }))

  it.effect("saves and restores the current filehandle within a compound", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.fromFixture({
        entries: [{ kind: "file", path: "/child", bytes: new Uint8Array([1]) }]
      })

      const caller = yield* volume.caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      )

      const { session } = yield* startSession(handler, "saved-filehandle")

      const response = yield* handler.compound(call([
        sequence(session, 1),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        (writer) => writer.uint32(Operation.SAVEFH),
        (writer) => writer.uint32(Operation.LOOKUP).string("child"),
        (writer) => writer.uint32(Operation.RESTOREFH),
        (writer) => writer.uint32(Operation.LOOKUP).string("child")
      ]))

      assert.strictEqual(statuses(response).status, Status.OK)
    }))

  it.effect("advertises the client ID as a non-pNFS implementation", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      )

      const response = new Reader(yield* handler.compound(call([exchangeId("macos-client")])), limits)
      assert.strictEqual(response.uint32(), Status.OK)
      response.string()
      assert.strictEqual(response.uint32(), 1)
      assert.strictEqual(response.uint32(), Operation.EXCHANGE_ID)
      assert.strictEqual(response.uint32(), Status.OK)
      response.uint64()
      response.uint32()
      assert.strictEqual(response.uint32(), 0x0001_0000)
    }))

  it.effect("marks a repeated EXCHANGE_ID after CREATE_SESSION as confirmed", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      )

      const started = yield* startSession(handler, "confirmed-client")
      const response = new Reader(yield* handler.compound(call([exchangeId("confirmed-client")])), limits)
      assert.strictEqual(response.uint32(), Status.OK)
      response.string()
      response.uint32()
      response.uint32()
      response.uint32()
      assert.strictEqual(response.uint64(), started.client)
      response.uint32()
      assert.strictEqual(response.uint32(), 0x8001_0000)
    }))

  it.effect("applies confirmed-record EXCHANGE_ID update rules", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      )

      const update = (owner: string, verifier: Uint8Array) =>
        call([(writer) =>
          writer.uint32(Operation.EXCHANGE_ID).fixedOpaque(verifier).string(owner)
            .uint32(0x4000_0000).uint32(0).uint32(0)])

      assert.strictEqual(
        new Reader(yield* handler.compound(update("missing-update", new Uint8Array(8))), limits).uint32(),
        Status.NOENT
      )
      const verifier = new Uint8Array(8).fill(3)
      const started = yield* startSession(handler, "confirmed-update", {}, verifier)
      assert.strictEqual(
        new Reader(yield* handler.compound(update("confirmed-update", new Uint8Array(8).fill(4))), limits).uint32(),
        Status.NOT_SAME
      )
      assert.strictEqual(
        new Reader(
          yield* handler.compound(call([exchangeId("confirmed-update", new Uint8Array(8).fill(5))])),
          limits
        ).uint32(),
        Status.OK
      )
      const matching = new Reader(yield* handler.compound(update("confirmed-update", verifier)), limits)
      assert.strictEqual(matching.uint32(), Status.OK)
      matching.string()
      matching.uint32()
      matching.uint32()
      matching.uint32()
      assert.strictEqual(matching.uint64(), started.client)
    }))

  it.effect("rejects EXCHANGE_ID argument flags that are not valid for clients", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const constrained = { ...limits, maxClients: 1 }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits: constrained }
      )

      const invalid = call([(writer) =>
        writer.uint32(Operation.EXCHANGE_ID).fixedOpaque(new Uint8Array(8)).string("invalid-flags")
          .uint32(0x8000_0000).uint32(0).uint32(0)])

      assert.strictEqual(new Reader(yield* handler.compound(invalid), constrained).uint32(), Status.INVAL)

      const requestedNonPnfs = call([(writer) =>
        writer.uint32(Operation.EXCHANGE_ID).fixedOpaque(new Uint8Array(8)).string("valid-flags")
          .uint32(0x0001_0000).uint32(0).uint32(0)])

      assert.strictEqual(
        new Reader(yield* handler.compound(requestedNonPnfs), constrained).uint32(),
        Status.OK
      )
    }))

  it.effect("accepts the AUTH_SYS callback credential sent by macOS", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      )

      const exchange = new Reader(yield* handler.compound(call([exchangeId("macos-session")])), limits)
      exchange.uint32()
      exchange.string()
      exchange.uint32()
      exchange.uint32()
      exchange.uint32()
      const client = exchange.uint64()

      const response = yield* handler.compound(call([(writer) => {
        writer.uint32(Operation.CREATE_SESSION).uint64(client).uint32(1).uint32(2)
        channel(writer, 64)
        channel(writer, 4)
        writer.uint32(8_388_608).array([undefined], authSysCallback)
      }], "createsession"))

      const result = new Reader(response, limits)
      assert.strictEqual(result.uint32(), Status.OK)
      assert.strictEqual(result.string(), "createsession")
      assert.strictEqual(result.uint32(), 1)
      assert.strictEqual(result.uint32(), Operation.CREATE_SESSION)
      assert.strictEqual(result.uint32(), Status.OK)
      result.fixedOpaque(16)
      assert.strictEqual(result.uint32(), 1)
      assert.strictEqual(result.uint32(), 0)
      assert.deepStrictEqual(Array.from({ length: 6 }, () => result.uint32()), [0, 65_536, 65_536, 65_536, 32, 4])
      assert.deepStrictEqual(result.array((item) => item.uint32()), [])
      assert.deepStrictEqual(Array.from({ length: 6 }, () => result.uint32()), [0, 65_536, 65_536, 65_536, 32, 4])
      assert.deepStrictEqual(result.array((item) => item.uint32()), [])
      result.finish()
    }))

  it.effect("negotiates and enforces full RPC record bounds", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const constrained = { ...limits, maxRecordBytes: ByteSize.bytes(2_048) }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        {
          leaseDurationSeconds: 30,
          generation,
          now: () => 0,
          limits: constrained
        }
      )

      const exchange = new Reader(yield* handler.compound(call([exchangeId("rpc-bounds")])), limits)
      exchange.uint32()
      exchange.string()
      exchange.uint32()
      exchange.uint32()
      exchange.uint32()
      const client = exchange.uint64()

      const created = new Reader(
        yield* handler.compound(call([(writer) => {
          writer.uint32(Operation.CREATE_SESSION).uint64(client).uint32(1).uint32(0)
          channel(writer, 2)
          channel(writer, 0)
          writer.uint32(0).uint32(0)
        }])),
        limits
      )

      assert.strictEqual(created.uint32(), Status.OK)
      created.string()
      created.uint32()
      created.uint32()
      created.uint32()
      const session = created.fixedOpaque(16)
      created.uint32()
      created.uint32()
      assert.strictEqual(created.uint32(), 0)
      assert.strictEqual(created.uint32(), 2_048)
      assert.strictEqual(created.uint32(), 2_048)

      const oversized = { ...call([sequence(session, 1)]), requestBytes: 2_049 }
      assert.strictEqual(new Reader(yield* handler.compound(oversized), limits).uint32(), Status.REQ_TOO_BIG)
    }))

  it.effect("returns BADXDR before a malformed read-only mutation can report ROFS", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      )

      const malformed = new Writer().string("bad").uint32(1).uint32(1).uint32(Operation.WRITE).fixedOpaque(
        new Uint8Array(16)
      ).bytes()

      const reader = new Reader(
        yield* handler.compound({ credentials: { _tag: "None" }, arguments: malformed }),
        limits
      )

      assert.strictEqual(reader.uint32(), Status.BADXDR)
      assert.strictEqual(reader.string(), "bad")

      const { session } = yield* startSession(handler, "writer")

      const write = call([sequence(session, 1), (writer) =>
        writer.uint32(Operation.WRITE).fixedOpaque(new Uint8Array(16))
          .uint64(0n).uint32(0).opaque(new Uint8Array([1]))])

      assert.strictEqual(statuses(yield* handler.compound(write)).status, Status.ROFS)
    }))

  it.effect("rejects trailing compound bytes and unsupported minor versions", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      )

      const valid = call([]).arguments
      const trailing = new Uint8Array(valid.length + 4)
      trailing.set(valid)

      const malformed = new Reader(
        yield* handler.compound({ credentials: { _tag: "None" }, arguments: trailing }),
        limits
      )

      assert.strictEqual(malformed.uint32(), Status.BADXDR)

      const wrongMinor = new Writer().string("minor").uint32(0).uint32(0).bytes()

      const response = new Reader(
        yield* handler.compound({ credentials: { _tag: "None" }, arguments: wrongMinor }),
        limits
      )

      assert.strictEqual(response.uint32(), Status.MINOR_VERS_MISMATCH)
      assert.strictEqual(response.string(), "minor")
      assert.strictEqual(response.uint32(), 0)
    }))

  it.effect("creates bounded sessions and returns byte-identical cached slot replays", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      )

      const exchange = new Reader(yield* handler.compound(call([exchangeId("client")])), limits)
      assert.strictEqual(exchange.uint32(), Status.OK)
      exchange.string()
      exchange.uint32()
      exchange.uint32()
      exchange.uint32()
      const client = exchange.uint64()

      const create = yield* handler.compound(call([(writer) => {
        writer.uint32(Operation.CREATE_SESSION).uint64(client).uint32(1).uint32(0)
        channel(writer, 2)
        channel(writer, 0)
        writer.uint32(0).uint32(0)
      }]))

      const createReader = new Reader(create, limits)
      assert.strictEqual(createReader.uint32(), Status.OK)
      createReader.string()
      createReader.uint32()
      createReader.uint32()
      createReader.uint32()
      const session = createReader.fixedOpaque(16)

      const sequenced = call([
        (writer) => writer.uint32(Operation.SEQUENCE).fixedOpaque(session).uint32(1).uint32(0).uint32(1).boolean(true),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        (writer) => writer.uint32(Operation.GETFH)
      ], "replay")

      const first = yield* handler.compound(sequenced)
      const replay = yield* handler.compound(sequenced)
      assert.deepStrictEqual(replay, first)

      const highSlot = call([
        (writer) => writer.uint32(Operation.SEQUENCE).fixedOpaque(session).uint32(2).uint32(0).uint32(2).boolean(false)
      ])

      assert.strictEqual(new Reader(yield* handler.compound(highSlot), limits).uint32(), Status.BAD_HIGH_SLOT)
    }))

  it.effect("replays an identical CREATE_SESSION without allocating another session", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const constrained = { ...limits, maxSessions: 1 }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits: constrained }
      )

      const exchange = new Reader(yield* handler.compound(call([exchangeId("create-replay")])), limits)
      exchange.uint32()
      exchange.string()
      exchange.uint32()
      exchange.uint32()
      exchange.uint32()
      const client = exchange.uint64()

      const request = call([(writer) => {
        writer.uint32(Operation.CREATE_SESSION).uint64(client).uint32(1).uint32(0)
        channel(writer, 2)
        channel(writer, 0)
        writer.uint32(0).uint32(0)
      }], "create-replay")

      const first = yield* handler.compound(request)
      const replay = yield* handler.compound(request)
      assert.deepStrictEqual(replay, first)
      assert.strictEqual(new Reader(replay, limits).uint32(), Status.OK)

      const changedCredentials = {
        ...request,
        credentials: {
          _tag: "Sys" as const,
          stamp: 1,
          machineName: "localhost",
          uid: 501,
          gid: 20,
          supplementaryGroups: []
        }
      }

      assert.strictEqual(
        new Reader(yield* handler.compound(changedCredentials), limits).uint32(),
        Status.SEQ_MISORDERED
      )
      assert.deepStrictEqual(yield* handler.compound(request), first)
    }))

  it.effect("returns SEQUENCE OK before RETRY_UNCACHED_REP for an uncached replay", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      )

      const { session } = yield* startSession(handler, "uncached-replay")

      const request = call([
        sequence(session, 1),
        (writer) => writer.uint32(Operation.PUTROOTFH)
      ])

      assert.strictEqual(statuses(yield* handler.compound(request)).status, Status.OK)
      assert.deepStrictEqual(statuses(yield* handler.compound(request)).operations, [
        [Operation.SEQUENCE, Status.OK],
        [Operation.PUTROOTFH, Status.RETRY_UNCACHED_REP]
      ])
    }))

  it.effect("leaves a slot unchanged when SEQUENCE rejects an oversized cached reply", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const constrained = { ...limits, maxReplayBytes: ByteSize.bytes(512) }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits: constrained }
      )

      const { session } = yield* startSession(handler, "replay-budget", { maxCachedResponse: 64 })

      const rejected = call([
        sequence(session, 1, true),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        (writer) => writer.uint32(Operation.GETATTR).uint32(1).uint32(1)
      ])

      assert.strictEqual(
        new Reader(yield* handler.compound(rejected), limits).uint32(),
        Status.REP_TOO_BIG_TO_CACHE
      )
      const retry = call([sequence(session, 1)])
      assert.strictEqual(new Reader(yield* handler.compound(retry), limits).uint32(), Status.OK)
    }))

  it.effect("accepts small actual replies within a negotiated response channel", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      )

      const { session } = yield* startSession(handler, "small-response", { maxResponse: 128 })
      assert.strictEqual(
        new Reader(yield* handler.compound(call([sequence(session, 1)])), limits).uint32(),
        Status.OK
      )

      const { session: readdirSession } = yield* startSession(handler, "small-readdir-response", {
        maxResponse: 512
      })

      assert.strictEqual(
        new Reader(
          yield* handler.compound(call([
            sequence(readdirSession, 1),
            (writer) => writer.uint32(Operation.PUTROOTFH),
            (writer) =>
              writer.uint32(Operation.READDIR).uint64(0n).fixedOpaque(new Uint8Array(8))
                .uint32(0).uint32(32_768).uint32(0)
          ], "readdirplus ")),
          limits
        ).uint32(),
        Status.OK
      )
    }))

  it.effect("counts retained requests against the replay-memory budget", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const constrained = { ...limits, maxReplayBytes: ByteSize.bytes(512) }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits: constrained }
      )

      const { session } = yield* startSession(handler, "request-budget")

      const first = call([
        sequence(session, 1, false, 0),
        (writer) => writer.uint32(Operation.PUTROOTFH)
      ], "x".repeat(80))

      assert.strictEqual(new Reader(yield* handler.compound(first), limits).uint32(), Status.OK)

      const second = call([
        sequence(session, 1, false, 1),
        (writer) => writer.uint32(Operation.PUTROOTFH)
      ], "x".repeat(80))

      assert.strictEqual(new Reader(yield* handler.compound(second), limits).uint32(), Status.RESOURCE)
    }))

  it.effect("rejects a different request that reuses a cached slot sequence", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      )

      const { session } = yield* startSession(handler, "false-retry")
      yield* handler.compound(call([
        sequence(session, 1, true),
        (writer) => writer.uint32(Operation.PUTROOTFH)
      ]))

      const changed = call([
        sequence(session, 1, true),
        (writer) => writer.uint32(Operation.GETATTR).uint32(0)
      ])

      assert.strictEqual(new Reader(yield* handler.compound(changed), limits).uint32(), Status.SEQ_FALSE_RETRY)

      const changedCredentials = {
        ...call([
          sequence(session, 1, true),
          (writer) => writer.uint32(Operation.PUTROOTFH)
        ]),
        credentials: {
          _tag: "Sys" as const,
          stamp: 1,
          machineName: "localhost",
          uid: 501,
          gid: 20,
          supplementaryGroups: []
        }
      }

      assert.strictEqual(
        new Reader(yield* handler.compound(changedCredentials), limits).uint32(),
        Status.SEQ_FALSE_RETRY
      )
    }))

  it.effect("replaces a slot's cached reply without double-counting its old bytes", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const constrained = { ...limits, maxReplayBytes: ByteSize.bytes(1_024) }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits: constrained }
      )

      const { session } = yield* startSession(handler, "replace-replay")

      for (const sequenceId of Array.from({ length: 10 }, (_, index) => index + 1)) {
        const request = call([
          sequence(session, sequenceId, true),
          (writer) => writer.uint32(Operation.PUTROOTFH)
        ])

        const response = yield* handler.compound(request)
        assert.strictEqual(new Reader(response, constrained).uint32(), Status.OK)
        assert.deepStrictEqual(yield* handler.compound(request), response)
      }
    }))

  it.effect("revokes the prior client incarnation when its replacement creates a session", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const constrained = { ...limits, maxClients: 1, maxSessions: 1 }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits: constrained }
      )

      const first = yield* startSession(handler, "restarted-client")

      const exchange = new Reader(
        yield* handler.compound(call([exchangeId("restarted-client", new Uint8Array(8).fill(1))])),
        constrained
      )

      exchange.uint32()
      exchange.string()
      exchange.uint32()
      exchange.uint32()
      exchange.uint32()
      const replacement = exchange.uint64()

      const create = call([(writer) => {
        writer.uint32(Operation.CREATE_SESSION).uint64(replacement).uint32(1).uint32(0)
        channel(writer, 2)
        channel(writer, 0)
        writer.uint32(0).uint32(0)
      }])

      assert.strictEqual(new Reader(yield* handler.compound(create), constrained).uint32(), Status.OK)
      assert.strictEqual(
        new Reader(yield* handler.compound(call([sequence(first.session, 1)])), constrained).uint32(),
        Status.BADSESSION
      )
    }))

  it.effect("restores a confirmed predecessor after destroying an unconfirmed replacement", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const constrained = { ...limits, maxClients: 1 }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits: constrained }
      )

      const original = yield* startSession(handler, "abandoned-restart")

      const replacementResponse = new Reader(
        yield* handler.compound(call([exchangeId("abandoned-restart", new Uint8Array(8).fill(1))])),
        constrained
      )

      replacementResponse.uint32()
      replacementResponse.string()
      replacementResponse.uint32()
      replacementResponse.uint32()
      replacementResponse.uint32()
      const replacement = replacementResponse.uint64()
      assert.strictEqual(
        new Reader(
          yield* handler.compound(call([(writer) => writer.uint32(Operation.DESTROY_CLIENTID).uint64(replacement)])),
          constrained
        ).uint32(),
        Status.OK
      )
      assert.strictEqual(
        new Reader(
          yield* handler.compound(call([
            exchangeId("abandoned-restart", new Uint8Array(8).fill(2))
          ])),
          constrained
        ).uint32(),
        Status.OK
      )
      assert.strictEqual(
        new Reader(yield* handler.compound(call([sequence(original.session, 1)])), constrained).uint32(),
        Status.OK
      )
    }))

  it.effect("bounds pending client replacements separately from logical clients", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const constrained = { ...limits, maxClients: 2, maxPendingClientReplacements: 1 }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits: constrained }
      )

      yield* startSession(handler, "pending-a")
      yield* startSession(handler, "pending-b")

      const replacementA = new Reader(
        yield* handler.compound(call([exchangeId("pending-a", new Uint8Array(8).fill(1))])),
        constrained
      )

      replacementA.uint32()
      replacementA.string()
      replacementA.uint32()
      replacementA.uint32()
      replacementA.uint32()
      const replacementAId = replacementA.uint64()
      assert.strictEqual(
        new Reader(
          yield* handler.compound(call([exchangeId("pending-b", new Uint8Array(8).fill(1))])),
          constrained
        ).uint32(),
        Status.RESOURCE
      )
      assert.strictEqual(
        new Reader(
          yield* handler.compound(call([(writer) => writer.uint32(Operation.DESTROY_CLIENTID).uint64(replacementAId)])),
          constrained
        ).uint32(),
        Status.OK
      )
      assert.strictEqual(
        new Reader(
          yield* handler.compound(call([exchangeId("pending-b", new Uint8Array(8).fill(1))])),
          constrained
        ).uint32(),
        Status.OK
      )
    }))

  it.effect("requires DESTROY_SESSION for the active session to be the final operation", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      )

      const { session } = yield* startSession(handler, "destroy-order")

      const rejected = statuses(
        yield* handler.compound(call([
          sequence(session, 1, true),
          (writer) => writer.uint32(Operation.DESTROY_SESSION).fixedOpaque(session),
          (writer) => writer.uint32(Operation.PUTROOTFH)
        ]))
      )

      assert.strictEqual(rejected.status, Status.NOT_ONLY_OP)
      assert.deepStrictEqual(rejected.operations.at(-1), [Operation.DESTROY_SESSION, Status.NOT_ONLY_OP])
      assert.strictEqual(
        new Reader(yield* handler.compound(call([sequence(session, 2)])), limits).uint32(),
        Status.OK
      )
    }))

  it.effect("rejects an unsequenced non-final DESTROY_SESSION without removing the session", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      )

      const { session } = yield* startSession(handler, "unsequenced-destroy-order")
      assert.strictEqual(
        new Reader(
          yield* handler.compound(call([
            (writer) => writer.uint32(Operation.DESTROY_SESSION).fixedOpaque(session),
            (writer) => writer.uint32(Operation.PUTROOTFH)
          ])),
          limits
        ).uint32(),
        Status.NOT_ONLY_OP
      )
      assert.strictEqual(
        new Reader(yield* handler.compound(call([sequence(session, 1)])), limits).uint32(),
        Status.OK
      )
    }))

  it.effect("releases cached replay capacity when DESTROY_SESSION removes its session", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const constrained = { ...limits, maxClients: 8, maxSessions: 1, maxReplayBytes: ByteSize.bytes(1_024) }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits: constrained }
      )

      for (let index = 0; index < 4; index++) {
        const { session } = yield* startSession(handler, `destroy-cache-${index}`)
        assert.strictEqual(
          new Reader(
            yield* handler.compound(call([
              sequence(session, 1, true),
              (writer) => writer.uint32(Operation.PUTROOTFH)
            ])),
            constrained
          ).uint32(),
          Status.OK
        )
        assert.strictEqual(
          new Reader(
            yield* handler.compound(call([
              (writer) => writer.uint32(Operation.DESTROY_SESSION).fixedOpaque(session)
            ])),
            constrained
          ).uint32(),
          Status.OK
        )
      }

      const { session } = yield* startSession(handler, "after-destroy-cache")
      assert.strictEqual(
        new Reader(
          yield* handler.compound(call([
            sequence(session, 1, true),
            (writer) => writer.uint32(Operation.PUTROOTFH)
          ])),
          constrained
        ).uint32(),
        Status.OK
      )
    }))

  it.effect("serializes concurrent slot duplicates so OPEN runs exactly once", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const base = makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) })
      let opens = 0

      const export_ = {
        ...base,
        open: (reference: Vfs.ObjectReference) =>
          Effect.sync(() => opens++).pipe(Effect.andThen(Effect.yieldNow), Effect.andThen(base.open(reference)))
      }

      const handler = yield* makeNfs4Handler(export_, { leaseDurationSeconds: 30, generation, now: () => 0, limits })
      const { client, session } = yield* startSession(handler, "concurrent")

      const request = call([
        sequence(session, 1, true),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        openReadOnly(client, "file"),
        (writer) => writer.uint32(Operation.GETFH)
      ])

      const [first, duplicate] = yield* Effect.all([handler.compound(request), handler.compound(request)], {
        concurrency: "unbounded"
      })

      assert.deepStrictEqual(duplicate, first)
      assert.strictEqual(opens, 1)
    }))

  it.effect("reports read-only access and non-atomic name resolution for OPEN", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      )

      const client = yield* startSession(handler, "open-contract")

      const writeAccess = call([
        sequence(client.session, 1),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        openByName(client.client, "file", 2)
      ])

      assert.strictEqual(new Reader(yield* handler.compound(writeAccess), limits).uint32(), Status.ROFS)

      const denyRead = call([
        sequence(client.session, 2),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        openByName(client.client, "file", 1, 1)
      ])

      assert.strictEqual(new Reader(yield* handler.compound(denyRead), limits).uint32(), Status.OPENMODE)

      const opened = parseOpen(
        yield* handler.compound(call([
          sequence(client.session, 3),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openReadOnly(client.client, "file"),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      assert.isFalse(opened.atomic)
    }))

  it.effect("requires a first SEQUENCE and keeps another client from using an open stateid", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1, 2]), { access: "write", create: "exclusive" })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      )

      assert.strictEqual(
        statuses(yield* handler.compound(call([(writer) => writer.uint32(Operation.PUTROOTFH)]))).status,
        Status.OP_NOT_IN_SESSION
      )

      const misplaced = call([
        (writer) => writer.uint32(Operation.PUTROOTFH),
        sequence(new Uint8Array(16), 1)
      ])

      assert.strictEqual(new Reader(yield* handler.compound(misplaced), limits).uint32(), Status.SEQUENCE_POS)

      const a = yield* startSession(handler, "a")

      const opened = parseOpen(
        yield* handler.compound(call([
          sequence(a.session, 1, true),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openReadOnly(a.client, "file"),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      const b = yield* startSession(handler, "b")

      const stolenRead = call([
        sequence(b.session, 1),
        (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
        (writer) => writer.uint32(Operation.READ).fixedOpaque(opened.stateid).uint64(0n).uint32(2)
      ])

      assert.strictEqual(new Reader(yield* handler.compound(stolenRead), limits).uint32(), Status.BAD_STATEID)
    }))

  it.effect("reports EOF on an exact-boundary read and lets the owning session close", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1, 2]), { access: "write", create: "exclusive" })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      )

      const client = yield* startSession(handler, "reader")

      const opened = parseOpen(
        yield* handler.compound(call([
          sequence(client.session, 1, true),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openReadOnly(client.client, "file"),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      const read = new Reader(
        yield* handler.compound(call([
          sequence(client.session, 2),
          (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
          (writer) => writer.uint32(Operation.READ).fixedOpaque(opened.stateid).uint64(0n).uint32(2)
        ])),
        limits
      )

      assert.strictEqual(read.uint32(), Status.OK)
      read.string()
      read.uint32()
      read.uint32()
      read.uint32()
      read.fixedOpaque(16)

      for (let field = 0; field < 5; field++) read.uint32()
      read.uint32()
      read.uint32()
      assert.strictEqual(read.uint32(), Operation.READ)
      assert.strictEqual(read.uint32(), Status.OK)
      assert.isTrue(read.boolean())
      assert.deepStrictEqual(read.opaque(), new Uint8Array([1, 2]))

      const close = new Reader(
        yield* handler.compound(call([
          sequence(client.session, 3),
          (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
          (writer) => writer.uint32(Operation.CLOSE).uint32(0).fixedOpaque(opened.stateid)
        ])),
        limits
      )

      assert.strictEqual(close.uint32(), Status.OK)
      close.string()
      close.uint32()
      close.uint32()
      close.uint32()
      close.fixedOpaque(16)

      for (let field = 0; field < 5; field++) close.uint32()
      close.uint32()
      close.uint32()
      assert.strictEqual(close.uint32(), Operation.CLOSE)
      assert.strictEqual(close.uint32(), Status.OK)
      const closedStateid = close.fixedOpaque(16)
      assert.strictEqual(new DataView(closedStateid.buffer, closedStateid.byteOffset, 4).getUint32(0), 2)
      assert.deepStrictEqual(closedStateid.subarray(4), opened.stateid.subarray(4))
    }))

  it.effect("opens the current filehandle with the macOS CLAIM_FH sequence", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const export_ = makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) })
      const root = yield* caller.rootReference
      const reference = yield* caller.lookupReference(root, new TextEncoder().encode("file"))
      const filehandle = yield* export_.handleFor(reference)

      const handler = yield* makeNfs4Handler(export_, {
        leaseDurationSeconds: 30,
        generation,
        now: () => 0,
        limits
      })

      const client = yield* startSession(handler, "claim-fh")

      const response = yield* handler.compound(call([
        sequence(client.session, 1),
        (writer) => writer.uint32(Operation.PUTFH).opaque(filehandle),
        (writer) => writer.uint32(Operation.SAVEFH),
        (writer) => writer.uint32(Operation.RESTOREFH),
        (writer) =>
          writer.uint32(Operation.OPEN).uint32(0).uint32(1).uint32(0)
            .uint64(client.client).string("owner").uint32(0).uint32(4)
      ]))

      assert.strictEqual(new Reader(response, limits).uint32(), Status.OK)
    }))

  it.effect("serves metadata, access, directory entries, and symbolic-link targets", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      yield* caller.symlink("file", "/link")

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      )

      const client = yield* startSession(handler, "browser")
      const root = yield* caller.rootReference
      const directoryObservation = yield* caller.observeDirectory(root)

      const browse = call([
        sequence(client.session, 1),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        (writer) => writer.uint32(Operation.GETATTR).uint32(1).uint32((1 << 0) | (1 << 1) | (1 << 2)),
        (writer) => writer.uint32(Operation.ACCESS).uint32(3),
        (writer) =>
          writer.uint32(Operation.READDIR).uint64(0n).fixedOpaque(new Uint8Array(8))
            .uint32(4_096).uint32(4_096).uint32(1).uint32(1 << 1)
      ])

      const browseResponse = new Reader(yield* handler.compound(browse), limits)
      assert.strictEqual(browseResponse.uint32(), Status.OK)
      browseResponse.string()
      assert.strictEqual(browseResponse.uint32(), 5)

      assert.strictEqual(browseResponse.uint32(), Operation.SEQUENCE)
      assert.strictEqual(browseResponse.uint32(), Status.OK)
      browseResponse.fixedOpaque(16)

      for (let field = 0; field < 5; field++) browseResponse.uint32()
      assert.strictEqual(browseResponse.uint32(), Operation.PUTROOTFH)
      assert.strictEqual(browseResponse.uint32(), Status.OK)

      assert.strictEqual(browseResponse.uint32(), Operation.GETATTR)
      assert.strictEqual(browseResponse.uint32(), Status.OK)
      assert.deepStrictEqual(browseResponse.array((reader) => reader.uint32()), [7])
      const attributeValues = new Reader(browseResponse.opaque(), limits)
      assert.deepStrictEqual(attributeValues.array((reader) => reader.uint32()), [3759673343, 11575354, 2048])
      assert.strictEqual(attributeValues.uint32(), 2)
      assert.strictEqual(attributeValues.uint32(), 0x3)
      attributeValues.finish()

      assert.strictEqual(browseResponse.uint32(), Operation.ACCESS)
      assert.strictEqual(browseResponse.uint32(), Status.OK)
      assert.strictEqual(browseResponse.uint32(), 3)
      assert.strictEqual(browseResponse.uint32(), 3)

      assert.strictEqual(browseResponse.uint32(), Operation.READDIR)
      assert.strictEqual(browseResponse.uint32(), Status.OK)
      const expectedVerifier = generation.slice(0, 8)

      const expectedVerifierView = new DataView(
        expectedVerifier.buffer,
        expectedVerifier.byteOffset,
        expectedVerifier.byteLength
      )

      expectedVerifierView.setBigUint64(
        0,
        expectedVerifierView.getBigUint64(0) ^ BigInt.asUintN(64, directoryObservation.revision)
      )
      assert.deepStrictEqual(browseResponse.fixedOpaque(8), expectedVerifier)
      const entries: Array<{ readonly cookie: bigint; readonly name: string; readonly type: number }> = []

      while (browseResponse.boolean()) {
        const cookie = browseResponse.uint64()
        const name = browseResponse.string()
        assert.deepStrictEqual(browseResponse.array((reader) => reader.uint32()), [2])
        const values = new Reader(browseResponse.opaque(), limits)
        const type = values.uint32()
        values.finish()
        entries.push({ cookie, name, type })
      }

      assert.deepStrictEqual(entries, [
        { cookie: 3n, name: "file", type: 1 },
        { cookie: 4n, name: "link", type: 5 }
      ])
      assert.isTrue(browseResponse.boolean())
      browseResponse.finish()

      const link = new Reader(
        yield* handler.compound(call([
          sequence(client.session, 2),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          (writer) => writer.uint32(Operation.LOOKUP).string("link"),
          (writer) => writer.uint32(Operation.READLINK)
        ])),
        limits
      )

      assert.strictEqual(link.uint32(), Status.OK)
      link.string()
      link.uint32()
      link.uint32()
      link.uint32()
      link.fixedOpaque(16)

      for (let field = 0; field < 5; field++) link.uint32()
      link.uint32()
      link.uint32()
      link.uint32()
      link.uint32()
      assert.strictEqual(link.uint32(), Operation.READLINK)
      assert.strictEqual(link.uint32(), Status.OK)
      assert.strictEqual(link.string(), "file")
    }))

  it.effect("rejects stale filehandles during PUTFH", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const root = yield* caller.rootReference
      const reference = yield* caller.lookupReference(root, new TextEncoder().encode("file"))
      const export_ = makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) })
      const filehandle = yield* export_.handleFor(reference)

      const handler = yield* makeNfs4Handler(
        export_,
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      )

      const { session } = yield* startSession(handler, "stale-filehandle")
      yield* caller.unlink("/file")

      const response = yield* handler.compound(call([
        sequence(session, 1),
        (writer) => writer.uint32(Operation.PUTFH).opaque(filehandle)
      ]))

      assert.strictEqual(new Reader(response, limits).uint32(), Status.STALE)
    }))

  it.effect("bounds READLINK results before advancing beyond the negotiated reply budget", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.symlink("12345678901234567", "/link")
      const constrained = { ...limits, maxStringBytes: ByteSize.bytes(16) }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits: constrained }
      )

      const { session } = yield* startSession(handler, "link-bound")

      const response = yield* handler.compound(call([
        sequence(session, 1),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        (writer) => writer.uint32(Operation.LOOKUP).string("link"),
        (writer) => writer.uint32(Operation.READLINK)
      ], "link"))

      assert.strictEqual(new Reader(response, constrained).uint32(), Status.RESOURCE)
      assert.strictEqual(
        new Reader(yield* handler.compound(call([sequence(session, 2)], "next")), constrained).uint32(),
        Status.OK
      )
    }))

  it.effect("lists entries without allocating filehandles when no attributes are requested", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/a", new Uint8Array([1]), { access: "write", create: "exclusive" })
      yield* caller.writeFile("/b", new Uint8Array([2]), { access: "write", create: "exclusive" })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 1, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      )

      const { session } = yield* startSession(handler, "attribute-free-readdir")

      const response = yield* handler.compound(call([
        sequence(session, 1),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        (writer) =>
          writer.uint32(Operation.READDIR).uint64(0n).fixedOpaque(new Uint8Array(8))
            .uint32(4_096).uint32(4_096).uint32(0)
      ]))

      assert.strictEqual(new Reader(response, limits).uint32(), Status.OK)
    }))

  it.effect("continues READDIR from its cookie and rejects a stale verifier", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.fromFixture({
        entries: ["a", "b", "c"].map((path, index) => ({
          kind: "file" as const,
          path: `/${path}`,
          bytes: new Uint8Array([index])
        }))
      })

      const caller = yield* volume.caller()
      const constrained = { ...limits, maxReaddirEntries: 1 }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits: constrained }
      )

      const { session } = yield* startSession(handler, "pagination")

      const readPage = (sequenceId: number, cookie: bigint, verifier: Uint8Array) =>
        handler.compound(call([
          sequence(session, sequenceId),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          (writer) =>
            writer.uint32(Operation.READDIR).uint64(cookie).fixedOpaque(verifier)
              .uint32(4_096).uint32(4_096).uint32(1).uint32(1 << 1)
        ]))

      const parsePage = (response: Uint8Array) => {
        const reader = new Reader(response, constrained)
        assert.strictEqual(reader.uint32(), Status.OK)
        reader.string()
        reader.uint32()
        reader.uint32()
        reader.uint32()
        reader.fixedOpaque(16)

        for (let field = 0; field < 5; field++) reader.uint32()
        reader.uint32()
        reader.uint32()
        assert.strictEqual(reader.uint32(), Operation.READDIR)
        assert.strictEqual(reader.uint32(), Status.OK)
        const pageVerifier = reader.fixedOpaque(8)
        assert.isTrue(reader.boolean())
        const nextCookie = reader.uint64()
        const name = reader.string()
        reader.array((item) => item.uint32())
        reader.opaque()
        assert.isFalse(reader.boolean())
        const eof = reader.boolean()
        reader.finish()

        return { pageVerifier, nextCookie, name, eof }
      }

      const first = parsePage(yield* readPage(1, 0n, new Uint8Array(8)))
      assert.deepStrictEqual({ name: first.name, eof: first.eof }, { name: "a", eof: false })
      const second = parsePage(yield* readPage(2, first.nextCookie, first.pageVerifier))
      assert.deepStrictEqual({ name: second.name, eof: second.eof }, { name: "b", eof: false })

      const third = parsePage(yield* readPage(3, second.nextCookie, second.pageVerifier))
      assert.deepStrictEqual({ name: third.name, eof: third.eof }, { name: "c", eof: true })

      assert.strictEqual(
        new Reader(yield* readPage(4, 1n, third.pageVerifier), constrained).uint32(),
        Status.BAD_COOKIE
      )

      yield* caller.writeFile("/d", new Uint8Array([4]), { access: "write", create: "exclusive" })
      const stale = yield* readPage(5, third.nextCookie, third.pageVerifier)
      assert.strictEqual(new Reader(stale, constrained).uint32(), Status.NOT_SAME)
    }))

  it.effect("uses maxcount alone when READDIR dircount is zero", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      )

      const { session } = yield* startSession(handler, "zero-dircount")

      const response = yield* handler.compound(call([
        sequence(session, 1),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        (writer) =>
          writer.uint32(Operation.READDIR).uint64(0n).fixedOpaque(new Uint8Array(8))
            .uint32(0).uint32(4_096).uint32(1).uint32(1 << 1)
      ]))

      assert.strictEqual(new Reader(response, limits).uint32(), Status.OK)
    }))

  it.effect("rejects OPEN without read access without consuming open capacity", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const constrained = { ...limits, maxOpens: 1 }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits: constrained }
      )

      const { client, session } = yield* startSession(handler, "invalid-open-access")

      const invalid = yield* handler.compound(call([
        sequence(session, 1),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        (writer) =>
          writer.uint32(Operation.OPEN).uint32(0).uint32(0).uint32(0).uint64(client)
            .string("owner").uint32(0).uint32(0).string("file")
      ]))

      assert.strictEqual(new Reader(invalid, constrained).uint32(), Status.INVAL)
      parseOpen(
        yield* handler.compound(call([
          sequence(session, 2),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openReadOnly(client, "file"),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )
    }))

  it.effect("coalesces repeated OPEN state and validates stateid sequences", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const constrained = { ...limits, maxOpens: 1 }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits: constrained }
      )

      const { client, session } = yield* startSession(handler, "repeated-open")

      const first = parseOpen(
        yield* handler.compound(call([
          sequence(session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openReadOnly(client, "file"),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      assert.strictEqual(new DataView(first.stateid.buffer, first.stateid.byteOffset, 4).getUint32(0), 1)

      const second = parseOpen(
        yield* handler.compound(call([
          sequence(session, 2),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openReadOnly(client, "file"),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      assert.strictEqual(new DataView(second.stateid.buffer, second.stateid.byteOffset, 4).getUint32(0), 2)
      assert.deepStrictEqual(second.stateid.subarray(4), first.stateid.subarray(4))

      const readStatus = (requestSequence: number, stateid: Uint8Array) =>
        handler.compound(call([
          sequence(session, requestSequence),
          (writer) => writer.uint32(Operation.PUTFH).opaque(second.filehandle),
          (writer) => writer.uint32(Operation.READ).fixedOpaque(stateid).uint64(0n).uint32(1)
        ])).pipe(Effect.map((response) => new Reader(response, constrained).uint32()))

      assert.strictEqual(yield* readStatus(3, stateidWithSequence(second.stateid, 0)), Status.OK)
      assert.strictEqual(yield* readStatus(4, first.stateid), Status.OLD_STATEID)
      assert.strictEqual(yield* readStatus(5, stateidWithSequence(second.stateid, 3)), Status.BAD_STATEID)
    }))

  it.effect("supports anonymous and current-stateid READ forms", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      )

      const { client, session } = yield* startSession(handler, "special-stateids")
      const anonymous = new Uint8Array(16)
      const current = stateidWithSequence(anonymous, 1)
      assert.strictEqual(
        new Reader(
          yield* handler.compound(call([
            sequence(session, 1),
            (writer) => writer.uint32(Operation.PUTROOTFH),
            (writer) => writer.uint32(Operation.LOOKUP).string("file"),
            (writer) => writer.uint32(Operation.READ).fixedOpaque(anonymous).uint64(0n).uint32(1)
          ])),
          limits
        ).uint32(),
        Status.OK
      )
      assert.strictEqual(
        new Reader(
          yield* handler.compound(call([
            sequence(session, 2),
            (writer) => writer.uint32(Operation.PUTROOTFH),
            openReadOnly(client, "file"),
            (writer) => writer.uint32(Operation.READ).fixedOpaque(current).uint64(0n).uint32(1)
          ])),
          limits
        ).uint32(),
        Status.OK
      )
      assert.strictEqual(
        new Reader(
          yield* handler.compound(call([
            sequence(session, 3),
            (writer) => writer.uint32(Operation.PUTROOTFH),
            (writer) => writer.uint32(Operation.LOOKUP).string("file"),
            (writer) => writer.uint32(Operation.READ).fixedOpaque(current).uint64(0n).uint32(1)
          ])),
          limits
        ).uint32(),
        Status.BAD_STATEID
      )
      assert.strictEqual(
        new Reader(
          yield* handler.compound(call([
            sequence(session, 4),
            (writer) => writer.uint32(Operation.PUTROOTFH),
            (writer) => writer.uint32(Operation.LOOKUP).string("file"),
            (writer) =>
              writer.uint32(Operation.READ).fixedOpaque(anonymous).uint64(0n)
                .uint32(ByteSize.toNumberUnsafe(limits.maxReadBytes) + 1)
          ])),
          limits
        ).uint32(),
        Status.RESOURCE
      )
      assert.strictEqual(
        new Reader(
          yield* handler.compound(call([
            sequence(session, 5),
            (writer) => writer.uint32(Operation.PUTROOTFH),
            (writer) => writer.uint32(Operation.LOOKUP).string("file"),
            (writer) => writer.uint32(Operation.READ).fixedOpaque(new Uint8Array(16).fill(0xff)).uint64(0n).uint32(1)
          ])),
          limits
        ).uint32(),
        Status.OK
      )
    }))

  it.effect("enforces negotiated channel operation and cached-reply limits before advancing a slot", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const constrained = { ...limits, maxReplayBytes: ByteSize.bytes(580) }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits: constrained }
      )

      const operationsSession = yield* startSession(handler, "channel-operations", { maxOperations: 2 })
      assert.strictEqual(
        new Reader(
          yield* handler.compound(call([
            sequence(operationsSession.session, 1),
            (writer) => writer.uint32(Operation.PUTROOTFH),
            (writer) => writer.uint32(Operation.GETFH)
          ])),
          constrained
        ).uint32(),
        Status.TOO_MANY_OPS
      )

      const cachedSession = yield* startSession(handler, "channel-cache")

      const oversized = call([
        sequence(cachedSession.session, 1, true),
        (writer) => writer.uint32(Operation.PUTROOTFH)
      ], "x".repeat(520))

      assert.strictEqual(
        new Reader(yield* handler.compound(oversized), constrained).uint32(),
        Status.REP_TOO_BIG_TO_CACHE
      )
      assert.strictEqual(
        new Reader(yield* handler.compound(oversized), constrained).uint32(),
        Status.REP_TOO_BIG_TO_CACHE
      )
    }))

  it.effect("encodes every advertised GETATTR value from one file observation", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1, 2, 3]), { access: "write", create: "exclusive" })
      yield* caller.link("/file", "/alias")
      yield* caller.chmod("/file", 0o640)
      yield* caller.chown("/file", { uid: 501, gid: 20 })
      const export_ = makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) })
      const root = yield* caller.rootReference
      const reference = yield* caller.lookupReference(root, new TextEncoder().encode("file"))
      const observation = yield* caller.observeMetadata(reference)
      const expectedHandle = yield* export_.handleFor(reference)

      const handler = yield* makeNfs4Handler(export_, {
        leaseDurationSeconds: 30,
        generation,
        now: () => 0,
        limits
      })

      const { session } = yield* startSession(handler, "all-attributes")
      const requested = [3_759_673_343, 11_575_354, 2_048]

      const response = new Reader(
        yield* handler.compound(call([
          sequence(session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          (writer) => writer.uint32(Operation.LOOKUP).string("file"),
          (writer) => writer.uint32(Operation.GETATTR).array(requested, (item, word) => item.uint32(word))
        ])),
        limits
      )

      assert.strictEqual(response.uint32(), Status.OK)
      response.string()
      response.uint32()
      response.uint32()
      response.uint32()
      response.fixedOpaque(16)

      for (let field = 0; field < 5; field++) response.uint32()
      response.uint32()
      response.uint32()
      response.uint32()
      response.uint32()
      assert.strictEqual(response.uint32(), Operation.GETATTR)
      assert.strictEqual(response.uint32(), Status.OK)
      assert.deepStrictEqual(response.array((item) => item.uint32()), requested)
      const values = new Reader(response.opaque(), limits)
      assert.deepStrictEqual(values.array((item) => item.uint32()), requested)
      assert.strictEqual(values.uint32(), 1)
      assert.strictEqual(values.uint32(), 0x3)
      assert.strictEqual(values.uint64(), observation.revision)
      assert.strictEqual(values.uint64(), 3n)
      assert.isTrue(values.boolean())
      assert.isTrue(values.boolean())
      assert.isFalse(values.boolean())
      assert.deepStrictEqual([values.uint64(), values.uint64()], export_.fsid)
      assert.isTrue(values.boolean())
      assert.strictEqual(values.uint32(), 30)
      assert.strictEqual(values.uint32(), Status.OK)
      assert.deepStrictEqual(values.opaque(), expectedHandle)
      assert.strictEqual(values.uint64(), observation.value.ino)
      assert.strictEqual(values.uint32(), ByteSize.toNumberUnsafe(limits.maxNameBytes))
      assert.strictEqual(values.uint64(), BigInt(limits.maxReadBytes))
      assert.strictEqual(values.uint64(), BigInt(limits.maxWriteBytes))
      assert.strictEqual(values.uint32(), 0o640)
      assert.strictEqual(values.uint32(), 2)
      assert.strictEqual(values.string(), "501")
      assert.strictEqual(values.string(), "20")
      assert.strictEqual(values.uint64(), 3n)

      for (
        const timestamp of [
          observation.value.atimeNs,
          observation.value.ctimeNs,
          observation.value.mtimeNs
        ]
      ) {
        assert.strictEqual(values.uint64(), timestamp / 1_000_000_000n)
        assert.strictEqual(values.uint32(), Number(timestamp % 1_000_000_000n))
      }

      assert.strictEqual(values.uint64(), observation.value.ino)
      assert.deepStrictEqual(values.array((item) => item.uint32()), [])
      values.finish()
      response.finish()
    }))

  it.effect("normalizes negative timestamps and rejects seconds outside the NFS int64 range", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      yield* caller.utimes("/file", {
        access: { kind: "value", nanoseconds: -500_000_000n },
        modification: { kind: "omit" }
      })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      )

      const { session } = yield* startSession(handler, "timestamp-bounds")

      const getattr = (sequenceId: number) =>
        handler.compound(call([
          sequence(session, sequenceId),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          (writer) => writer.uint32(Operation.LOOKUP).string("file"),
          (writer) => writer.uint32(Operation.GETATTR).array([0, 1 << 15], (item, word) => item.uint32(word))
        ]))

      const response = new Reader(yield* getattr(1), limits)
      assert.strictEqual(response.uint32(), Status.OK)
      response.string()
      response.uint32()
      response.uint32()
      response.uint32()
      response.fixedOpaque(16)

      for (let field = 0; field < 5; field++) response.uint32()

      for (let operation = 0; operation < 2; operation++) {
        response.uint32()
        response.uint32()
      }

      assert.strictEqual(response.uint32(), Operation.GETATTR)
      assert.strictEqual(response.uint32(), Status.OK)
      assert.deepStrictEqual(response.array((item) => item.uint32()), [0, 1 << 15])
      const values = new Reader(response.opaque(), limits)
      assert.strictEqual(values.uint64(), 0xffff_ffff_ffff_ffffn)
      assert.strictEqual(values.uint32(), 500_000_000)
      values.finish()
      response.finish()

      yield* caller.utimes("/file", {
        access: { kind: "value", nanoseconds: 0x8000_0000_0000_0000n * 1_000_000_000n },
        modification: { kind: "omit" }
      })
      assert.strictEqual(new Reader(yield* getattr(2), limits).uint32(), Status.SERVERFAULT)
    }))

  it.effect("reads successive offsets and reports EOF only at the file boundary", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6])
      yield* caller.writeFile("/file", bytes, { access: "write", create: "exclusive" })
      const constrained = { ...limits, maxReadBytes: ByteSize.bytes(3) }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits: constrained }
      )

      const client = yield* startSession(handler, "offset-reader")

      const opened = parseOpen(
        yield* handler.compound(call([
          sequence(client.session, 1, true),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openReadOnly(client.client, "file"),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      const read = (sequenceId: number, offset: bigint, count: number) =>
        handler.compound(call([
          sequence(client.session, sequenceId),
          (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
          (writer) => writer.uint32(Operation.READ).fixedOpaque(opened.stateid).uint64(offset).uint32(count)
        ]))

      const parse = (response: Uint8Array) => {
        const reader = new Reader(response, constrained)
        const result = statuses(response)

        if (result.status !== Status.OK) return { status: result.status } as const
        reader.uint32()
        reader.string()
        reader.uint32()
        reader.uint32()
        reader.uint32()
        reader.fixedOpaque(16)

        for (let field = 0; field < 5; field++) reader.uint32()
        reader.uint32()
        reader.uint32()
        reader.uint32()
        reader.uint32()

        return { status: Status.OK, eof: reader.boolean(), bytes: reader.opaque() } as const
      }

      assert.deepStrictEqual(parse(yield* read(2, 0n, 3)), {
        status: Status.OK,
        eof: false,
        bytes: new Uint8Array([0, 1, 2])
      })
      assert.deepStrictEqual(parse(yield* read(3, 3n, 3)), {
        status: Status.OK,
        eof: false,
        bytes: new Uint8Array([3, 4, 5])
      })
      assert.deepStrictEqual(parse(yield* read(4, 6n, 3)), {
        status: Status.OK,
        eof: true,
        bytes: new Uint8Array([6])
      })
      assert.deepStrictEqual(parse(yield* read(5, 20n, 3)), {
        status: Status.OK,
        eof: true,
        bytes: new Uint8Array()
      })
      assert.strictEqual(parse(yield* read(6, 0n, 4)).status, Status.RESOURCE)
    }))

  it.effect("rejects every decoded mutation as read-only without changing the volume", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const original = new Uint8Array([1, 2, 3])
      yield* caller.writeFile("/file", original, { access: "write", create: "exclusive" })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      )

      const client = yield* startSession(handler, "mutations")

      const mutations: ReadonlyArray<{
        readonly setup?: (writer: Writer) => void
        readonly operation: (writer: Writer) => void
      }> = [
        {
          setup: (writer) => writer.uint32(Operation.LOOKUP).string("file"),
          operation: (writer) =>
            writer.uint32(Operation.SETATTR).fixedOpaque(new Uint8Array(16))
              .uint32(1).uint32(1 << 12).opaque(new Uint8Array())
        },
        {
          setup: (writer) => writer.uint32(Operation.LOOKUP).string("file"),
          operation: (writer) =>
            writer.uint32(Operation.WRITE).fixedOpaque(new Uint8Array(16))
              .uint64(0n).uint32(0).opaque(new Uint8Array([9]))
        },
        {
          operation: (writer) =>
            writer.uint32(Operation.CREATE).uint32(2).string("created").uint32(0).opaque(new Uint8Array())
        },
        { operation: (writer) => writer.uint32(Operation.REMOVE).string("file") },
        { operation: (writer) => writer.uint32(Operation.RENAME).string("file").string("renamed") },
        { operation: (writer) => writer.uint32(Operation.LINK).string("linked") }
      ]

      for (let index = 0; index < mutations.length; index++) {
        const mutation = mutations[index]!

        const response = yield* handler.compound(call([
          sequence(client.session, index + 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          ...(mutation.setup === undefined ? [] : [mutation.setup]),
          mutation.operation
        ]))

        assert.strictEqual(new Reader(response, limits).uint32(), Status.ROFS)
      }

      assert.deepStrictEqual(yield* caller.readFile("/file"), original)

      for (const path of ["/created", "/renamed", "/linked"]) {
        assert.strictEqual((yield* Effect.flip(caller.stat(path))).code, "NotFound")
      }
    }))

  it.effect("sweeps expired clients before applying capacity limits and closes their opens", () =>
    Effect.gen(function*() {
      let now = 0
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const root = yield* caller.rootReference
      const reference = yield* caller.lookupReference(root, new TextEncoder().encode("file"))
      const constrained = { ...limits, maxClients: 1, maxSessions: 1, maxOpens: 1 }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 1, generation, now: () => now, limits: constrained }
      )

      const first = yield* startSession(handler, "expires")
      parseOpen(
        yield* handler.compound(call([
          sequence(first.session, 1, true),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openReadOnly(first.client, "file"),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )
      yield* caller.unlink("/file")
      assert.strictEqual((yield* caller.observeMetadata(reference)).value.nlink, 0)
      now = 1_001
      yield* startSession(handler, "replacement")
      assert.strictEqual((yield* Effect.flip(caller.observeMetadata(reference))).code, "StaleReference")
    }))

  it.effect("closes remaining opens when the handler scope closes", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const root = yield* caller.rootReference
      const reference = yield* caller.lookupReference(root, new TextEncoder().encode("file"))
      const scope = yield* Scope.make()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      ).pipe(Effect.provideService(Scope.Scope, scope))

      const client = yield* startSession(handler, "handler-finalizer")
      parseOpen(
        yield* handler.compound(call([
          sequence(client.session, 1, true),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openReadOnly(client.client, "file"),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )
      yield* caller.unlink("/file")
      assert.strictEqual((yield* caller.observeMetadata(reference)).value.nlink, 0)
      yield* Scope.close(scope, Exit.void)
      assert.strictEqual((yield* Effect.flip(caller.observeMetadata(reference))).code, "StaleReference")
    }))

  it.effect("reuses session and open capacity after explicit teardown", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const constrained = { ...limits, maxSessions: 1, maxOpens: 1 }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits: constrained }
      )

      const first = yield* startSession(handler, "first-capacity")

      const secondExchange = new Reader(
        yield* handler.compound(call([exchangeId("second-capacity")])),
        constrained
      )

      secondExchange.uint32()
      secondExchange.string()
      secondExchange.uint32()
      secondExchange.uint32()
      secondExchange.uint32()
      const secondClient = secondExchange.uint64()

      const createSecond = (sequenceId: number) =>
        call([(writer) => {
          writer.uint32(Operation.CREATE_SESSION).uint64(secondClient).uint32(sequenceId).uint32(0)
          channel(writer, 2)
          channel(writer, 0)
          writer.uint32(0).uint32(0)
        }])

      const failedCreate = createSecond(1)
      assert.strictEqual(new Reader(yield* handler.compound(failedCreate), constrained).uint32(), Status.RESOURCE)
      assert.strictEqual(
        new Reader(
          yield* handler.compound(
            call([(writer) => writer.uint32(Operation.DESTROY_SESSION).fixedOpaque(first.session)])
          ),
          constrained
        ).uint32(),
        Status.OK
      )
      assert.strictEqual(new Reader(yield* handler.compound(failedCreate), constrained).uint32(), Status.RESOURCE)
      const created = new Reader(yield* handler.compound(createSecond(2)), constrained)
      assert.strictEqual(created.uint32(), Status.OK)
      created.string()
      created.uint32()
      created.uint32()
      created.uint32()
      const secondSession = created.fixedOpaque(16)

      const opened = parseOpen(
        yield* handler.compound(call([
          sequence(secondSession, 1, true),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openReadOnly(secondClient, "file"),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      const full = call([
        sequence(secondSession, 2),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        (writer) =>
          writer.uint32(Operation.OPEN).uint32(0).uint32(1).uint32(0).uint64(secondClient).string("other-owner")
            .uint32(0).uint32(0).string("file")
      ])

      assert.strictEqual(new Reader(yield* handler.compound(full), constrained).uint32(), Status.RESOURCE)
      assert.strictEqual(
        new Reader(
          yield* handler.compound(call([
            sequence(secondSession, 3),
            (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
            (writer) => writer.uint32(Operation.CLOSE).uint32(0).fixedOpaque(opened.stateid)
          ])),
          constrained
        ).uint32(),
        Status.OK
      )
      assert.strictEqual(
        new Reader(
          yield* handler.compound(call([
            sequence(secondSession, 4),
            (writer) => writer.uint32(Operation.PUTROOTFH),
            openReadOnly(secondClient, "file")
          ])),
          constrained
        ).uint32(),
        Status.OK
      )
    }))

  it.effect("keeps a client busy until its open and session are destroyed", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const root = yield* caller.rootReference
      const reference = yield* caller.lookupReference(root, new TextEncoder().encode("file"))

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      )

      const client = yield* startSession(handler, "destroy-client")

      const opened = parseOpen(
        yield* handler.compound(call([
          sequence(client.session, 1, true),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openReadOnly(client.client, "file"),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      assert.strictEqual(
        new Reader(
          yield* handler.compound(call([
            sequence(client.session, 2),
            (writer) => writer.uint32(Operation.RECLAIM_COMPLETE).boolean(false)
          ])),
          limits
        ).uint32(),
        Status.OK
      )
      assert.strictEqual(
        new Reader(
          yield* handler.compound(call([
            sequence(client.session, 3),
            (writer) => writer.uint32(Operation.RECLAIM_COMPLETE).boolean(false)
          ])),
          limits
        ).uint32(),
        Status.COMPLETE_ALREADY
      )
      yield* caller.unlink("/file")
      assert.strictEqual((yield* caller.observeMetadata(reference)).value.nlink, 0)
      assert.strictEqual(
        new Reader(
          yield* handler.compound(call([(writer) => writer.uint32(Operation.DESTROY_CLIENTID).uint64(client.client)])),
          limits
        ).uint32(),
        Status.CLIENTID_BUSY
      )

      const sequencedDestroy = call([
        sequence(client.session, 4, true),
        (writer) => writer.uint32(Operation.DESTROY_CLIENTID).uint64(client.client)
      ])

      const firstBusy = yield* handler.compound(sequencedDestroy)
      assert.strictEqual(new Reader(firstBusy, limits).uint32(), Status.CLIENTID_BUSY)
      assert.deepStrictEqual(yield* handler.compound(sequencedDestroy), firstBusy)
      assert.strictEqual(
        new Reader(
          yield* handler.compound(call([
            sequence(client.session, 5),
            (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
            (writer) => writer.uint32(Operation.CLOSE).uint32(0).fixedOpaque(opened.stateid)
          ])),
          limits
        ).uint32(),
        Status.OK
      )
      assert.strictEqual(
        new Reader(
          yield* handler.compound(
            call([(writer) => writer.uint32(Operation.DESTROY_SESSION).fixedOpaque(client.session)])
          ),
          limits
        ).uint32(),
        Status.OK
      )
      assert.strictEqual(
        new Reader(
          yield* handler.compound(call([(writer) => writer.uint32(Operation.DESTROY_CLIENTID).uint64(client.client)])),
          limits
        ).uint32(),
        Status.OK
      )
      assert.strictEqual((yield* Effect.flip(caller.observeMetadata(reference))).code, "StaleReference")
      assert.strictEqual(
        new Reader(yield* handler.compound(call([sequence(client.session, 6)])), limits).uint32(),
        Status.BADSESSION
      )
    }))

  it.effect("preserves prior results before an unknown operation and structurally validates mutation attrs", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, generation, now: () => 0, limits }
      )

      const client = yield* startSession(handler, "decode")

      const unknown = call([
        sequence(client.session, 1),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        (writer) => writer.uint32(99_999).uint32(0xdeadbeef)
      ])

      const unknownResult = statuses(yield* handler.compound(unknown))
      assert.strictEqual(unknownResult.status, Status.OP_ILLEGAL)
      assert.deepStrictEqual(unknownResult.operations.at(-1), [Operation.ILLEGAL, Status.OP_ILLEGAL])

      const malformed = call([
        sequence(client.session, 2),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        (writer) =>
          writer.uint32(Operation.SETATTR).fixedOpaque(new Uint8Array(16))
            .uint32(2).uint32(0).uint32(1 << 1).opaque(new Uint8Array())
      ])

      assert.strictEqual(new Reader(yield* handler.compound(malformed), limits).uint32(), Status.BADXDR)
    }))
})
