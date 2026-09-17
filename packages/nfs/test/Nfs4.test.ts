import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Option, Scope } from "effect"
import * as ByteSize from "effect/ByteSize"
import type * as Duration from "effect/Duration"
import * as TestClock from "effect/testing/TestClock"
import { makeExport } from "../src/internal/export.js"
import { makeNfs4Handler, nextSequenceId, Operation, Status } from "../src/internal/nfs4.js"
import { Reader, Writer } from "../src/internal/xdr.js"

import {
  authSysCallback,
  call,
  callbackProgram,
  channel,
  connection,
  exchangeId,
  generation,
  limits,
  openByName,
  openReadOnly,
  parseOpen,
  sequence,
  startSession,
  stateidWithSequence,
  statuses
} from "./support/harness.js"

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

      const handler = yield* makeNfs4Handler(export_, {
        leaseDurationSeconds: 30,
        callbackTimeout: "1 second",
        generation,
        now: () => 0,
        limits
      })

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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits: constrained }
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
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

      // csa_flags asked for CONN_BACK_CHAN, so csr_flags must echo it: the client binds the
      // connection to the backchannel on the strength of this echo (Section 18.36.3).
      assert.strictEqual(result.uint32(), 2)
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
          callbackTimeout: "1 second",
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
      )

      const malformed = new Writer().string("bad").uint32(1).uint32(1).uint32(Operation.WRITE).fixedOpaque(
        new Uint8Array(16)
      ).bytes()

      const reader = new Reader(
        yield* handler.compound({ connection: connection(), credentials: { _tag: "None" }, arguments: malformed }),
        limits
      )

      assert.strictEqual(reader.uint32(), Status.BADXDR)
      assert.strictEqual(reader.string(), "bad")

      const { session } = yield* startSession(handler, "writer")

      const write = call([sequence(session, 1), (writer) =>
        writer.uint32(Operation.PUTROOTFH), (writer) =>
        writer.uint32(Operation.WRITE).fixedOpaque(new Uint8Array(16))
          .uint64(0n).uint32(0).opaque(new Uint8Array([1]))])

      assert.strictEqual(statuses(yield* handler.compound(write)).status, Status.ROFS)
    }))

  it.effect("rejects trailing compound bytes and unsupported minor versions", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
      )

      const valid = call([]).arguments
      const trailing = new Uint8Array(valid.length + 4)
      trailing.set(valid)

      const malformed = new Reader(
        yield* handler.compound({ connection: connection(), credentials: { _tag: "None" }, arguments: trailing }),
        limits
      )

      assert.strictEqual(malformed.uint32(), Status.BADXDR)

      const wrongMinor = new Writer().string("minor").uint32(0).uint32(0).bytes()

      const response = new Reader(
        yield* handler.compound({ connection: connection(), credentials: { _tag: "None" }, arguments: wrongMinor }),
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits: constrained }
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

      // RFC 8881 Section 18.36.4 phase 2: an equal csa_sequence is a replay regardless of principal.
      assert.deepStrictEqual(yield* handler.compound(changedCredentials), first)
      assert.deepStrictEqual(yield* handler.compound(request), first)
    }))

  it.effect("returns SEQUENCE OK before RETRY_UNCACHED_REP for an uncached replay", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits: constrained }
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits: constrained }
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

      assert.strictEqual(new Reader(yield* handler.compound(second), limits).uint32(), Status.DELAY)
    }))

  it.effect("rejects a different request that reuses a cached slot sequence", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits: constrained }
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits: constrained }
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits: constrained }
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits: constrained }
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
        Status.DELAY
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits: constrained }
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

      const handler = yield* makeNfs4Handler(export_, {
        leaseDurationSeconds: 30,
        callbackTimeout: "1 second",
        generation,
        now: () => 0,
        limits
      })

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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
      )

      const client = yield* startSession(handler, "open-contract")

      const writeAccess = call([
        sequence(client.session, 1),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        openByName(client.client, "file", 2)
      ])

      assert.strictEqual(new Reader(yield* handler.compound(writeAccess), limits).uint32(), Status.ROFS)

      // Deny modes are share reservations, not an error on a read-only export; only undefined
      // values are rejected (RFC 8881 Section 18.16.3).
      const denyRead = call([
        sequence(client.session, 2),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        openByName(client.client, "file", 1, 1)
      ])

      assert.strictEqual(new Reader(yield* handler.compound(denyRead), limits).uint32(), Status.OK)

      const undefinedDeny = call([
        sequence(client.session, 3),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        openByName(client.client, "file", 1, 4)
      ])

      assert.strictEqual(new Reader(yield* handler.compound(undefinedDeny), limits).uint32(), Status.INVAL)

      const opened = parseOpen(
        yield* handler.compound(call([
          sequence(client.session, 4),
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
      )

      assert.strictEqual(
        statuses(yield* handler.compound(call([(writer) => writer.uint32(Operation.PUTROOTFH)]))).status,
        Status.OP_NOT_IN_SESSION
      )

      // Section 18.46.3: the first operation is judged on its own; a SEQUENCE later in the
      // compound is only reached when the operations before it succeed.
      const misplaced = call([
        (writer) => writer.uint32(Operation.PUTROOTFH),
        sequence(new Uint8Array(16), 1)
      ])

      assert.deepStrictEqual(statuses(yield* handler.compound(misplaced)).operations, [
        [Operation.PUTROOTFH, Status.OP_NOT_IN_SESSION]
      ])

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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
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
        callbackTimeout: "1 second",
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
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
      assert.deepStrictEqual(attributeValues.array((reader) => reader.uint32()), [3826978815, 12099646, 6144])
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits: constrained }
      )

      const { session } = yield* startSession(handler, "link-bound")

      const response = yield* handler.compound(call([
        sequence(session, 1),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        (writer) => writer.uint32(Operation.LOOKUP).string("link"),
        (writer) => writer.uint32(Operation.READLINK)
      ], "link"))

      assert.strictEqual(new Reader(response, constrained).uint32(), Status.SERVERFAULT)
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits: constrained }
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits: constrained }
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits: constrained }
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
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
        Status.OK
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits: constrained }
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
        callbackTimeout: "1 second",
        generation,
        now: () => 0,
        limits
      })

      const { session } = yield* startSession(handler, "all-attributes")
      const requested = [3_826_978_815, 12_099_646, 6_144]

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
      assert.isFalse(values.boolean(), "case_insensitive")
      assert.isTrue(values.boolean(), "case_preserving")
      assert.deepStrictEqual(values.opaque(), expectedHandle)
      assert.strictEqual(values.uint64(), observation.value.ino)
      assert.isTrue(values.boolean(), "homogeneous")
      assert.strictEqual(values.uint32(), ByteSize.toNumberUnsafe(limits.maxNameBytes))
      assert.strictEqual(values.uint64(), BigInt(limits.maxReadBytes))
      assert.strictEqual(values.uint64(), BigInt(limits.maxWriteBytes))
      assert.strictEqual(values.uint32(), 0o640)
      assert.isTrue(values.boolean(), "no_trunc")
      assert.strictEqual(values.uint32(), 2)
      assert.strictEqual(values.string(), "501")
      assert.strictEqual(values.string(), "20")
      assert.strictEqual(values.uint64(), 3n)

      const readTime = () => {
        const seconds = values.uint64()
        const nanoseconds = values.uint32()

        return { seconds, nanoseconds }
      }

      const expectTime = (timestamp: bigint) => {
        assert.deepStrictEqual(readTime(), {
          seconds: timestamp / 1_000_000_000n,
          nanoseconds: Number(timestamp % 1_000_000_000n)
        })
      }

      expectTime(observation.value.atimeNs)
      assert.deepStrictEqual(readTime(), { seconds: 0n, nanoseconds: 1 }, "time_delta")
      expectTime(observation.value.ctimeNs)
      expectTime(observation.value.mtimeNs)
      assert.strictEqual(values.uint64(), observation.value.ino)
      assert.deepStrictEqual(values.array((item) => item.uint32()), [])
      assert.strictEqual(values.uint32(), 0x2, "fs_charset_cap: FSCHARSET_CAP4_ALLOWS_ONLY_UTF8")
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits: constrained }
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
      assert.deepStrictEqual(parse(yield* read(6, 0n, 4)), {
        status: Status.OK,
        eof: false,
        bytes: new Uint8Array([0, 1, 2])
      })
    }))

  it.effect("rejects every decoded mutation as read-only without changing the volume", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const original = new Uint8Array([1, 2, 3])
      yield* caller.writeFile("/file", original, { access: "write", create: "exclusive" })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
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
        {
          setup: (writer) => writer.uint32(Operation.SAVEFH),
          operation: (writer) => writer.uint32(Operation.RENAME).string("file").string("renamed")
        },
        {
          setup: (writer) => writer.uint32(Operation.SAVEFH),
          operation: (writer) => writer.uint32(Operation.LINK).string("linked")
        }
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
        { leaseDurationSeconds: 1, callbackTimeout: "1 second", generation, now: () => now, limits: constrained }
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

  it.effect("reclaims an expired lease without waiting for another client's traffic", () =>
    Effect.gen(function*() {
      let now = 0
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const root = yield* caller.rootReference
      const reference = yield* caller.lookupReference(root, new TextEncoder().encode("file"))

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 1, callbackTimeout: "1 second", generation, now: () => now, limits }
      )

      // One connection object for both calls: `session.connections` is keyed by identity, so a
      // fresh `connection()` would disconnect nothing and the drop below would prove nothing.
      const dropped = connection(1)
      const abandoned = yield* startSession(handler, "abandoned", {}, new Uint8Array(8), dropped)
      parseOpen(
        yield* handler.compound(call(
          [
            sequence(abandoned.session, 1, true),
            (writer) => writer.uint32(Operation.PUTROOTFH),
            openReadOnly(abandoned.client, "file"),
            (writer) => writer.uint32(Operation.GETFH)
          ],
          "probe",
          dropped
        ))
      )

      yield* caller.unlink("/file")
      assert.strictEqual((yield* caller.observeMetadata(reference)).value.nlink, 0)

      // The client drops its connection and never returns. Nothing else reaches the server, so
      // reclamation has to come from the handler's own schedule rather than another compound.
      yield* handler.disconnect(dropped)
      now = 1_001
      yield* TestClock.adjust("2 seconds")

      // Observed through the VFS rather than a compound: any compound would itself sweep, which
      // is exactly the traffic this test must do without.
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
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

  it.live("does not let a connection finalizer wait out an in-flight compound", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const base = makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const parked = yield* Deferred.make<void>()

      // An OPEN that never returns stands in for a VFS operation stalled on a backing store. The
      // compound holds the state gate for as long as it runs, and is uninterruptible while it does.
      const export_ = {
        ...base,
        open: (reference: Vfs.ObjectReference) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(base.open(reference))
          )
      }

      const handler = yield* makeNfs4Handler(export_, {
        leaseDurationSeconds: 30,
        callbackTimeout: "1 second",
        generation,
        now: () => 0,
        limits
      })

      const stalling = connection(1)
      const departing = connection(2)
      const held = yield* startSession(handler, "stalling", {}, new Uint8Array(8), stalling)
      yield* startSession(handler, "departing", {}, new Uint8Array(8), departing)

      const inFlight = yield* Effect.forkChild(handler.compound(call(
        [
          sequence(held.session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openReadOnly(held.client, "file")
        ],
        "stalling-probe",
        stalling
      )))

      yield* Deferred.await(entered)

      // `handleConnection` runs `disconnect` under `Effect.ensuring`, which makes the finalizer
      // uninterruptible; `Semaphore.withPermits` then waits via `restore`, which returns to that
      // uninterruptible status. A finalizer that takes the state gate therefore cannot be
      // interrupted out of the wait, so this interrupt must still return while the compound stalls.
      const leaving = yield* Effect.forkChild(
        Deferred.succeed(parked, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(handler.disconnect(departing))
        )
      )

      // The interrupt must find the fiber already inside `ensuring`, or the finalizer never runs
      // and the assertion below proves nothing.
      yield* Deferred.await(parked)

      // The interrupt is awaited on another fiber so the bound races an interruptible join rather
      // than the uninterruptible finalizer itself, which no timeout could abandon cleanly.
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(leaving))
      const finished = yield* Fiber.join(interrupting).pipe(Effect.timeoutOption("2 seconds"))

      // Release the compound before asserting: a wedged finalizer would otherwise outlive the
      // failure and time the suite out instead of reporting it.
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(inFlight)

      assert.isTrue(
        Option.isSome(finished),
        "a connection finalizer stalled behind an in-flight compound"
      )
    }))

  it.effect("reuses session and open capacity after explicit teardown", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const constrained = { ...limits, maxSessions: 1, maxOpens: 1 }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits: constrained }
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
      assert.strictEqual(new Reader(yield* handler.compound(failedCreate), constrained).uint32(), Status.DELAY)
      assert.strictEqual(
        new Reader(
          yield* handler.compound(
            call([(writer) => writer.uint32(Operation.DESTROY_SESSION).fixedOpaque(first.session)])
          ),
          constrained
        ).uint32(),
        Status.OK
      )
      // The failed attempt did not consume the sequence slot, so the same request now succeeds.
      const created = new Reader(yield* handler.compound(failedCreate), constrained)
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

      assert.strictEqual(new Reader(yield* handler.compound(full), constrained).uint32(), Status.DELAY)
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
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
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
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

  const connectionHandler = Effect.gen(function*() {
    const caller = yield* (yield* Vfs.make()).caller()

    return yield* makeNfs4Handler(
      makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
      { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
    )
  })

  const destroySession = (id: Uint8Array) => (writer: Writer) =>
    writer.uint32(Operation.DESTROY_SESSION).fixedOpaque(id)

  const bindToSession = (id: Uint8Array) => (writer: Writer) =>
    writer.uint32(Operation.BIND_CONN_TO_SESSION).fixedOpaque(id).uint32(1).boolean(false)

  it.effect("refuses DESTROY_SESSION from a connection the session was never carried on", () =>
    Effect.gen(function*() {
      const handler = yield* connectionHandler
      const owner = connection(1)
      const stranger = connection(2)
      const { session } = yield* startSession(handler, "destroy", {}, new Uint8Array(8), owner)

      // Section 18.37.3: DESTROY_SESSION MUST be invoked on a connection associated with the
      // session. Otherwise any second connection could kill a mount using an observed session id.
      const refused = yield* handler.compound(call([destroySession(session)], "probe", stranger))
      assert.deepStrictEqual(statuses(refused).operations, [
        [Operation.DESTROY_SESSION, Status.CONN_NOT_BOUND_TO_SESSION]
      ])

      // The session is untouched and the connection that created it may still destroy it.
      const accepted = yield* handler.compound(call([destroySession(session)], "probe", owner))
      assert.deepStrictEqual(statuses(accepted).operations, [[Operation.DESTROY_SESSION, Status.OK]])
    }))

  it.effect("associates a connection that only ever carried a SEQUENCE", () =>
    Effect.gen(function*() {
      const handler = yield* connectionHandler
      const owner = connection(1)
      const bySequence = connection(2)
      const { session } = yield* startSession(handler, "associate", {}, new Uint8Array(8), owner)

      // Before any SEQUENCE this connection is a stranger to the session.
      assert.deepStrictEqual(
        statuses(yield* handler.compound(call([destroySession(session)], "probe", bySequence))).operations,
        [[Operation.DESTROY_SESSION, Status.CONN_NOT_BOUND_TO_SESSION]]
      )

      // Section 2.10.3.1: under SP4_NONE the SEQUENCE itself associates it.
      assert.strictEqual(
        statuses(yield* handler.compound(call([sequence(session, 1)], "probe", bySequence))).status,
        Status.OK
      )

      assert.deepStrictEqual(
        statuses(yield* handler.compound(call([destroySession(session)], "probe", bySequence))).operations,
        [[Operation.DESTROY_SESSION, Status.OK]]
      )
    }))

  it.effect("lets a connection associated only by BIND_CONN_TO_SESSION destroy the session", () =>
    Effect.gen(function*() {
      const handler = yield* connectionHandler
      const owner = connection(1)
      const byBind = connection(3)
      const { session } = yield* startSession(handler, "bind-assoc", {}, new Uint8Array(8), owner)

      // Before binding, the connection is a stranger.
      assert.deepStrictEqual(
        statuses(yield* handler.compound(call([destroySession(session)], "probe", byBind))).operations,
        [[Operation.DESTROY_SESSION, Status.CONN_NOT_BOUND_TO_SESSION]]
      )

      assert.strictEqual(
        statuses(yield* handler.compound(call([bindToSession(session)], "probe", byBind))).status,
        Status.OK
      )

      // Section 18.34.3 binding is what makes the connection eligible.
      assert.deepStrictEqual(
        statuses(yield* handler.compound(call([destroySession(session)], "probe", byBind))).operations,
        [[Operation.DESTROY_SESSION, Status.OK]]
      )
    }))

  it.effect("associates a reconnecting client that retransmits a cached SEQUENCE", () =>
    Effect.gen(function*() {
      const handler = yield* connectionHandler
      const owner = connection(1)
      const reconnected = connection(5)
      const { session } = yield* startSession(handler, "replay", {}, new Uint8Array(8), owner)

      const cached = call([sequence(session, 1, true), (writer) => writer.uint32(Operation.PUTROOTFH)], "replay", owner)
      assert.strictEqual(statuses(yield* handler.compound(cached)).status, Status.OK)

      // The same bytes arriving on a new connection hit the reply cache and never reach the
      // SEQUENCE handler, but Section 2.10.3.1 still associates the connection.
      const retransmitted = call(
        [sequence(session, 1, true), (writer) => writer.uint32(Operation.PUTROOTFH)],
        "replay",
        reconnected
      )

      assert.strictEqual(statuses(yield* handler.compound(retransmitted)).status, Status.OK)
      assert.deepStrictEqual(
        statuses(yield* handler.compound(call([destroySession(session)], "probe", reconnected))).operations,
        [[Operation.DESTROY_SESSION, Status.OK]]
      )
    }))

  it.effect("drops a connection's association when it disconnects, without ending the session", () =>
    Effect.gen(function*() {
      const handler = yield* connectionHandler
      const owner = connection(1)
      const second = connection(2)
      const { session } = yield* startSession(handler, "disconnect", {}, new Uint8Array(8), owner)

      yield* handler.compound(call([sequence(session, 1)], "probe", second))
      yield* handler.disconnect(second)

      // The session survives: the connection that created it still works.
      assert.strictEqual(
        statuses(yield* handler.compound(call([sequence(session, 2)], "probe", owner))).status,
        Status.OK
      )

      // But the disconnected connection is no longer associated. Re-using that identity, as a
      // fresh socket reaching the same handler would, is refused.
      assert.deepStrictEqual(
        statuses(yield* handler.compound(call([destroySession(session)], "probe", second))).operations,
        [[Operation.DESTROY_SESSION, Status.CONN_NOT_BOUND_TO_SESSION]]
      )
    }))

  const backChannelHandler = (callbackTimeout: Duration.Input) =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      return yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, callbackTimeout, generation, now: () => 0, limits }
      )
    })

  /**
   * An RPC accepted-reply carrying an all-OK CB_SEQUENCE result, echoing the session, sequence and
   * slot it was sent, exactly as a working client answers.
   */
  const callbackReplyFor = (request: Uint8Array, session: Uint8Array): Uint8Array => {
    const sent = new Reader(request, limits)
    const xid = sent.uint32()

    // RPC call header: msgtype, rpcvers, prog, vers, proc, then credential and verifier.
    for (let field = 0; field < 5; field++) sent.uint32()
    sent.uint32()
    sent.opaque()
    sent.uint32()
    sent.opaque()

    // CB_COMPOUND args: tag, minorversion, callback_ident, argarray count, then CB_SEQUENCE.
    sent.string()
    sent.uint32()
    sent.uint32()
    sent.uint32()
    sent.uint32()
    sent.fixedOpaque(16)
    const sequence = sent.uint32()
    const slot = sent.uint32()

    return new Writer().uint32(xid).uint32(1).uint32(0).uint32(0).opaque(new Uint8Array()).uint32(0)
      .uint32(Status.OK).string("probe").uint32(1)
      .uint32(11).uint32(Status.OK)
      .fixedOpaque(session).uint32(sequence).uint32(slot).uint32(slot).uint32(slot)
      .bytes()
  }

  /** The reply a client's RPC layer sends when it serves no such program. */
  const programUnavailableFor = (request: Uint8Array): Uint8Array => {
    const xid = new DataView(request.buffer, request.byteOffset, request.byteLength).getUint32(0)

    return new Writer().uint32(xid).uint32(1).uint32(0).uint32(0).opaque(new Uint8Array()).uint32(1).bytes()
  }

  it.effect("sends a CB_COMPOUND whose CB_SEQUENCE and RPC version match the errata", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("2 seconds")
      let sent: Uint8Array | undefined

      const client = connection(1, (message) => {
        sent = message

        return true
      })

      const { session } = yield* startSession(handler, "callback", {}, new Uint8Array(8), client, 4)
      const probe = yield* Effect.forkChild(handler.probeBackChannel(session))
      yield* Effect.yieldNow

      assert.isDefined(sent)
      const reader = new Reader(sent, limits)
      assert.strictEqual(reader.uint32() > 0, true, "xid")
      assert.strictEqual(reader.uint32(), 0, "message type is CALL")
      assert.strictEqual(reader.uint32(), 2, "RPC version")
      assert.strictEqual(reader.uint32(), callbackProgram, "program comes from csa_cb_program")

      // RFC 5661 erratum 2291: the callback program's version is 1, not the 4 the RFC prints.
      assert.strictEqual(reader.uint32(), 1, "callback program version")
      assert.strictEqual(reader.uint32(), 1, "CB_COMPOUND procedure")

      // The client authorized AUTH_NONE, so that is what the callback carries.
      assert.strictEqual(reader.uint32(), 0, "credential flavor")
      assert.strictEqual(reader.opaque().length, 0, "empty AUTH_NONE credential")
      reader.uint32()
      reader.opaque()

      assert.strictEqual(reader.string(), "probe", "CB_COMPOUND tag")
      assert.strictEqual(reader.uint32(), 1, "minorversion")
      reader.uint32()
      assert.strictEqual(reader.uint32(), 1, "one operation")

      // Erratum 6015: CB_SEQUENCE is REQUIRED, and Section 20.9.3 puts it first.
      assert.strictEqual(reader.uint32(), 11, "OP_CB_SEQUENCE")
      assert.deepStrictEqual(reader.fixedOpaque(16), session, "csa_sessionid")
      assert.strictEqual(reader.uint32(), 1, "csa_sequenceid starts at 1")
      assert.strictEqual(reader.uint32(), 0, "csa_slotid")
      assert.strictEqual(reader.uint32(), 3, "csa_highest_slotid is the last of four slots")

      yield* handler.callbackReply(client, callbackReplyFor(sent, session))
      assert.isTrue(yield* Fiber.join(probe), "the client answered, so the path is up")

      // A working path must not be reported as down.
      const reply = new Reader(yield* handler.compound(call([sequence(session, 1)], "probe", client)), limits)
      assert.strictEqual(reply.uint32(), Status.OK)
      reply.string()

      for (let field = 0; field < 3; field++) reply.uint32()
      reply.fixedOpaque(16)

      for (let field = 0; field < 4; field++) reply.uint32()

      assert.strictEqual(reply.uint32(), 0, "sr_status_flags is clear while the path is up")
    }))

  // A real timeout needs the live clock: it.effect runs on the test clock, which never advances.
  it.live("reports the callback path down when the client never answers", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("10 millis")
      const client = connection(1)
      const { session } = yield* startSession(handler, "silent", {}, new Uint8Array(8), client, 2)

      assert.isFalse(yield* handler.probeBackChannel(session))
    }))

  it.effect("reports the callback path down when the connection cannot be written to", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("2 seconds")
      const client = connection(1, () => false)
      const { session } = yield* startSession(handler, "broken", {}, new Uint8Array(8), client, 2)

      assert.isFalse(yield* handler.probeBackChannel(session))
    }))

  it.effect("has no backchannel to probe when the client never asked for one", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("2 seconds")

      const client = connection(1, () => {
        throw new Error("a session without a backchannel must not send callbacks")
      })

      const { session } = yield* startSession(handler, "none", {}, new Uint8Array(8), client)

      assert.isFalse(yield* handler.probeBackChannel(session))
    }))

  it.effect("gives one client id to several connections and serves a session on each", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("2 seconds")
      const first = connection(1)
      const second = connection(2)

      const identify = (on: typeof first) =>
        Effect.gen(function*() {
          const reply = new Reader(yield* handler.compound(call([exchangeId("trunked")], "probe", on)), limits)
          assert.strictEqual(reply.uint32(), Status.OK)
          reply.string()
          reply.uint32()
          reply.uint32()
          reply.uint32()
          const id = reply.uint64()
          reply.uint32()

          return { id, flags: reply.uint32() }
        })

      // Section 18.35.4 case 4: a second EXCHANGE_ID against an UNCONFIRMED record replaces it
      // and issues a new client ID, so trunking cannot be detected until the record is confirmed.
      const unconfirmed = yield* identify(first)
      const replaced = yield* identify(first)
      assert.notStrictEqual(replaced.id, unconfirmed.id)

      // CREATE_SESSION confirms the record.
      const session = new Reader(
        yield* handler.compound(call(
          [(writer) => {
            writer.uint32(Operation.CREATE_SESSION).uint64(replaced.id).uint32(1).uint32(0)
            channel(writer, 2)
            channel(writer, 0)
            writer.uint32(0).uint32(0)
          }],
          "probe",
          first
        )),
        limits
      )

      assert.strictEqual(session.uint32(), Status.OK)
      session.string()
      session.uint32()
      session.uint32()
      session.uint32()
      const sessionOne = session.fixedOpaque(16)

      // Section 18.35.4 case 2 and Section 2.10.5 client-ID trunking: the same co_ownerid,
      // verifier, and principal arriving over another connection resolve to the same confirmed
      // client ID, and CONFIRMED_R must be set so the client knows it may trunk.
      const trunked = yield* identify(second)
      assert.strictEqual(trunked.id, replaced.id, "one client ID across both connections")
      // The bitwise AND is signed in JavaScript, so compare the shifted bit rather than the mask.
      assert.strictEqual((trunked.flags & 0x8000_0000) !== 0, true, "EXCHGID4_FLAG_CONFIRMED_R")

      // A second session for that one client ID, created over the second connection.
      const other = new Reader(
        yield* handler.compound(call(
          [(writer) => {
            writer.uint32(Operation.CREATE_SESSION).uint64(replaced.id).uint32(2).uint32(0)
            channel(writer, 2)
            channel(writer, 0)
            writer.uint32(0).uint32(0)
          }],
          "probe",
          second
        )),
        limits
      )

      assert.strictEqual(other.uint32(), Status.OK)
      other.string()
      other.uint32()
      other.uint32()
      other.uint32()
      const sessionTwo = other.fixedOpaque(16)
      assert.notDeepEqual(sessionOne, sessionTwo, "distinct sessions on one client ID")

      for (const [id, on] of [[sessionOne, first], [sessionTwo, second]] as const) {
        assert.strictEqual(
          statuses(yield* handler.compound(call([sequence(id, 1)], "probe", on))).status,
          Status.OK
        )
      }
    }))

  it.effect("carries the AUTH_SYS credential the client authorized for callbacks", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("2 seconds")
      let sent: Uint8Array | undefined

      const client = connection(1, (message) => {
        sent = message

        return true
      })

      // csa_sec_parms offering AUTH_SYS only: Section 18.36.3 authorizes the server to use
      // AUTH_SYS on callbacks with exactly this cbsp_sys_cred, and nothing else.
      const { session } = yield* startSession(
        handler,
        "authsys",
        {},
        new Uint8Array(8),
        client,
        2,
        (writer) => writer.array([undefined], (item) => authSysCallback(item))
      )

      yield* Effect.forkChild(handler.probeBackChannel(session))
      yield* Effect.yieldNow

      assert.isDefined(sent)
      const reader = new Reader(sent, limits)

      for (let field = 0; field < 6; field++) reader.uint32()

      assert.strictEqual(reader.uint32(), 1, "AUTH_SYS credential flavor")
      const credential = new Reader(reader.opaque(), limits)
      assert.strictEqual(credential.uint32(), 0x6aa6_6b2d, "stamp from cbsp_sys_cred")
      assert.strictEqual(credential.string(), "Lloyds-Mech.local", "machine name from cbsp_sys_cred")
    }))

  it.effect("sends no callback when the client authorized no credential it can encode", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("2 seconds")

      const client = connection(1, () => {
        throw new Error("no credential was authorized, so no callback may be sent")
      })

      // An empty csa_sec_parms authorizes nothing; the backchannel is bound but unusable.
      const { session } = yield* startSession(
        handler,
        "unauthorized",
        {},
        new Uint8Array(8),
        client,
        2,
        (writer) => writer.array([], () => undefined)
      )

      assert.isFalse(yield* handler.probeBackChannel(session))
    }))

  // Live clock: the probe must actually time out after the impostor reply is discarded.
  it.live("ignores a callback reply that arrives on another connection", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("50 millis")
      let sent: Uint8Array | undefined

      const client = connection(1, (message) => {
        sent = message

        return true
      })

      const impostor = connection(9)
      const { session } = yield* startSession(handler, "spoof", {}, new Uint8Array(8), client, 2)
      const probe = yield* Effect.forkChild(handler.probeBackChannel(session))
      yield* Effect.yieldNow

      assert.isDefined(sent)

      // The same xid, answered by a connection the callback never went out on, must not complete
      // it — otherwise any peer could make another session's backchannel look healthy.
      yield* handler.callbackReply(impostor, callbackReplyFor(sent, session))
      assert.isFalse(yield* Fiber.join(probe), "the impostor reply was ignored and the probe timed out")
    }))

  it.live("reports a down callback path in sr_status_flags", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("10 millis")
      const client = connection(1, () => false)
      const { session } = yield* startSession(handler, "down", {}, new Uint8Array(8), client, 2)

      assert.isFalse(yield* handler.probeBackChannel(session))

      // Section 18.46.3: the client learns the path is unusable from the SEQUENCE reply.
      const reply = new Reader(yield* handler.compound(call([sequence(session, 1)], "probe", client)), limits)
      assert.strictEqual(reply.uint32(), Status.OK)
      reply.string()
      reply.uint32()
      reply.uint32()
      reply.uint32()
      reply.fixedOpaque(16)

      for (let field = 0; field < 4; field++) reply.uint32()

      assert.strictEqual(reply.uint32(), 0x0000_0200, "SEQ4_STATUS_CB_PATH_DOWN_SESSION")
    }))

  it.live("probes the callback path again after BACKCHANNEL_CTL re-advertises a program", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("10 millis")
      let attempts = 0

      const client = connection(1, () => {
        attempts++

        return false
      })

      const { session } = yield* startSession(handler, "repair", {}, new Uint8Array(8), client, 2)

      // The first SEQUENCE probes automatically, and the path goes down unanswered.
      yield* handler.compound(call([sequence(session, 1)], "probe", client))
      yield* Effect.sleep("30 millis")
      assert.strictEqual(attempts, 1, "probed once automatically")

      // A later SEQUENCE must not probe again on its own.
      yield* handler.compound(call([sequence(session, 2)], "probe", client))
      yield* Effect.sleep("30 millis")
      assert.strictEqual(attempts, 1, "still probed only once")

      // Re-advertising the program is the client repairing its callback service. Without clearing
      // `probed`, no later SEQUENCE would ever try the new endpoint.
      const repaired = yield* handler.compound(call(
        [
          sequence(session, 3),
          (writer) =>
            writer.uint32(Operation.BACKCHANNEL_CTL).uint32(callbackProgram)
              .array([0], (item, flavor) => item.uint32(flavor))
        ],
        "probe",
        client
      ))

      assert.deepStrictEqual(statuses(repaired).operations[1], [Operation.BACKCHANNEL_CTL, Status.OK])

      yield* handler.compound(call([sequence(session, 4)], "probe", client))
      yield* Effect.sleep("30 millis")
      assert.strictEqual(attempts, 2, "the repaired endpoint is probed again")
    }))

  it.live("treats an RPC-level rejection as a callback path that is down", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("50 millis")
      let sent: Uint8Array | undefined

      const client = connection(1, (message) => {
        sent = message

        return true
      })

      const { session } = yield* startSession(handler, "progunavail", {}, new Uint8Array(8), client, 2)
      const probe = yield* Effect.forkChild(handler.probeBackChannel(session))
      yield* Effect.yieldNow

      assert.isDefined(sent)

      // A client whose RPC layer serves no such program answers a well-formed REPLY carrying
      // PROG_UNAVAIL. That is not a working callback path.
      yield* handler.callbackReply(client, programUnavailableFor(sent))
      assert.isFalse(yield* Fiber.join(probe), "PROG_UNAVAIL is not success")
    }))

  it.live("does not advance the backchannel slot sequence when a callback goes unanswered", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("30 millis")
      const seen: Array<number> = []
      let answer = false

      const client = connection(1, (message) => {
        const reader = new Reader(message, limits)

        // xid, msgtype, rpcvers, prog, vers, proc, then credential and verifier.
        for (let field = 0; field < 6; field++) reader.uint32()
        reader.uint32()
        reader.opaque()
        reader.uint32()
        reader.opaque()

        // tag, minorversion, callback_ident, argarray count, opcode, then csa_sessionid.
        reader.string()

        for (let field = 0; field < 4; field++) reader.uint32()
        reader.fixedOpaque(16)
        seen.push(reader.uint32())

        return answer
      })

      const { session } = yield* startSession(handler, "seqid", {}, new Uint8Array(8), client, 2)

      // Section 2.10.6.1.3: the slot's sequence ID advances only on NFS4_OK. A client that never
      // answered still has the previous value cached, so a retry must reuse the same one.
      assert.isFalse(yield* handler.probeBackChannel(session))
      assert.isFalse(yield* handler.probeBackChannel(session))
      assert.deepStrictEqual(seen, [1, 1], "the unanswered sequence id is reused")

      answer = true
      yield* handler.probeBackChannel(session)
      assert.deepStrictEqual(seen, [1, 1, 1], "still the same sequence until one is accepted")
    }))

  /** An AUTH_SYS callback credential too large for RFC 5531's 400-byte opaque_auth body. */
  const oversizedAuthSys = (writer: Writer) => {
    writer.uint32(1).uint32(0).string("m".repeat(500)).uint32(0).uint32(0).array([], () => undefined)
  }

  const credentialFlavorOf = (message: Uint8Array): number => {
    const reader = new Reader(message, limits)

    for (let field = 0; field < 6; field++) reader.uint32()

    return reader.uint32()
  }

  it.effect("prefers an offered AUTH_NONE over an offered AUTH_SYS callback credential", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("2 seconds")
      let sent: Uint8Array | undefined

      const client = connection(1, (message) => {
        sent = message

        return true
      })

      // Both offered: AUTH_NONE is preferred because it carries no identity.
      const { session } = yield* startSession(
        handler,
        "both",
        {},
        new Uint8Array(8),
        client,
        2,
        (writer) =>
          writer.array([0, 1], (item, flavor) => {
            if (flavor === 0) item.uint32(0)
            else authSysCallback(item)
          })
      )

      yield* Effect.forkChild(handler.probeBackChannel(session))
      yield* Effect.yieldNow

      assert.isDefined(sent)
      assert.strictEqual(credentialFlavorOf(sent), 0, "AUTH_NONE preferred")
    }))

  it.effect("refuses an AUTH_SYS callback credential that cannot fit an RPC opaque_auth body", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("2 seconds")

      const client = connection(1, () => {
        throw new Error("an unsendable credential must not produce a callback")
      })

      const { session } = yield* startSession(
        handler,
        "oversized",
        {},
        new Uint8Array(8),
        client,
        2,
        (writer) => writer.array([undefined], (item) => oversizedAuthSys(item))
      )

      assert.isFalse(yield* handler.probeBackChannel(session))
    }))

  it.live("probes again when a new connection binds the backchannel", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("20 millis")
      let attempts = 0

      const first = connection(1, () => {
        attempts++

        return false
      })

      const second = connection(2, () => {
        attempts++

        return false
      })

      const { session } = yield* startSession(handler, "rebind", {}, new Uint8Array(8), first, 2)

      yield* handler.compound(call([sequence(session, 1)], "probe", first))
      yield* Effect.sleep("40 millis")
      assert.strictEqual(attempts, 1)

      // Section 18.34.4: binding a new connection to the backchannel is the repair the
      // CB_PATH_DOWN_SESSION flag asks for, so the path must be tried again.
      yield* handler.compound(call(
        [(writer) => writer.uint32(Operation.BIND_CONN_TO_SESSION).fixedOpaque(session).uint32(7).boolean(false)],
        "probe",
        second
      ))

      yield* handler.compound(call([sequence(session, 2)], "probe", second))
      yield* Effect.sleep("60 millis")
      assert.isAbove(attempts, 1, "the rebound path is probed again")
    }))

  it.live("marks the path down when its last backchannel connection goes away", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("2 seconds")
      let sent: Uint8Array | undefined

      const carrier = connection(1, (message) => {
        sent = message

        return true
      })

      const other = connection(2)
      const { session } = yield* startSession(handler, "lost", {}, new Uint8Array(8), carrier, 2)
      const probe = yield* Effect.forkChild(handler.probeBackChannel(session))
      yield* Effect.yieldNow
      yield* handler.callbackReply(carrier, callbackReplyFor(sent!, session))
      assert.isTrue(yield* Fiber.join(probe))

      // Losing the only connection bound to the backchannel makes the path unreachable, whatever
      // the last probe said.
      yield* handler.disconnect(carrier)

      const reply = new Reader(yield* handler.compound(call([sequence(session, 1)], "probe", other)), limits)
      assert.strictEqual(reply.uint32(), Status.OK)
      reply.string()

      for (let field = 0; field < 3; field++) reply.uint32()
      reply.fixedOpaque(16)

      for (let field = 0; field < 4; field++) reply.uint32()

      assert.strictEqual(reply.uint32(), 0x0000_0200, "SEQ4_STATUS_CB_PATH_DOWN_SESSION")
    }))

  it.live("lets a healthy carrier answer while another stays silent", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("2 seconds")
      const silent = connection(1)
      let sent: Uint8Array | undefined

      const healthy = connection(2, (message) => {
        sent = message

        return true
      })

      const { session } = yield* startSession(handler, "two-carriers", {}, new Uint8Array(8), silent, 2)

      // A second connection bound to the backchannel; the first never answers.
      yield* handler.compound(call(
        [(writer) => writer.uint32(Operation.BIND_CONN_TO_SESSION).fixedOpaque(session).uint32(2).boolean(false)],
        "probe",
        healthy
      ))

      const probe = yield* Effect.forkChild(handler.probeBackChannel(session))
      yield* Effect.yieldNow

      assert.isDefined(sent, "the healthy carrier was written to as well")
      yield* handler.callbackReply(healthy, callbackReplyFor(sent, session))

      // The silent carrier must not hold the verdict hostage.
      assert.isTrue(yield* Fiber.join(probe), "the answering carrier wins")
    }))

  it.live("does not let a rejecting carrier end the attempt", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("2 seconds")
      let rejectSent: Uint8Array | undefined

      const rejects = connection(1, (message) => {
        rejectSent = message

        return true
      })

      let goodSent: Uint8Array | undefined

      const answers = connection(2, (message) => {
        goodSent = message

        return true
      })

      const { session } = yield* startSession(handler, "reject-then-ok", {}, new Uint8Array(8), rejects, 2)

      yield* handler.compound(call(
        [(writer) => writer.uint32(Operation.BIND_CONN_TO_SESSION).fixedOpaque(session).uint32(2).boolean(false)],
        "probe",
        answers
      ))

      const probe = yield* Effect.forkChild(handler.probeBackChannel(session))
      yield* Effect.yieldNow

      // The first carrier answers PROG_UNAVAIL; that must not decide the whole attempt.
      assert.isDefined(rejectSent)
      yield* handler.callbackReply(rejects, programUnavailableFor(rejectSent))
      yield* Effect.sleep("10 millis")

      assert.isDefined(goodSent)
      yield* handler.callbackReply(answers, callbackReplyFor(goodSent, session))
      assert.isTrue(yield* Fiber.join(probe), "the second carrier still wins")
    }))

  it.effect("rejects a requested backchannel that offers no slots", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("2 seconds")
      const client = connection(1)

      const reply = new Reader(yield* handler.compound(call([exchangeId("noslots")], "probe", client)), limits)
      reply.uint32()
      reply.string()

      for (let field = 0; field < 3; field++) reply.uint32()
      const clientId = reply.uint64()

      // CONN_BACK_CHAN with ca_maxrequests zero: a backchannel that can carry nothing. Section
      // 18.36.3 forbids changing ca_maxrequests, so it cannot be rounded up either.
      const created = yield* handler.compound(call(
        [(writer) => {
          writer.uint32(Operation.CREATE_SESSION).uint64(clientId).uint32(1).uint32(2)
          channel(writer, 2)
          channel(writer, 0)
          writer.uint32(callbackProgram).array([0], (item, flavor) => item.uint32(flavor))
        }],
        "probe",
        client
      ))

      assert.deepStrictEqual(statuses(created).operations, [[Operation.CREATE_SESSION, Status.TOOSMALL]])
    }))

  it.live("rejects a callback reply whose RPC verifier exceeds an opaque_auth body", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("50 millis")
      let sent: Uint8Array | undefined

      const client = connection(1, (message) => {
        sent = message

        return true
      })

      const { session } = yield* startSession(handler, "bigverf", {}, new Uint8Array(8), client, 2)
      const probe = yield* Effect.forkChild(handler.probeBackChannel(session))
      yield* Effect.yieldNow

      assert.isDefined(sent)
      const xid = new DataView(sent.buffer, sent.byteOffset, sent.byteLength).getUint32(0)

      // A 500-byte verifier cannot appear in a valid RPC reply; RFC 5531 caps opaque_auth at 400.
      const oversized = new Writer().uint32(xid).uint32(1).uint32(0).uint32(0)
        .opaque(new Uint8Array(500)).uint32(0)
        .uint32(Status.OK).string("probe").uint32(1)
        .uint32(11).uint32(Status.OK)
        .fixedOpaque(session).uint32(1).uint32(0).uint32(0).uint32(0)
        .bytes()

      yield* handler.callbackReply(client, oversized)
      assert.isFalse(yield* Fiber.join(probe), "an invalid RPC reply is not a working path")
    }))

  it.effect("does not send a callback whose full RPC call exceeds the client's ca_maxrequestsize", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("2 seconds")

      const client = connection(1, () => {
        throw new Error("a callback larger than the client accepts must not be sent")
      })

      const reply = new Reader(yield* handler.compound(call([exchangeId("tight")], "probe", client)), limits)
      reply.uint32()
      reply.string()

      for (let field = 0; field < 3; field++) reply.uint32()
      const clientId = reply.uint64()

      // 96 bytes is above the minimum a channel must carry, and above the 64-byte CB_COMPOUND
      // body, but below the ~104-byte RPC call that body actually travels in.
      const created = yield* handler.compound(call(
        [(writer) => {
          writer.uint32(Operation.CREATE_SESSION).uint64(clientId).uint32(1).uint32(2)
          channel(writer, 2)
          channel(writer, 2, { maxRequest: 96 })
          writer.uint32(callbackProgram).array([0], (item, flavor) => item.uint32(flavor))
        }],
        "probe",
        client
      ))

      assert.strictEqual(statuses(created).operations[0]![1], Status.OK)
      const reader = new Reader(created, limits)
      reader.uint32()
      reader.string()

      for (let field = 0; field < 3; field++) reader.uint32()
      const session = reader.fixedOpaque(16)

      assert.isFalse(yield* handler.probeBackChannel(session))
    }))

  it.live("does not let a stale probe overwrite the verdict of a re-armed path", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("80 millis")
      const sends: Array<Uint8Array> = []

      const client = connection(1, (message) => {
        sends.push(message)

        return true
      })

      const { session } = yield* startSession(handler, "stale", {}, new Uint8Array(8), client, 2)

      // The first SEQUENCE probes automatically; answer it so the path starts up.
      yield* handler.compound(call([sequence(session, 1)], "probe", client))
      yield* Effect.yieldNow
      assert.strictEqual(sends.length, 1)
      yield* handler.callbackReply(client, callbackReplyFor(sends[0]!, session))

      // A second probe that will never be answered, still in flight below.
      const stale = yield* Effect.forkChild(handler.probeBackChannel(session))
      yield* Effect.yieldNow
      assert.strictEqual(sends.length, 2)

      // Re-arm the path, then probe it successfully.
      yield* handler.compound(call(
        [
          sequence(session, 2),
          (writer) =>
            writer.uint32(Operation.BACKCHANNEL_CTL).uint32(callbackProgram)
              .array([0], (item, flavor) => item.uint32(flavor))
        ],
        "probe",
        client
      ))

      const fresh = yield* Effect.forkChild(handler.probeBackChannel(session))
      yield* Effect.yieldNow
      const latest = sends.length - 1
      yield* handler.callbackReply(client, callbackReplyFor(sends[latest]!, session))
      assert.isTrue(yield* Fiber.join(fresh), "the re-armed path answers")

      // The stale probe times out afterwards. Its verdict is about a path the client has already
      // replaced, so it must not drag the current one back down.
      assert.isFalse(yield* Fiber.join(stale))

      const reply = new Reader(yield* handler.compound(call([sequence(session, 3)], "probe", client)), limits)
      assert.strictEqual(reply.uint32(), Status.OK)
      reply.string()

      for (let field = 0; field < 3; field++) reply.uint32()
      reply.fixedOpaque(16)

      for (let field = 0; field < 4; field++) reply.uint32()

      assert.strictEqual(reply.uint32(), 0, "the re-armed path is still reported up")
    }))

  it.live("re-arms the probe when every backchannel slot is already in flight", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("80 millis")
      let attempts = 0

      const client = connection(1, () => {
        attempts++

        return true
      })

      // One slot, and it is occupied by a probe that is still waiting for a reply.
      const { session } = yield* startSession(handler, "busy", {}, new Uint8Array(8), client, 1)
      const holding = yield* Effect.forkChild(handler.probeBackChannel(session))
      yield* Effect.yieldNow
      assert.strictEqual(attempts, 1)

      // A SEQUENCE now finds no free slot. That probe never ran, so it must not consume the
      // arming and leave the path untested forever.
      yield* handler.compound(call([sequence(session, 1)], "probe", client))
      yield* Effect.yieldNow
      yield* Fiber.join(holding)

      yield* handler.compound(call([sequence(session, 2)], "probe", client))
      yield* Effect.sleep("120 millis")

      assert.isAbove(attempts, 1, "a later SEQUENCE probes once a slot is free")
    }))

  it.effect("bounds a compound carrying BACKCHANNEL_CTL by its worst case before it mutates", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("2 seconds")
      const client = connection(1)

      // Room for SEQUENCE plus a small result, but not for a worst-case GETATTR after it.
      const { session } = yield* startSession(
        handler,
        "bounded",
        { maxResponse: 320 },
        new Uint8Array(8),
        client,
        2
      )

      const allAttributes = [0xffff_ffff, 0xffff_ffff, 0xffff]

      // BACKCHANNEL_CTL replaces the callback program and re-arms the probe, so the reply must be
      // bounded by the worst case before any of that happens. Otherwise the mutation lands and
      // the reply overflows afterwards, with only SEQUENCE rolled back.
      const tooBig = yield* handler.compound(call(
        [
          sequence(session, 1),
          (writer) =>
            writer.uint32(Operation.BACKCHANNEL_CTL).uint32(0x4000_0002)
              .array([0], (item, flavor) => item.uint32(flavor)),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          (writer) => writer.uint32(Operation.GETATTR).array(allAttributes, (item, word) => item.uint32(word))
        ],
        "probe",
        client
      ))

      const rejected = statuses(tooBig)
      assert.strictEqual(rejected.status, Status.REP_TOO_BIG)
      assert.strictEqual(rejected.operations.length, 1, "rejected at SEQUENCE, before BACKCHANNEL_CTL ran")

      // The callback program was never replaced: a probe still goes to the originally negotiated
      // program number.
      let program: number | undefined

      const observer = connection(2, (message) => {
        const reader = new Reader(message, limits)

        for (let field = 0; field < 3; field++) reader.uint32()
        program = reader.uint32()

        return true
      })

      yield* handler.compound(
        call(
          [(writer) => writer.uint32(Operation.BIND_CONN_TO_SESSION).fixedOpaque(session).uint32(2).boolean(false)],
          "probe",
          observer
        )
      )

      yield* Effect.forkChild(handler.probeBackChannel(session))
      yield* Effect.yieldNow

      assert.strictEqual(program, callbackProgram, "the unapplied BACKCHANNEL_CTL did not change it")
    }))

  it.live("rejects a callback reply that is not exactly one complete CB_SEQUENCE result", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("50 millis")
      let sent: Uint8Array | undefined

      const client = connection(1, (message) => {
        sent = message

        return true
      })

      const { session } = yield* startSession(handler, "malformed", {}, new Uint8Array(8), client, 2)

      /** Builds a reply whose CB_SEQUENCE result is deliberately malformed in one way. */
      const malformed = (
        request: Uint8Array,
        results: number,
        defect: "truncated" | "complete" | "trailing"
      ): Uint8Array => {
        const xid = new DataView(request.buffer, request.byteOffset, request.byteLength).getUint32(0)

        const writer = new Writer().uint32(xid).uint32(1).uint32(0).uint32(0)
          .opaque(new Uint8Array()).uint32(0)
          .uint32(Status.OK).string("probe").uint32(results)
          .uint32(11).uint32(Status.OK)
          .fixedOpaque(session).uint32(1).uint32(0)

        // csr_highest_slotid and csr_target_highest_slotid are mandatory.
        if (defect !== "truncated") writer.uint32(0).uint32(0)

        if (defect === "trailing") writer.uint32(0xdead_beef)

        return writer.bytes()
      }

      const probeWith = (build: (request: Uint8Array) => Uint8Array) =>
        Effect.gen(function*() {
          sent = undefined
          const probe = yield* Effect.forkChild(handler.probeBackChannel(session))
          yield* Effect.yieldNow
          assert.isDefined(sent)
          yield* handler.callbackReply(client, build(sent))

          return yield* Fiber.join(probe)
        })

      // A count that does not match the single result the server asked for.
      assert.isFalse(yield* probeWith((request) => malformed(request, 2, "complete")), "wrong result count")

      // Cut off after csr_slotid, so the two mandatory slot ids are missing.
      assert.isFalse(yield* probeWith((request) => malformed(request, 1, "truncated")), "truncated result")

      // A well-formed result with bytes after it is not a reply to this callback either.
      assert.isFalse(yield* probeWith((request) => malformed(request, 1, "trailing")), "trailing bytes")

      // The same reply, correctly shaped, is accepted — so the rejections above are about shape.
      assert.isTrue(yield* probeWith((request) => malformed(request, 1, "complete")), "a complete result")
    }))
})
