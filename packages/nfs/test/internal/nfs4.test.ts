import { LiveVolume, Testing, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, it, live as liveTest } from "@effect/vitest"
import { type Crypto, Deferred, Effect, Exit, Fiber, Layer, Option, Result, Scope } from "effect"
import * as ByteSize from "effect/ByteSize"
import type * as Duration from "effect/Duration"
import * as Predicate from "effect/Predicate"
import * as TestClock from "effect/testing/TestClock"
import { describe } from "vitest"
import { makeExport } from "../../src/internal/export.js"
import { failureForFs, nextSequenceId, type Nfs4Handler, Operation, Status } from "../../src/internal/nfs4.js"
import type { CompoundCall, Credentials } from "../../src/internal/rpc.js"
import {
  type DecoderSession,
  type EncoderSession,
  make,
  XdrCodec,
  type XdrEncodeError
} from "../../src/internal/xdr.js"
import {
  authSysCallback,
  call,
  callbackProgram,
  channel,
  connection,
  exchangeId,
  EXPORT_LIMITS,
  exportFor,
  generation,
  handlerFor,
  type HandlerOverrides,
  limits,
  makeHandler,
  openByName,
  openReadOnly,
  openSession,
  parseOpen,
  sequence,
  startSession,
  stateidWithSequence,
  statuses,
  type WriteOperation
} from "../support/harness.js"
import { ACCESS_ALL, callAs, decode, type DecodedReply, fattr, run, sys } from "../support/readOnlyProfile.js"

describe("Backchannel", () => {
  const live = <E>(name: string, body: () => Effect.Effect<void, E, Crypto.Crypto | Scope.Scope>, timeout?: number) =>
    liveTest(name, () => body().pipe(Effect.provide(NodeCrypto.layer)), timeout)

  it.layer(NodeCrypto.layer)("NFSv4.1 Backchannel", (it) => {
    const connectionHandler = Effect.flatMap(Vfs.Caller, (caller) => makeHandler(caller))

    const destroySession = (id: Uint8Array) => (writer: EncoderSession) =>
      Effect.gen(function*() {
        yield* writer.write(XdrCodec.uint32, Operation.DESTROY_SESSION)
        yield* writer.write(XdrCodec.fixedOpaque(id.length), id)
      })

    const bindToSession = (id: Uint8Array) => (writer: EncoderSession) =>
      Effect.gen(function*() {
        yield* writer.write(XdrCodec.uint32, Operation.BIND_CONN_TO_SESSION)
        yield* writer.write(XdrCodec.fixedOpaque(id.length), id)
        yield* writer.write(XdrCodec.uint32, 1)
        yield* writer.write(XdrCodec.boolean, false)
      })

    it.effect("should refuse DESTROY_SESSION from a connection the session was never carried on when DESTROY_SESSION arrives on an unassociated connection", () =>
      Effect.gen(function*() {
        const handler = yield* connectionHandler
        const owner = connection(1)
        const stranger = connection(2)

        const {
          session
        } = yield* startSession(handler, "destroy", {}, new Uint8Array(8), owner)

        // Section 18.37.3: DESTROY_SESSION MUST be invoked on a connection associated with the
        // session. Otherwise any second connection could kill a mount using an observed session id.
        const refused = yield* handler.compound(yield* call([destroySession(session)], "probe", stranger))
        assert.deepStrictEqual((yield* statuses(refused)).operations, [[
          Operation.DESTROY_SESSION,
          Status.CONN_NOT_BOUND_TO_SESSION
        ]])

        // The session is untouched and the connection that created it may still destroy it.
        const accepted = yield* handler.compound(yield* call([destroySession(session)], "probe", owner))
        assert.deepStrictEqual((yield* statuses(accepted)).operations, [[Operation.DESTROY_SESSION, Status.OK]])
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should associate a connection that only ever carried a SEQUENCE when a connection carries only SEQUENCE", () =>
      Effect.gen(function*() {
        const handler = yield* connectionHandler
        const owner = connection(1)
        const bySequence = connection(2)

        const {
          session
        } = yield* startSession(handler, "associate", {}, new Uint8Array(8), owner)

        // Before any SEQUENCE this connection is a stranger to the session.
        assert.deepStrictEqual(
          (yield* statuses(yield* handler.compound(yield* call([destroySession(session)], "probe", bySequence))))
            .operations,
          [[Operation.DESTROY_SESSION, Status.CONN_NOT_BOUND_TO_SESSION]]
        )

        // Section 2.10.3.1: under SP4_NONE the SEQUENCE itself associates it.
        assert.strictEqual(
          (yield* statuses(yield* handler.compound(yield* call([sequence(session, 1)], "probe", bySequence)))).status,
          Status.OK
        )
        assert.deepStrictEqual(
          (yield* statuses(yield* handler.compound(yield* call([destroySession(session)], "probe", bySequence))))
            .operations,
          [[Operation.DESTROY_SESSION, Status.OK]]
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should let a connection associated only by BIND_CONN_TO_SESSION destroy the session when BIND_CONN_TO_SESSION associates a connection", () =>
      Effect.gen(function*() {
        const handler = yield* connectionHandler
        const owner = connection(1)
        const byBind = connection(3)

        const {
          session
        } = yield* startSession(handler, "bind-assoc", {}, new Uint8Array(8), owner)

        // Before binding, the connection is a stranger.
        assert.deepStrictEqual(
          (yield* statuses(yield* handler.compound(yield* call([destroySession(session)], "probe", byBind))))
            .operations,
          [[Operation.DESTROY_SESSION, Status.CONN_NOT_BOUND_TO_SESSION]]
        )
        assert.strictEqual(
          (yield* statuses(yield* handler.compound(yield* call([bindToSession(session)], "probe", byBind)))).status,
          Status.OK
        )

        // Section 18.34.3 binding is what makes the connection eligible.
        assert.deepStrictEqual(
          (yield* statuses(yield* handler.compound(yield* call([destroySession(session)], "probe", byBind))))
            .operations,
          [[Operation.DESTROY_SESSION, Status.OK]]
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should associate a reconnecting client that retransmits a cached SEQUENCE when a reconnecting client retransmits a cached SEQUENCE", () =>
      Effect.gen(function*() {
        const handler = yield* connectionHandler
        const owner = connection(1)
        const reconnected = connection(5)

        const {
          session
        } = yield* startSession(handler, "replay", {}, new Uint8Array(8), owner)

        const cached = yield* call(
          [sequence(session, 1, true), (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)],
          "replay",
          owner
        )

        assert.strictEqual((yield* statuses(yield* handler.compound(cached))).status, Status.OK)

        // The same bytes arriving on a new connection hit the reply cache and never reach the
        // SEQUENCE handler, but Section 2.10.3.1 still associates the connection.
        const retransmitted = yield* call(
          [sequence(session, 1, true), (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)],
          "replay",
          reconnected
        )

        assert.strictEqual((yield* statuses(yield* handler.compound(retransmitted))).status, Status.OK)
        assert.deepStrictEqual(
          (yield* statuses(yield* handler.compound(yield* call([destroySession(session)], "probe", reconnected))))
            .operations,
          [[Operation.DESTROY_SESSION, Status.OK]]
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should drop a connection's association when it disconnects, without ending the session", () =>
      Effect.gen(function*() {
        const handler = yield* connectionHandler
        const owner = connection(1)
        const second = connection(2)

        const {
          session
        } = yield* startSession(handler, "disconnect", {}, new Uint8Array(8), owner)

        yield* handler.compound(yield* call([sequence(session, 1)], "probe", second))
        yield* handler.disconnect(second)

        // The session survives: the connection that created it still works.
        assert.strictEqual(
          (yield* statuses(yield* handler.compound(yield* call([sequence(session, 2)], "probe", owner)))).status,
          Status.OK
        )

        // But the disconnected connection is no longer associated. Re-using that identity, as a
        // fresh socket reaching the same handler would, is refused.
        assert.deepStrictEqual(
          (yield* statuses(yield* handler.compound(yield* call([destroySession(session)], "probe", second))))
            .operations,
          [[Operation.DESTROY_SESSION, Status.CONN_NOT_BOUND_TO_SESSION]]
        )
      }).pipe(Effect.provide(Testing.layer())))

    const backChannelHandler = (callbackTimeout: Duration.Input) =>
      Effect.flatMap(Vfs.Caller, (caller) => makeHandler(caller, { callbackTimeout }))

    /**
     * An RPC accepted-reply carrying an all-OK CB_SEQUENCE result, echoing the session, sequence and
     * slot it was sent, exactly as a working client answers.
     */
    const callbackReplyFor = (request: Uint8Array, session: Uint8Array) =>
      Effect.gen(function*() {
        const sent = yield* make.openReader(request, limits)
        const xid = yield* sent.read(XdrCodec.uint32)

        // RPC call header: msgtype, rpcvers, prog, vers, proc, then credential and verifier.
        for (let field = 0; field < 5; field++) yield* sent.read(XdrCodec.uint32)
        yield* sent.read(XdrCodec.uint32)
        yield* sent.read(XdrCodec.opaque())
        yield* sent.read(XdrCodec.uint32)
        yield* sent.read(XdrCodec.opaque())

        // CB_COMPOUND args: tag, minorversion, callback_ident, argarray count, then CB_SEQUENCE.
        yield* sent.read(XdrCodec.string())
        yield* sent.read(XdrCodec.uint32)
        yield* sent.read(XdrCodec.uint32)
        yield* sent.read(XdrCodec.uint32)
        yield* sent.read(XdrCodec.uint32)
        yield* sent.read(XdrCodec.fixedOpaque(16))
        const sequence = yield* sent.read(XdrCodec.uint32)
        const slot = yield* sent.read(XdrCodec.uint32)

        return yield* Effect.gen(function*() {
          const xdrWriter = yield* make.openWriter(limits, 4294967295)
          yield* xdrWriter.write(XdrCodec.uint32, xid)
          yield* xdrWriter.write(XdrCodec.uint32, 1)
          yield* xdrWriter.write(XdrCodec.uint32, 0)
          yield* xdrWriter.write(XdrCodec.uint32, 0)
          yield* xdrWriter.write(XdrCodec.opaque(), new Uint8Array())
          yield* xdrWriter.write(XdrCodec.uint32, 0)
          yield* xdrWriter.write(XdrCodec.uint32, Status.OK)
          yield* xdrWriter.write(XdrCodec.string(), "probe")
          yield* xdrWriter.write(XdrCodec.uint32, 1)
          yield* xdrWriter.write(XdrCodec.uint32, 11)
          yield* xdrWriter.write(XdrCodec.uint32, Status.OK)
          yield* xdrWriter.write(XdrCodec.fixedOpaque(session.length), session)
          yield* xdrWriter.write(XdrCodec.uint32, sequence)
          yield* xdrWriter.write(XdrCodec.uint32, slot)
          yield* xdrWriter.write(XdrCodec.uint32, slot)
          yield* xdrWriter.write(XdrCodec.uint32, slot)

          return yield* xdrWriter.bytes
        })
      })

    /** The reply a client's RPC layer sends when it serves no such program. */
    const programUnavailableFor = (request: Uint8Array) => {
      const xid = new DataView(request.buffer, request.byteOffset, request.byteLength).getUint32(0)

      return Effect.gen(function*() {
        const xdrWriter = yield* make.openWriter(limits, 4294967295)
        yield* xdrWriter.write(XdrCodec.uint32, xid)
        yield* xdrWriter.write(XdrCodec.uint32, 1)
        yield* xdrWriter.write(XdrCodec.uint32, 0)
        yield* xdrWriter.write(XdrCodec.uint32, 0)
        yield* xdrWriter.write(XdrCodec.opaque(), new Uint8Array())
        yield* xdrWriter.write(XdrCodec.uint32, 1)

        return yield* xdrWriter.bytes
      })
    }

    it.effect("should send a CB_COMPOUND whose CB_SEQUENCE and RPC version match the errata when a callback sends CB_COMPOUND under the errata", () =>
      Effect.gen(function*() {
        const handler = yield* backChannelHandler("2 seconds")
        let sent: Uint8Array | undefined

        const client = connection(1, (message) => {
          sent = message

          return true
        })

        const {
          session
        } = yield* startSession(handler, "callback", {}, new Uint8Array(8), client, 4)

        const probe = yield* Effect.forkChild(handler.probeBackChannel(session))
        yield* Effect.yieldNow
        assert.isDefined(sent)
        const reader = yield* make.openReader(sent, limits)
        assert.strictEqual((yield* reader.read(XdrCodec.uint32)) > 0, true, "xid")
        assert.strictEqual(yield* reader.read(XdrCodec.uint32), 0, "message type is CALL")
        assert.strictEqual(yield* reader.read(XdrCodec.uint32), 2, "RPC version")
        assert.strictEqual(yield* reader.read(XdrCodec.uint32), callbackProgram, "program comes from csa_cb_program")

        // RFC 5661 erratum 2291: the callback program's version is 1, not the 4 the RFC prints.
        assert.strictEqual(yield* reader.read(XdrCodec.uint32), 1, "callback program version")
        assert.strictEqual(yield* reader.read(XdrCodec.uint32), 1, "CB_COMPOUND procedure")

        // The client authorized AUTH_NONE, so that is what the callback carries.
        assert.strictEqual(yield* reader.read(XdrCodec.uint32), 0, "credential flavor")
        assert.strictEqual((yield* reader.read(XdrCodec.opaque())).length, 0, "empty AUTH_NONE credential")
        yield* reader.read(XdrCodec.uint32)
        yield* reader.read(XdrCodec.opaque())
        assert.strictEqual(yield* reader.read(XdrCodec.string()), "probe", "CB_COMPOUND tag")
        assert.strictEqual(yield* reader.read(XdrCodec.uint32), 1, "minorversion")
        yield* reader.read(XdrCodec.uint32)
        assert.strictEqual(yield* reader.read(XdrCodec.uint32), 1, "one operation")

        // Erratum 6015: CB_SEQUENCE is REQUIRED, and Section 20.9.3 puts it first.
        assert.strictEqual(yield* reader.read(XdrCodec.uint32), 11, "OP_CB_SEQUENCE")
        assert.deepStrictEqual(yield* reader.read(XdrCodec.fixedOpaque(16)), session, "csa_sessionid")
        assert.strictEqual(yield* reader.read(XdrCodec.uint32), 1, "csa_sequenceid starts at 1")
        assert.strictEqual(yield* reader.read(XdrCodec.uint32), 0, "csa_slotid")
        assert.strictEqual(yield* reader.read(XdrCodec.uint32), 3, "csa_highest_slotid is the last of four slots")
        yield* handler.callbackReply(client, yield* callbackReplyFor(sent, session))
        assert.isTrue(yield* Fiber.join(probe), "the client answered, so the path is up")

        // A working path must not be reported as down.
        const reply = yield* make.openReader(
          yield* handler.compound(yield* call([sequence(session, 1)], "probe", client)),
          limits
        )

        assert.strictEqual(yield* reply.read(XdrCodec.uint32), Status.OK)
        yield* reply.read(XdrCodec.string())

        for (let field = 0; field < 3; field++) yield* reply.read(XdrCodec.uint32)
        yield* reply.read(XdrCodec.fixedOpaque(16))

        for (let field = 0; field < 4; field++) yield* reply.read(XdrCodec.uint32)
        assert.strictEqual(yield* reply.read(XdrCodec.uint32), 0, "sr_status_flags is clear while the path is up")
      }).pipe(Effect.provide(Testing.layer())))

    // A real timeout needs the live clock: it.effect runs on the test clock, which never advances.
    live("should report the callback path down when the client never answers", () =>
      Effect.gen(function*() {
        const handler = yield* backChannelHandler("10 millis")
        const client = connection(1)

        const {
          session
        } = yield* startSession(handler, "silent", {}, new Uint8Array(8), client, 2)

        assert.isFalse(yield* handler.probeBackChannel(session))
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should report the callback path down when the connection cannot be written to", () =>
      Effect.gen(function*() {
        const handler = yield* backChannelHandler("2 seconds")
        const client = connection(1, () => false)

        const {
          session
        } = yield* startSession(handler, "broken", {}, new Uint8Array(8), client, 2)

        assert.isFalse(yield* handler.probeBackChannel(session))
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should have no backchannel to probe when the client never asked for one", () =>
      Effect.gen(function*() {
        const handler = yield* backChannelHandler("2 seconds")

        const client = connection(1, () => {
          throw new Error("a session without a backchannel must not send callbacks")
        })

        const {
          session
        } = yield* startSession(handler, "none", {}, new Uint8Array(8), client)

        assert.isFalse(yield* handler.probeBackChannel(session))
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should give one client id to several connections and serve a session on each when several connections serve one client session", () =>
      Effect.gen(function*() {
        const handler = yield* backChannelHandler("2 seconds")
        const first = connection(1)
        const second = connection(2)

        const identify = (on: typeof first) =>
          Effect.gen(function*() {
            const reply = yield* make.openReader(
              yield* handler.compound(yield* call([exchangeId("trunked")], "probe", on)),
              limits
            )

            assert.strictEqual(yield* reply.read(XdrCodec.uint32), Status.OK)
            yield* reply.read(XdrCodec.string())
            yield* reply.read(XdrCodec.uint32)
            yield* reply.read(XdrCodec.uint32)
            yield* reply.read(XdrCodec.uint32)
            const id = yield* reply.read(XdrCodec.uint64)
            yield* reply.read(XdrCodec.uint32)

            return {
              id,
              flags: yield* reply.read(XdrCodec.uint32)
            }
          })

        // Section 18.35.4 case 4: a second EXCHANGE_ID against an UNCONFIRMED record replaces it
        // and issues a new client ID, so trunking cannot be detected until the record is confirmed.
        const unconfirmed = yield* identify(first)
        const replaced = yield* identify(first)
        assert.notStrictEqual(replaced.id, unconfirmed.id)

        // CREATE_SESSION confirms the record.
        const session = yield* make.openReader(
          yield* handler.compound(
            yield* call(
              [(writer) =>
                Effect.gen(function*() {
                  yield* Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.CREATE_SESSION)
                    yield* writer.write(XdrCodec.uint64, replaced.id)
                    yield* writer.write(XdrCodec.uint32, 1)
                    yield* writer.write(XdrCodec.uint32, 0)
                  })
                  yield* channel(writer, 2)
                  yield* channel(writer, 0)
                  yield* Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, 0)
                    yield* writer.write(XdrCodec.uint32, 0)
                  })
                })],
              "probe",
              first
            )
          ),
          limits
        )

        assert.strictEqual(yield* session.read(XdrCodec.uint32), Status.OK)
        yield* session.read(XdrCodec.string())
        yield* session.read(XdrCodec.uint32)
        yield* session.read(XdrCodec.uint32)
        yield* session.read(XdrCodec.uint32)
        const sessionOne = yield* session.read(XdrCodec.fixedOpaque(16))

        // Section 18.35.4 case 2 and Section 2.10.5 client-ID trunking: the same co_ownerid,
        // verifier, and principal arriving over another connection resolve to the same confirmed
        // client ID, and CONFIRMED_R must be set so the client knows it may trunk.
        const trunked = yield* identify(second)
        assert.strictEqual(trunked.id, replaced.id, "one client ID across both connections")
        // The bitwise AND is signed in JavaScript, so compare the shifted bit rather than the mask.
        assert.strictEqual((trunked.flags & 0x8000_0000) !== 0, true, "EXCHGID4_FLAG_CONFIRMED_R")

        // A second session for that one client ID, created over the second connection.
        const other = yield* make.openReader(
          yield* handler.compound(
            yield* call(
              [(writer) =>
                Effect.gen(function*() {
                  yield* Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.CREATE_SESSION)
                    yield* writer.write(XdrCodec.uint64, replaced.id)
                    yield* writer.write(XdrCodec.uint32, 2)
                    yield* writer.write(XdrCodec.uint32, 0)
                  })
                  yield* channel(writer, 2)
                  yield* channel(writer, 0)
                  yield* Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, 0)
                    yield* writer.write(XdrCodec.uint32, 0)
                  })
                })],
              "probe",
              second
            )
          ),
          limits
        )

        assert.strictEqual(yield* other.read(XdrCodec.uint32), Status.OK)
        yield* other.read(XdrCodec.string())
        yield* other.read(XdrCodec.uint32)
        yield* other.read(XdrCodec.uint32)
        yield* other.read(XdrCodec.uint32)
        const sessionTwo = yield* other.read(XdrCodec.fixedOpaque(16))
        assert.notDeepEqual(sessionOne, sessionTwo, "distinct sessions on one client ID")

        for (const [id, on] of [[sessionOne, first], [sessionTwo, second]] as const) {
          assert.strictEqual(
            (yield* statuses(yield* handler.compound(yield* call([sequence(id, 1)], "probe", on)))).status,
            Status.OK
          )
        }
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should carry the AUTH_SYS credential the client authorized for callbacks when a client authorizes AUTH_SYS callbacks", () =>
      Effect.gen(function*() {
        const handler = yield* backChannelHandler("2 seconds")
        let sent: Uint8Array | undefined

        const client = connection(1, (message) => {
          sent = message

          return true
        })

        // csa_sec_parms offering AUTH_SYS only: Section 18.36.3 authorizes the server to use
        // AUTH_SYS on callbacks with exactly this cbsp_sys_cred, and nothing else.
        const {
          session
        } = yield* startSession(
          handler,
          "authsys",
          {},
          new Uint8Array(8),
          client,
          2,
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, 1)
              yield* authSysCallback(writer)
            })
        )

        yield* Effect.forkChild(handler.probeBackChannel(session))
        yield* Effect.yieldNow
        assert.isDefined(sent)
        const reader = yield* make.openReader(sent, limits)

        for (let field = 0; field < 6; field++) {
          yield* reader.read(XdrCodec.uint32)
        }

        assert.strictEqual(yield* reader.read(XdrCodec.uint32), 1, "AUTH_SYS credential flavor")
        const credential = yield* make.openReader(yield* reader.read(XdrCodec.opaque()), limits)
        assert.strictEqual(yield* credential.read(XdrCodec.uint32), 0x6aa6_6b2d, "stamp from cbsp_sys_cred")
        assert.strictEqual(
          yield* credential.read(XdrCodec.string()),
          "Lloyds-Mech.local",
          "machine name from cbsp_sys_cred"
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should send no callback when the client authorized no credential it can encode", () =>
      Effect.gen(function*() {
        const handler = yield* backChannelHandler("2 seconds")

        const client = connection(1, () => {
          throw new Error("no credential was authorized, so no callback may be sent")
        })

        // An empty csa_sec_parms authorizes nothing; the backchannel is bound but unusable.
        const {
          session
        } = yield* startSession(
          handler,
          "unauthorized",
          {},
          new Uint8Array(8),
          client,
          2,
          (writer) => writer.write(XdrCodec.uint32, 0)
        )

        assert.isFalse(yield* handler.probeBackChannel(session))
      }).pipe(Effect.provide(Testing.layer())))

    // Live clock: the probe must actually time out after the impostor reply is discarded.
    live(
      "should ignore a callback reply that arrives on another connection when a callback reply arrives on another connection",
      () =>
        Effect.gen(function*() {
          const handler = yield* backChannelHandler("50 millis")
          let sent: Uint8Array | undefined

          const client = connection(1, (message) => {
            sent = message

            return true
          })

          const impostor = connection(9)

          const {
            session
          } = yield* startSession(handler, "spoof", {}, new Uint8Array(8), client, 2)

          const probe = yield* Effect.forkChild(handler.probeBackChannel(session))
          yield* Effect.yieldNow
          assert.isDefined(sent)

          // The same xid, answered by a connection the callback never went out on, must not complete
          // it — otherwise any peer could make another session's backchannel look healthy.
          yield* handler.callbackReply(impostor, yield* callbackReplyFor(sent, session))
          assert.isFalse(yield* Fiber.join(probe), "the impostor reply was ignored and the probe timed out")
        }).pipe(Effect.provide(Testing.layer()))
    )
    live(
      "should report a down callback path in sr_status_flags when a callback path becomes unavailable",
      () =>
        Effect.gen(function*() {
          const handler = yield* backChannelHandler("10 millis")
          const client = connection(1, () => false)

          const {
            session
          } = yield* startSession(handler, "down", {}, new Uint8Array(8), client, 2)

          assert.isFalse(yield* handler.probeBackChannel(session))

          // Section 18.46.3: the client learns the path is unusable from the SEQUENCE reply.
          const reply = yield* make.openReader(
            yield* handler.compound(yield* call([sequence(session, 1)], "probe", client)),
            limits
          )

          assert.strictEqual(yield* reply.read(XdrCodec.uint32), Status.OK)
          yield* reply.read(XdrCodec.string())
          yield* reply.read(XdrCodec.uint32)
          yield* reply.read(XdrCodec.uint32)
          yield* reply.read(XdrCodec.uint32)
          yield* reply.read(XdrCodec.fixedOpaque(16))

          for (let field = 0; field < 4; field++) yield* reply.read(XdrCodec.uint32)
          assert.strictEqual(yield* reply.read(XdrCodec.uint32), 0x0000_0200, "SEQ4_STATUS_CB_PATH_DOWN_SESSION")
        }).pipe(Effect.provide(Testing.layer()))
    )
    live(
      "should probe the callback path again after BACKCHANNEL_CTL re-advertises a program when BACKCHANNEL_CTL re-advertises a callback program",
      () =>
        Effect.gen(function*() {
          const handler = yield* backChannelHandler("10 millis")
          let attempts = 0

          const client = connection(1, () => {
            attempts++

            return false
          })

          const {
            session
          } = yield* startSession(handler, "repair", {}, new Uint8Array(8), client, 2)

          // The first SEQUENCE probes automatically, and the path goes down unanswered.
          yield* handler.compound(yield* call([sequence(session, 1)], "probe", client))
          yield* Effect.sleep("30 millis")
          assert.strictEqual(attempts, 1, "probed once automatically")

          // A later SEQUENCE must not probe again on its own.
          yield* handler.compound(yield* call([sequence(session, 2)], "probe", client))
          yield* Effect.sleep("30 millis")
          assert.strictEqual(attempts, 1, "still probed only once")

          // Re-advertising the program is the client repairing its callback service. Without clearing
          // `probed`, no later SEQUENCE would ever try the new endpoint.
          const repaired = yield* handler.compound(
            yield* call(
              [sequence(session, 3), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.BACKCHANNEL_CTL)
                  yield* writer.write(XdrCodec.uint32, callbackProgram)
                  yield* writer.write(XdrCodec.uint32, [0].length)

                  for (const xdrValue of [0]) {
                    yield* ((item, flavor) =>
                      Effect.gen(function*() {
                        const xdrWriter = item
                        yield* xdrWriter.write(XdrCodec.uint32, flavor)
                      }))(writer, xdrValue)
                  }
                })],
              "probe",
              client
            )
          )

          assert.deepStrictEqual((yield* statuses(repaired)).operations[1], [Operation.BACKCHANNEL_CTL, Status.OK])
          yield* handler.compound(yield* call([sequence(session, 4)], "probe", client))
          yield* Effect.sleep("30 millis")
          assert.strictEqual(attempts, 2, "the repaired endpoint is probed again")
        }).pipe(Effect.provide(Testing.layer()))
    )
    live(
      "should treat an RPC-level rejection as a callback path that is down when the callback receives an RPC-level rejection",
      () =>
        Effect.gen(function*() {
          const handler = yield* backChannelHandler("50 millis")
          let sent: Uint8Array | undefined

          const client = connection(1, (message) => {
            sent = message

            return true
          })

          const {
            session
          } = yield* startSession(handler, "progunavail", {}, new Uint8Array(8), client, 2)

          const probe = yield* Effect.forkChild(handler.probeBackChannel(session))
          yield* Effect.yieldNow
          assert.isDefined(sent)

          // A client whose RPC layer serves no such program answers a well-formed REPLY carrying
          // PROG_UNAVAIL. That is not a working callback path.
          yield* handler.callbackReply(client, yield* programUnavailableFor(sent))
          assert.isFalse(yield* Fiber.join(probe), "PROG_UNAVAIL is not success")
        }).pipe(Effect.provide(Testing.layer()))
    )
    live(
      "should not advance the backchannel slot sequence when a callback goes unanswered",
      () =>
        Effect.gen(function*() {
          const handler = yield* backChannelHandler("30 millis")
          const seen: Array<number> = []
          let answer = false

          const client = {
            id: 1,
            send: (message: Uint8Array) =>
              Effect.gen(function*() {
                const reader = yield* make.openReader(message, limits)

                // xid, msgtype, rpcvers, prog, vers, proc, then credential and verifier.
                for (let field = 0; field < 6; field++) yield* reader.read(XdrCodec.uint32)
                yield* reader.read(XdrCodec.uint32)
                yield* reader.read(XdrCodec.opaque())
                yield* reader.read(XdrCodec.uint32)
                yield* reader.read(XdrCodec.opaque())

                // tag, minorversion, callback_ident, argarray count, opcode, then csa_sessionid.
                yield* reader.read(XdrCodec.string())

                for (let field = 0; field < 4; field++) yield* reader.read(XdrCodec.uint32)
                yield* reader.read(XdrCodec.fixedOpaque(16))
                seen.push(yield* reader.read(XdrCodec.uint32))

                return answer
              }).pipe(Effect.orDie)
          }

          const {
            session
          } = yield* startSession(handler, "seqid", {}, new Uint8Array(8), client, 2)

          // Section 2.10.6.1.3: the slot's sequence ID advances only on NFS4_OK. A client that never
          // answered still has the previous value cached, so a retry must reuse the same one.
          assert.isFalse(yield* handler.probeBackChannel(session))
          assert.isFalse(yield* handler.probeBackChannel(session))
          assert.deepStrictEqual(seen, [1, 1], "the unanswered sequence id is reused")
          answer = true
          yield* handler.probeBackChannel(session)
          assert.deepStrictEqual(seen, [1, 1, 1], "still the same sequence until one is accepted")
        }).pipe(Effect.provide(Testing.layer()))
    )

    /** An AUTH_SYS callback credential too large for RFC 5531's 400-byte opaque_auth body. */
    const oversizedAuthSys = (writer: EncoderSession) =>
      Effect.gen(function*() {
        yield* writer.write(XdrCodec.uint32, 1)
        yield* writer.write(XdrCodec.uint32, 0)
        yield* writer.write(XdrCodec.string(), "m".repeat(500))
        yield* writer.write(XdrCodec.uint32, 0)
        yield* writer.write(XdrCodec.uint32, 0)
        yield* writer.write(XdrCodec.uint32, 0)
      })

    const credentialFlavorOf = (message: Uint8Array) =>
      Effect.gen(function*() {
        const reader = yield* make.openReader(message, limits)

        for (let field = 0; field < 6; field++) yield* reader.read(XdrCodec.uint32)

        return yield* reader.read(XdrCodec.uint32)
      })

    it.effect("should prefer an offered AUTH_NONE over an offered AUTH_SYS callback credential when AUTH_NONE and AUTH_SYS are both offered for callbacks", () =>
      Effect.gen(function*() {
        const handler = yield* backChannelHandler("2 seconds")
        let sent: Uint8Array | undefined

        const client = connection(1, (message) => {
          sent = message

          return true
        })

        // Both offered: AUTH_NONE is preferred because it carries no identity.
        const {
          session
        } = yield* startSession(handler, "both", {}, new Uint8Array(8), client, 2, (writer) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, 2)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* authSysCallback(writer)
          }))

        yield* Effect.forkChild(handler.probeBackChannel(session))
        yield* Effect.yieldNow
        assert.isDefined(sent)
        assert.strictEqual(yield* credentialFlavorOf(sent), 0, "AUTH_NONE preferred")
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should refuse an AUTH_SYS callback credential that cannot fit an RPC opaque_auth body when an AUTH_SYS callback credential exceeds opaque_auth", () =>
      Effect.gen(function*() {
        const handler = yield* backChannelHandler("2 seconds")

        const client = connection(1, () => {
          throw new Error("an unsendable credential must not produce a callback")
        })

        const {
          session
        } = yield* startSession(
          handler,
          "oversized",
          {},
          new Uint8Array(8),
          client,
          2,
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, 1)
              yield* oversizedAuthSys(writer)
            })
        )

        assert.isFalse(yield* handler.probeBackChannel(session))
      }).pipe(Effect.provide(Testing.layer())))
    live("should probe again when a new connection binds the backchannel", () =>
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

        const {
          session
        } = yield* startSession(handler, "rebind", {}, new Uint8Array(8), first, 2)

        yield* handler.compound(yield* call([sequence(session, 1)], "probe", first))
        yield* Effect.sleep("40 millis")
        assert.strictEqual(attempts, 1)

        // Section 18.34.4: binding a new connection to the backchannel is the repair the
        // CB_PATH_DOWN_SESSION flag asks for, so the path must be tried again.
        yield* handler.compound(
          yield* call(
            [(writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.BIND_CONN_TO_SESSION)
                yield* writer.write(XdrCodec.fixedOpaque(session.length), session)
                yield* writer.write(XdrCodec.uint32, 7)
                yield* writer.write(XdrCodec.boolean, false)
              })],
            "probe",
            second
          )
        )
        yield* handler.compound(yield* call([sequence(session, 2)], "probe", second))
        yield* Effect.sleep("60 millis")
        assert.isAbove(attempts, 1, "the rebound path is probed again")
      }).pipe(Effect.provide(Testing.layer())))
    live("should mark the path down when its last backchannel connection goes away", () =>
      Effect.gen(function*() {
        const handler = yield* backChannelHandler("2 seconds")
        let sent: Uint8Array | undefined

        const carrier = connection(1, (message) => {
          sent = message

          return true
        })

        const other = connection(2)

        const {
          session
        } = yield* startSession(handler, "lost", {}, new Uint8Array(8), carrier, 2)

        const probe = yield* Effect.forkChild(handler.probeBackChannel(session))
        yield* Effect.yieldNow
        yield* handler.callbackReply(carrier, yield* callbackReplyFor(sent!, session))
        assert.isTrue(yield* Fiber.join(probe))

        // Losing the only connection bound to the backchannel makes the path unreachable, whatever
        // the last probe said.
        yield* handler.disconnect(carrier)

        const reply = yield* make.openReader(
          yield* handler.compound(yield* call([sequence(session, 1)], "probe", other)),
          limits
        )

        assert.strictEqual(yield* reply.read(XdrCodec.uint32), Status.OK)
        yield* reply.read(XdrCodec.string())

        for (let field = 0; field < 3; field++) yield* reply.read(XdrCodec.uint32)
        yield* reply.read(XdrCodec.fixedOpaque(16))

        for (let field = 0; field < 4; field++) yield* reply.read(XdrCodec.uint32)
        assert.strictEqual(yield* reply.read(XdrCodec.uint32), 0x0000_0200, "SEQ4_STATUS_CB_PATH_DOWN_SESSION")
      }).pipe(Effect.provide(Testing.layer())))
    live(
      "should let a healthy carrier answer while another stays silent when one callback carrier is silent and another responds",
      () =>
        Effect.gen(function*() {
          const handler = yield* backChannelHandler("2 seconds")
          const silent = connection(1)
          let sent: Uint8Array | undefined

          const healthy = connection(2, (message) => {
            sent = message

            return true
          })

          const {
            session
          } = yield* startSession(handler, "two-carriers", {}, new Uint8Array(8), silent, 2)

          // A second connection bound to the backchannel; the first never answers.
          yield* handler.compound(
            yield* call(
              [(writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.BIND_CONN_TO_SESSION)
                  yield* writer.write(XdrCodec.fixedOpaque(session.length), session)
                  yield* writer.write(XdrCodec.uint32, 2)
                  yield* writer.write(XdrCodec.boolean, false)
                })],
              "probe",
              healthy
            )
          )
          const probe = yield* Effect.forkChild(handler.probeBackChannel(session))
          yield* Effect.yieldNow
          assert.isDefined(sent, "the healthy carrier was written to as well")
          yield* handler.callbackReply(healthy, yield* callbackReplyFor(sent, session))

          // The silent carrier must not hold the verdict hostage.
          assert.isTrue(yield* Fiber.join(probe), "the answering carrier wins")
        }).pipe(Effect.provide(Testing.layer()))
    )
    live(
      "should not let a rejecting carrier end the attempt when one callback carrier rejects while another may respond",
      () =>
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

          const {
            session
          } = yield* startSession(handler, "reject-then-ok", {}, new Uint8Array(8), rejects, 2)

          yield* handler.compound(
            yield* call(
              [(writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.BIND_CONN_TO_SESSION)
                  yield* writer.write(XdrCodec.fixedOpaque(session.length), session)
                  yield* writer.write(XdrCodec.uint32, 2)
                  yield* writer.write(XdrCodec.boolean, false)
                })],
              "probe",
              answers
            )
          )
          const probe = yield* Effect.forkChild(handler.probeBackChannel(session))
          yield* Effect.yieldNow

          // The first carrier answers PROG_UNAVAIL; that must not decide the whole attempt.
          assert.isDefined(rejectSent)
          yield* handler.callbackReply(rejects, yield* programUnavailableFor(rejectSent))
          yield* Effect.sleep("10 millis")
          assert.isDefined(goodSent)
          yield* handler.callbackReply(answers, yield* callbackReplyFor(goodSent, session))
          assert.isTrue(yield* Fiber.join(probe), "the second carrier still wins")
        }).pipe(Effect.provide(Testing.layer()))
    )
    it.effect("should reject a requested backchannel that offers no slots when a requested backchannel has no slots", () =>
      Effect.gen(function*() {
        const handler = yield* backChannelHandler("2 seconds")
        const client = connection(1)

        const reply = yield* make.openReader(
          yield* handler.compound(yield* call([exchangeId("noslots")], "probe", client)),
          limits
        )

        yield* reply.read(XdrCodec.uint32)
        yield* reply.read(XdrCodec.string())

        for (let field = 0; field < 3; field++) yield* reply.read(XdrCodec.uint32)
        const clientId = yield* reply.read(XdrCodec.uint64)

        // CONN_BACK_CHAN with ca_maxrequests zero: a backchannel that can carry nothing. Section
        // 18.36.3 forbids changing ca_maxrequests, so it cannot be rounded up either.
        const created = yield* handler.compound(
          yield* call(
            [(writer) =>
              Effect.gen(function*() {
                yield* Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.CREATE_SESSION)
                  yield* writer.write(XdrCodec.uint64, clientId)
                  yield* writer.write(XdrCodec.uint32, 1)
                  yield* writer.write(XdrCodec.uint32, 2)
                })
                yield* channel(writer, 2)
                yield* channel(writer, 0)
                yield* Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, callbackProgram)
                  yield* writer.write(XdrCodec.uint32, [0].length)

                  for (const xdrValue of [0]) {
                    yield* ((item, flavor) =>
                      Effect.gen(function*() {
                        const xdrWriter = item
                        yield* xdrWriter.write(XdrCodec.uint32, flavor)
                      }))(writer, xdrValue)
                  }
                })
              })],
            "probe",
            client
          )
        )

        assert.deepStrictEqual((yield* statuses(created)).operations, [[Operation.CREATE_SESSION, Status.TOOSMALL]])
      }).pipe(Effect.provide(Testing.layer())))
    live(
      "should reject a callback reply whose RPC verifier exceeds an opaque_auth body when a callback reply verifier exceeds opaque_auth",
      () =>
        Effect.gen(function*() {
          const handler = yield* backChannelHandler("50 millis")
          let sent: Uint8Array | undefined

          const client = connection(1, (message) => {
            sent = message

            return true
          })

          const {
            session
          } = yield* startSession(handler, "bigverf", {}, new Uint8Array(8), client, 2)

          const probe = yield* Effect.forkChild(handler.probeBackChannel(session))
          yield* Effect.yieldNow
          assert.isDefined(sent)
          const xid = new DataView(sent.buffer, sent.byteOffset, sent.byteLength).getUint32(0)

          // A 500-byte verifier cannot appear in a valid RPC reply; RFC 5531 caps opaque_auth at 400.
          const oversized = yield* Effect.gen(function*() {
            const xdrWriter = yield* make.openWriter(limits, 4294967295)
            yield* xdrWriter.write(XdrCodec.uint32, xid)
            yield* xdrWriter.write(XdrCodec.uint32, 1)
            yield* xdrWriter.write(XdrCodec.uint32, 0)
            yield* xdrWriter.write(XdrCodec.uint32, 0)
            yield* xdrWriter.write(XdrCodec.opaque(), new Uint8Array(500))
            yield* xdrWriter.write(XdrCodec.uint32, 0)
            yield* xdrWriter.write(XdrCodec.uint32, Status.OK)
            yield* xdrWriter.write(XdrCodec.string(), "probe")
            yield* xdrWriter.write(XdrCodec.uint32, 1)
            yield* xdrWriter.write(XdrCodec.uint32, 11)
            yield* xdrWriter.write(XdrCodec.uint32, Status.OK)
            yield* xdrWriter.write(XdrCodec.fixedOpaque(session.length), session)
            yield* xdrWriter.write(XdrCodec.uint32, 1)
            yield* xdrWriter.write(XdrCodec.uint32, 0)
            yield* xdrWriter.write(XdrCodec.uint32, 0)
            yield* xdrWriter.write(XdrCodec.uint32, 0)

            return yield* xdrWriter.bytes
          })

          yield* handler.callbackReply(client, oversized)
          assert.isFalse(yield* Fiber.join(probe), "an invalid RPC reply is not a working path")
        }).pipe(Effect.provide(Testing.layer()))
    )
    it.effect("should omit the callback when its full RPC call exceeds the client's ca_maxrequestsize", () =>
      Effect.gen(function*() {
        const handler = yield* backChannelHandler("2 seconds")

        const client = connection(1, () => {
          throw new Error("a callback larger than the client accepts must not be sent")
        })

        const reply = yield* make.openReader(
          yield* handler.compound(yield* call([exchangeId("tight")], "probe", client)),
          limits
        )

        yield* reply.read(XdrCodec.uint32)
        yield* reply.read(XdrCodec.string())

        for (let field = 0; field < 3; field++) yield* reply.read(XdrCodec.uint32)
        const clientId = yield* reply.read(XdrCodec.uint64)

        // 96 bytes is above the minimum a channel must carry, and above the 64-byte CB_COMPOUND
        // body, but below the ~104-byte RPC call that body actually travels in.
        const created = yield* handler.compound(
          yield* call(
            [(writer) =>
              Effect.gen(function*() {
                yield* Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.CREATE_SESSION)
                  yield* writer.write(XdrCodec.uint64, clientId)
                  yield* writer.write(XdrCodec.uint32, 1)
                  yield* writer.write(XdrCodec.uint32, 2)
                })
                yield* channel(writer, 2)
                yield* channel(writer, 2, {
                  maxRequest: 96
                })
                yield* Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, callbackProgram)
                  yield* writer.write(XdrCodec.uint32, [0].length)

                  for (const xdrValue of [0]) {
                    yield* ((item, flavor) =>
                      Effect.gen(function*() {
                        const xdrWriter = item
                        yield* xdrWriter.write(XdrCodec.uint32, flavor)
                      }))(writer, xdrValue)
                  }
                })
              })],
            "probe",
            client
          )
        )

        assert.strictEqual((yield* statuses(created)).operations[0]![1], Status.OK)
        const reader = yield* make.openReader(created, limits)
        yield* reader.read(XdrCodec.uint32)
        yield* reader.read(XdrCodec.string())

        for (let field = 0; field < 3; field++) yield* reader.read(XdrCodec.uint32)
        const session = yield* reader.read(XdrCodec.fixedOpaque(16))
        assert.isFalse(yield* handler.probeBackChannel(session))
      }).pipe(Effect.provide(Testing.layer())))
    live(
      "should not let a stale probe overwrite the verdict of a re-armed path when an earlier callback probe finishes after re-arming",
      () =>
        Effect.gen(function*() {
          const handler = yield* backChannelHandler("80 millis")
          const sends: Array<Uint8Array> = []

          const client = connection(1, (message) => {
            sends.push(message)

            return true
          })

          const {
            session
          } = yield* startSession(handler, "stale", {}, new Uint8Array(8), client, 2)

          // The first SEQUENCE probes automatically; answer it so the path starts up.
          yield* handler.compound(yield* call([sequence(session, 1)], "probe", client))
          yield* Effect.yieldNow
          assert.strictEqual(sends.length, 1)
          yield* handler.callbackReply(client, yield* callbackReplyFor(sends[0]!, session))

          // A second probe that will never be answered, still in flight below.
          const stale = yield* Effect.forkChild(handler.probeBackChannel(session))
          yield* Effect.yieldNow
          assert.strictEqual(sends.length, 2)

          // Re-arm the path, then probe it successfully.
          yield* handler.compound(
            yield* call(
              [sequence(session, 2), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.BACKCHANNEL_CTL)
                  yield* writer.write(XdrCodec.uint32, callbackProgram)
                  yield* writer.write(XdrCodec.uint32, [0].length)

                  for (const xdrValue of [0]) {
                    yield* ((item, flavor) =>
                      Effect.gen(function*() {
                        const xdrWriter = item
                        yield* xdrWriter.write(XdrCodec.uint32, flavor)
                      }))(writer, xdrValue)
                  }
                })],
              "probe",
              client
            )
          )
          const fresh = yield* Effect.forkChild(handler.probeBackChannel(session))
          yield* Effect.yieldNow
          const latest = sends.length - 1
          yield* handler.callbackReply(client, yield* callbackReplyFor(sends[latest]!, session))
          assert.isTrue(yield* Fiber.join(fresh), "the re-armed path answers")

          // The stale probe times out afterwards. Its verdict is about a path the client has already
          // replaced, so it must not drag the current one back down.
          assert.isFalse(yield* Fiber.join(stale))

          const reply = yield* make.openReader(
            yield* handler.compound(yield* call([sequence(session, 3)], "probe", client)),
            limits
          )

          assert.strictEqual(yield* reply.read(XdrCodec.uint32), Status.OK)
          yield* reply.read(XdrCodec.string())

          for (let field = 0; field < 3; field++) yield* reply.read(XdrCodec.uint32)
          yield* reply.read(XdrCodec.fixedOpaque(16))

          for (let field = 0; field < 4; field++) yield* reply.read(XdrCodec.uint32)
          assert.strictEqual(yield* reply.read(XdrCodec.uint32), 0, "the re-armed path is still reported up")
        }).pipe(Effect.provide(Testing.layer()))
    )
    live("should re-arm the probe when every backchannel slot is already in flight", () =>
      Effect.gen(function*() {
        const handler = yield* backChannelHandler("80 millis")
        let attempts = 0

        const client = connection(1, () => {
          attempts++

          return true
        })

        // One slot, and it is occupied by a probe that is still waiting for a reply.
        const {
          session
        } = yield* startSession(handler, "busy", {}, new Uint8Array(8), client, 1)

        const holding = yield* Effect.forkChild(handler.probeBackChannel(session))
        yield* Effect.yieldNow
        assert.strictEqual(attempts, 1)

        // A SEQUENCE now finds no free slot. That probe never ran, so it must not consume the
        // arming and leave the path untested forever.
        yield* handler.compound(yield* call([sequence(session, 1)], "probe", client))
        yield* Effect.yieldNow
        yield* Fiber.join(holding)
        yield* handler.compound(yield* call([sequence(session, 2)], "probe", client))
        yield* Effect.sleep("120 millis")
        assert.isAbove(attempts, 1, "a later SEQUENCE probes once a slot is free")
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should bound a compound carrying BACKCHANNEL_CTL by its worst case before it mutates when BACKCHANNEL_CTL could produce an oversized reply", () =>
      Effect.gen(function*() {
        const handler = yield* backChannelHandler("2 seconds")
        const client = connection(1)

        // Room for SEQUENCE plus a small result, but not for a worst-case GETATTR after it.
        const {
          session
        } = yield* startSession(
          handler,
          "bounded",
          {
            maxResponse: 320
          },
          new Uint8Array(8),
          client,
          2
        )

        const allAttributes = [0xffff_ffff, 0xffff_ffff, 0xffff]

        // BACKCHANNEL_CTL replaces the callback program and re-arms the probe, so the reply must be
        // bounded by the worst case before any of that happens. Otherwise the mutation lands and
        // the reply overflows afterwards, with only SEQUENCE rolled back.
        const tooBig = yield* handler.compound(
          yield* call(
            [
              sequence(session, 1),
              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.BACKCHANNEL_CTL)
                  yield* writer.write(XdrCodec.uint32, 0x4000_0002)
                  yield* writer.write(XdrCodec.uint32, [0].length)

                  for (const xdrValue of [0]) {
                    yield* ((item, flavor) =>
                      Effect.gen(function*() {
                        const xdrWriter = item
                        yield* xdrWriter.write(XdrCodec.uint32, flavor)
                      }))(writer, xdrValue)
                  }
                }),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.GETATTR)
                  yield* writer.write(XdrCodec.uint32, allAttributes.length)

                  for (const xdrValue of allAttributes) {
                    yield* ((item, word) =>
                      Effect.gen(function*() {
                        const xdrWriter = item
                        yield* xdrWriter.write(XdrCodec.uint32, word)
                      }))(writer, xdrValue)
                  }
                })
            ],
            "probe",
            client
          )
        )

        const rejected = yield* statuses(tooBig)
        assert.strictEqual(rejected.status, Status.REP_TOO_BIG)
        assert.strictEqual(rejected.operations.length, 1, "rejected at SEQUENCE, before BACKCHANNEL_CTL ran")

        // The callback program was never replaced: a probe still goes to the originally negotiated
        // program number.
        let program: number | undefined

        const observer = {
          id: 2,
          send: (message: Uint8Array) =>
            Effect.gen(function*() {
              const reader = yield* make.openReader(message, limits)

              for (let field = 0; field < 3; field++) yield* reader.read(XdrCodec.uint32)
              program = yield* reader.read(XdrCodec.uint32)

              return true
            }).pipe(Effect.orDie)
        }

        yield* handler.compound(
          yield* call(
            [(writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.BIND_CONN_TO_SESSION)
                yield* writer.write(XdrCodec.fixedOpaque(session.length), session)
                yield* writer.write(XdrCodec.uint32, 2)
                yield* writer.write(XdrCodec.boolean, false)
              })],
            "probe",
            observer
          )
        )
        yield* Effect.forkChild(handler.probeBackChannel(session))
        yield* Effect.yieldNow
        assert.strictEqual(program, callbackProgram, "the unapplied BACKCHANNEL_CTL did not change it")
      }).pipe(Effect.provide(Testing.layer())))
    live(
      "should reject a callback reply that is not exactly one complete CB_SEQUENCE result when a callback reply lacks one complete CB_SEQUENCE result",
      () =>
        Effect.gen(function*() {
          const handler = yield* backChannelHandler("50 millis")
          let sent: Uint8Array | undefined

          const client = connection(1, (message) => {
            sent = message

            return true
          })

          const {
            session
          } = yield* startSession(handler, "malformed", {}, new Uint8Array(8), client, 2)

          /** Builds a reply whose CB_SEQUENCE result is deliberately malformed in one way. */
          const malformed = (request: Uint8Array, results: number, defect: "truncated" | "complete" | "trailing") =>
            Effect.gen(function*() {
              const xid = new DataView(request.buffer, request.byteOffset, request.byteLength).getUint32(0)

              const writer = yield* Effect.gen(function*() {
                const xdrWriter = yield* make.openWriter(limits, 4294967295)
                yield* xdrWriter.write(XdrCodec.uint32, xid)
                yield* xdrWriter.write(XdrCodec.uint32, 1)
                yield* xdrWriter.write(XdrCodec.uint32, 0)
                yield* xdrWriter.write(XdrCodec.uint32, 0)
                yield* xdrWriter.write(XdrCodec.opaque(), new Uint8Array())
                yield* xdrWriter.write(XdrCodec.uint32, 0)
                yield* xdrWriter.write(XdrCodec.uint32, Status.OK)
                yield* xdrWriter.write(XdrCodec.string(), "probe")
                yield* xdrWriter.write(XdrCodec.uint32, results)
                yield* xdrWriter.write(XdrCodec.uint32, 11)
                yield* xdrWriter.write(XdrCodec.uint32, Status.OK)
                yield* xdrWriter.write(XdrCodec.fixedOpaque(session.length), session)
                yield* xdrWriter.write(XdrCodec.uint32, 1)
                yield* xdrWriter.write(XdrCodec.uint32, 0)

                return xdrWriter
              })

              // csr_highest_slotid and csr_target_highest_slotid are mandatory.
              if (defect !== "truncated") {
                yield* Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, 0)
                  yield* writer.write(XdrCodec.uint32, 0)
                })
              }

              if (defect === "trailing") {
                yield* writer.write(XdrCodec.uint32, 0xdead_beef)
              }

              return yield* writer.bytes
            })

          const probeWith = (build: (request: Uint8Array) => Effect.Effect<Uint8Array, XdrEncodeError>) =>
            Effect.gen(function*() {
              sent = undefined
              const probe = yield* Effect.forkChild(handler.probeBackChannel(session))
              yield* Effect.yieldNow
              assert.isDefined(sent)
              yield* handler.callbackReply(client, yield* build(sent))

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
        }).pipe(Effect.provide(Testing.layer()))
    )
  })
})

describe("CompoundBasics", () => {
  it.layer(NodeCrypto.layer)("NFSv4.1 CompoundBasics", (it) => {
    it.effect("should report writable directory access for an authorized mapped caller when an authorized mapped caller requests directory ACCESS", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const { handler, session } = yield* openSession(caller, "writable-access", {
          writable: true,
          callerFor: () => Effect.succeed(caller)
        })

        const reply = yield* handler.compound(
          yield* call([
            sequence(session, 1),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.ACCESS)
                yield* writer.write(XdrCodec.uint32, 0x1f)
              })
          ])
        )

        const reader = yield* make.openReader(reply, limits)
        assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
        yield* reader.read(XdrCodec.string())
        assert.strictEqual(yield* reader.read(XdrCodec.uint32), 3)
        assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.SEQUENCE)
        assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
        yield* reader.read(XdrCodec.fixedOpaque(16))

        for (let field = 0; field < 5; field++) yield* reader.read(XdrCodec.uint32)
        assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.PUTROOTFH)
        assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
        assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.ACCESS)
        assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
        assert.strictEqual(yield* reader.read(XdrCodec.uint32), 0x1f)
        assert.strictEqual(yield* reader.read(XdrCodec.uint32), 0x1f)
        yield* reader.finish
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should use the mapped caller for ACCESS and OPEN when ACCESS and OPEN are sent for a mapped identity", () =>
      Effect.gen(function*() {
        const admin = yield* Vfs.Caller

        yield* admin.writeFile("/secret", new Uint8Array([1]), {
          access: "write",
          create: "exclusive",
          mode: 0o600
        })
        yield* admin.chown("/secret", {
          uid: 1000,
          gid: 1000
        })
        yield* admin.chmod("/", 0o111)

        const owner = yield* Testing.callerAs({
          uid: 1000,
          gid: 1000,
          groups: [],
          privileged: false
        })

        const guest = yield* Testing.callerAs({
          uid: 2000,
          gid: 2000,
          groups: [],
          privileged: false
        })

        const ownerConnection = connection(101)
        const guestConnection = connection(102)
        let downgradeOwner = false

        const sys = (uid: number): Credentials => ({
          _tag: "Sys",
          stamp: 0,
          machineName: "test-client",
          uid,
          gid: uid,
          supplementaryGroups: []
        })

        const handler = yield* makeHandler(admin, {
          securityFlavors: [1],
          callerFor: (request) =>
            Effect.succeed(
              Predicate.isTagged(request.credentials, "Sys") && request.credentials.uid === 1000 && !downgradeOwner
                ? owner
                : guest
            )
        })

        const first = yield* startSession(
          handler,
          "mapped-owner",
          {},
          new Uint8Array(8),
          ownerConnection,
          0,
          undefined,
          sys(1000)
        )

        const second = yield* startSession(
          handler,
          "mapped-guest",
          {},
          new Uint8Array(8),
          guestConnection,
          0,
          undefined,
          sys(2000)
        )

        const check = (session: Uint8Array, on: typeof ownerConnection, uid: number) =>
          Effect.gen(function*() {
            return yield* handler.compound(
              yield* call(
                [sequence(session, 1, true), (writer) =>
                  writer.write(XdrCodec.uint32, Operation.PUTROOTFH), (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                    yield* writer.write(XdrCodec.string(), "secret")
                  }), (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.ACCESS)
                    yield* writer.write(XdrCodec.uint32, 1)
                  })],
                "mapped-access",
                on,
                sys(uid)
              )
            )
          })

        const ownerAccess = yield* make.openReader(yield* check(first.session, ownerConnection, 1000), limits)
        const guestAccess = yield* make.openReader(yield* check(second.session, guestConnection, 2000), limits)

        for (const [reader, granted] of [[ownerAccess, 1], [guestAccess, 0]] as const) {
          assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
          yield* reader.read(XdrCodec.string())
          assert.strictEqual(yield* reader.read(XdrCodec.uint32), 4)
          yield* reader.read(XdrCodec.uint32)
          yield* reader.read(XdrCodec.uint32)
          yield* reader.read(XdrCodec.fixedOpaque(16))

          for (let field = 0; field < 5; field++) yield* reader.read(XdrCodec.uint32)

          for (const operation of [Operation.PUTROOTFH, Operation.LOOKUP]) {
            assert.strictEqual(yield* reader.read(XdrCodec.uint32), operation)
            assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
          }

          assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.ACCESS)
          assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
          assert.strictEqual(yield* reader.read(XdrCodec.uint32), 1)
          assert.strictEqual(yield* reader.read(XdrCodec.uint32), granted)
          yield* reader.finish
        }

        downgradeOwner = true
        const replay = yield* Effect.exit(check(first.session, ownerConnection, 1000))
        assert.strictEqual(Exit.isFailure(replay), true)
        downgradeOwner = false

        const opened = yield* handler.compound(
          yield* call(
            [
              sequence(first.session, 2),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openReadOnly(first.client, "secret"),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ],
            "owner-open",
            ownerConnection,
            sys(1000)
          )
        )

        assert.strictEqual((yield* statuses(opened)).status, Status.OK)
        const ownedOpen = yield* parseOpen(opened)
        downgradeOwner = true

        const read = yield* handler.compound(
          yield* call(
            [sequence(first.session, 3), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                yield* writer.write(XdrCodec.opaque(), ownedOpen.filehandle)
              }), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.READ)
                yield* writer.write(XdrCodec.fixedOpaque(ownedOpen.stateid.length), ownedOpen.stateid)
                yield* writer.write(XdrCodec.uint64, 0n)
                yield* writer.write(XdrCodec.uint32, 1)
              })],
            "downgraded-read",
            ownerConnection,
            sys(1000)
          )
        )

        assert.strictEqual((yield* statuses(read)).status, Status.ACCESS)

        const reopened = yield* handler.compound(
          yield* call(
            [
              sequence(first.session, 4),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openReadOnly(first.client, "secret")
            ],
            "downgraded-open",
            ownerConnection,
            sys(1000)
          )
        )

        assert.strictEqual((yield* statuses(reopened)).status, Status.ACCESS)

        for (const [index, operation] of [Operation.SECINFO, Operation.SECINFO_NO_NAME].entries()) {
          const response = yield* make.openReader(
            yield* handler.compound(
              yield* call(
                [
                  sequence(first.session, 5 + index),
                  (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                  (writer) =>
                    operation === Operation.SECINFO ?
                      Effect.gen(function*() {
                        yield* writer.write(XdrCodec.uint32, operation)
                        yield* writer.write(XdrCodec.string(), "secret")
                      }) :
                      Effect.gen(function*() {
                        yield* writer.write(XdrCodec.uint32, operation)
                        yield* writer.write(XdrCodec.uint32, 0)
                      })
                ],
                "network-security-flavors",
                ownerConnection,
                sys(1000)
              )
            ),
            limits
          )

          assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.OK)
          yield* response.read(XdrCodec.string())
          assert.strictEqual(yield* response.read(XdrCodec.uint32), 3)
          yield* response.read(XdrCodec.uint32)
          yield* response.read(XdrCodec.uint32)
          yield* response.read(XdrCodec.fixedOpaque(16))

          for (let field = 0; field < 5; field++) yield* response.read(XdrCodec.uint32)
          yield* response.read(XdrCodec.uint32)
          yield* response.read(XdrCodec.uint32)
          assert.strictEqual(yield* response.read(XdrCodec.uint32), operation)
          assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.OK)
          assert.deepStrictEqual(yield* response.read(XdrCodec.array(XdrCodec.uint32)), [1])
          yield* response.finish
        }

        const refused = yield* handler.compound(
          yield* call(
            [
              sequence(second.session, 2),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openReadOnly(second.client, "secret")
            ],
            "guest-open",
            guestConnection,
            sys(2000)
          )
        )

        assert.strictEqual((yield* statuses(refused)).status, Status.ACCESS)
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))
    it.effect("should use both storage incarnation and server generation for COMMIT when a client requests COMMIT after a storage or server restart", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        const verifiers: Array<Uint8Array> = []

        for (const [serverByte, storageByte] of [[7, 9], [8, 9], [6, 8]] as const) {
          const serverGeneration = generation.map(() => serverByte)
          const storageGeneration = generation.map(() => storageByte)

          const { handler, session } = yield* openSession(caller, "commit-storage-generation", {
            generation: serverGeneration,
            storageGeneration
          })

          const response = yield* make.openReader(
            yield* handler.compound(
              yield* call([
                sequence(session, 1),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                    yield* writer.write(XdrCodec.string(), "file")
                  }),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.COMMIT)
                    yield* writer.write(XdrCodec.uint64, 0n)
                    yield* writer.write(XdrCodec.uint32, 0)
                  })
              ])
            ),
            limits
          )

          assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.OK)
          yield* response.read(XdrCodec.string())
          assert.strictEqual(yield* response.read(XdrCodec.uint32), 4)
          assert.strictEqual(yield* response.read(XdrCodec.uint32), Operation.SEQUENCE)
          assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.OK)
          yield* response.read(XdrCodec.fixedOpaque(16))

          for (let field = 0; field < 5; field++) yield* response.read(XdrCodec.uint32)

          for (const operation of [Operation.PUTROOTFH, Operation.LOOKUP, Operation.COMMIT]) {
            assert.strictEqual(yield* response.read(XdrCodec.uint32), operation)
            assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.OK)
          }

          verifiers.push(yield* response.read(XdrCodec.fixedOpaque(8)))
          yield* response.finish
        }

        assert.strictEqual(verifiers.length, 3)
        assert.isFalse(verifiers[0]!.every((byte, index) => byte === verifiers[1]![index]))
        assert.isFalse(verifiers[0]!.every((byte, index) => byte === verifiers[2]![index]))
        assert.isFalse(verifiers[1]!.every((byte, index) => byte === verifiers[2]![index]))
      }).pipe(Effect.provide(Testing.layer())))
    it("should wrap client sequence IDs at the uint32 boundary when a client sequence ID reaches the uint32 boundary", () => {
      assert.strictEqual(nextSequenceId(1), 2)
      assert.strictEqual(nextSequenceId(0xffff_ffff), 0)
    })
    it("should use the RFC wire numbers for negotiated channel errors when a negotiated channel violates its limits", () => {
      assert.strictEqual(Status.REQ_TOO_BIG, 10065)
      assert.strictEqual(Status.REP_TOO_BIG, 10066)
      assert.strictEqual(Status.REP_TOO_BIG_TO_CACHE, 10067)
    })
    it.effect("should echo the tag, executes in order, and stop at a missing LOOKUP when a compound contains a missing LOOKUP", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const export_ = yield* exportFor(caller)

        const handler = yield* handlerFor(export_)

        const {
          session
        } = yield* startSession(handler, "missing-client")

        const response = yield* handler.compound(
          yield* call([
            sequence(session, 1),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                yield* writer.write(XdrCodec.string(), "missing")
              }),
            (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
          ], "missing-probe")
        )

        assert.deepStrictEqual(yield* statuses(response), {
          status: Status.NOENT,
          tag: "missing-probe",
          operations: [[Operation.SEQUENCE, Status.OK], [Operation.PUTROOTFH, Status.OK], [
            Operation.LOOKUP,
            Status.NOENT
          ]]
        })
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should save and restore the current filehandle within a compound when SAVEFH and RESTOREFH run in one compound", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const { handler, session } = yield* openSession(caller, "saved-filehandle")

        const response = yield* handler.compound(
          yield* call([
            sequence(session, 1),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
            (writer) => writer.write(XdrCodec.uint32, Operation.SAVEFH),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                yield* writer.write(XdrCodec.string(), "child")
              }),
            (writer) => writer.write(XdrCodec.uint32, Operation.RESTOREFH),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                yield* writer.write(XdrCodec.string(), "child")
              })
          ])
        )

        assert.strictEqual((yield* statuses(response)).status, Status.OK)
      }).pipe(
        Effect.provide(
          Testing.layer({ fixture: { entries: [{ kind: "file", path: "/child", bytes: new Uint8Array([1]) }] } })
        )
      ))
    it.effect("should advertise the client ID as a non-pNFS implementation when GETATTR asks for the server implementation identity", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const handler = yield* makeHandler(caller)

        const response = yield* make.openReader(
          yield* handler.compound(yield* call([exchangeId("macos-client")])),
          limits
        )

        assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.OK)
        yield* response.read(XdrCodec.string())
        assert.strictEqual(yield* response.read(XdrCodec.uint32), 1)
        assert.strictEqual(yield* response.read(XdrCodec.uint32), Operation.EXCHANGE_ID)
        assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.OK)
        yield* response.read(XdrCodec.uint64)
        yield* response.read(XdrCodec.uint32)
        assert.strictEqual(yield* response.read(XdrCodec.uint32), 0x0001_0000)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should mark a repeated EXCHANGE_ID after CREATE_SESSION as confirmed when EXCHANGE_ID repeats after CREATE_SESSION", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const handler = yield* makeHandler(caller)

        const started = yield* startSession(handler, "confirmed-client")

        const response = yield* make.openReader(
          yield* handler.compound(yield* call([exchangeId("confirmed-client")])),
          limits
        )

        assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.OK)
        yield* response.read(XdrCodec.string())
        yield* response.read(XdrCodec.uint32)
        yield* response.read(XdrCodec.uint32)
        yield* response.read(XdrCodec.uint32)
        assert.strictEqual(yield* response.read(XdrCodec.uint64), started.client)
        yield* response.read(XdrCodec.uint32)
        assert.strictEqual(yield* response.read(XdrCodec.uint32), 0x8001_0000)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should apply confirmed-record EXCHANGE_ID update rules when an existing client record receives EXCHANGE_ID", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const handler = yield* makeHandler(caller)

        const update = (owner: string, verifier: Uint8Array) =>
          call([(writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.EXCHANGE_ID)
              yield* writer.write(XdrCodec.fixedOpaque(verifier.length), verifier)
              yield* writer.write(XdrCodec.string(), owner)
              yield* writer.write(XdrCodec.uint32, 0x4000_0000)
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.uint32, 0)
            })])

        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(yield* update("missing-update", new Uint8Array(8))),
            limits
          )).read(XdrCodec.uint32),
          Status.NOENT
        )
        const verifier = new Uint8Array(8).fill(3)
        const started = yield* startSession(handler, "confirmed-update", {}, verifier)
        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(yield* update("confirmed-update", new Uint8Array(8).fill(4))),
            limits
          )).read(XdrCodec.uint32),
          Status.NOT_SAME
        )
        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(yield* call([exchangeId("confirmed-update", new Uint8Array(8).fill(5))])),
            limits
          )).read(XdrCodec.uint32),
          Status.OK
        )

        const matching = yield* make.openReader(
          yield* handler.compound(yield* update("confirmed-update", verifier)),
          limits
        )

        assert.strictEqual(yield* matching.read(XdrCodec.uint32), Status.OK)
        yield* matching.read(XdrCodec.string())
        yield* matching.read(XdrCodec.uint32)
        yield* matching.read(XdrCodec.uint32)
        yield* matching.read(XdrCodec.uint32)
        assert.strictEqual(yield* matching.read(XdrCodec.uint64), started.client)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should reject EXCHANGE_ID argument flags that are not valid for clients when a client sends invalid EXCHANGE_ID flags", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxClients: 1
        }

        const handler = yield* makeHandler(caller, { limits: constrained })

        const invalid = yield* call([(writer) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.EXCHANGE_ID)
            yield* writer.write(XdrCodec.fixedOpaque(new Uint8Array(8).length), new Uint8Array(8))
            yield* writer.write(XdrCodec.string(), "invalid-flags")
            yield* writer.write(XdrCodec.uint32, 0x8000_0000)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.uint32, 0)
          })])

        assert.strictEqual(
          yield* (yield* make.openReader(yield* handler.compound(invalid), constrained)).read(XdrCodec.uint32),
          Status.INVAL
        )

        const requestedNonPnfs = yield* call([(writer) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.EXCHANGE_ID)
            yield* writer.write(XdrCodec.fixedOpaque(new Uint8Array(8).length), new Uint8Array(8))
            yield* writer.write(XdrCodec.string(), "valid-flags")
            yield* writer.write(XdrCodec.uint32, 0x0001_0000)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.uint32, 0)
          })])

        assert.strictEqual(
          yield* (yield* make.openReader(yield* handler.compound(requestedNonPnfs), constrained)).read(XdrCodec.uint32),
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should accept the AUTH_SYS callback credential sent by macOS when a macOS client offers AUTH_SYS for callbacks", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const handler = yield* makeHandler(caller)

        const exchange = yield* make.openReader(
          yield* handler.compound(yield* call([exchangeId("macos-session")])),
          limits
        )

        yield* exchange.read(XdrCodec.uint32)
        yield* exchange.read(XdrCodec.string())
        yield* exchange.read(XdrCodec.uint32)
        yield* exchange.read(XdrCodec.uint32)
        yield* exchange.read(XdrCodec.uint32)
        const client = yield* exchange.read(XdrCodec.uint64)

        const response = yield* handler.compound(
          yield* call([(writer) =>
            Effect.gen(function*() {
              yield* Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.CREATE_SESSION)
                yield* writer.write(XdrCodec.uint64, client)
                yield* writer.write(XdrCodec.uint32, 1)
                yield* writer.write(XdrCodec.uint32, 2)
              })
              yield* channel(writer, 64)
              yield* channel(writer, 4)
              yield* Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, 8_388_608)
                yield* writer.write(XdrCodec.uint32, 1)
                yield* authSysCallback(writer)
              })
            })], "createsession")
        )

        const result = yield* make.openReader(response, limits)
        assert.strictEqual(yield* result.read(XdrCodec.uint32), Status.OK)
        assert.strictEqual(yield* result.read(XdrCodec.string()), "createsession")
        assert.strictEqual(yield* result.read(XdrCodec.uint32), 1)
        assert.strictEqual(yield* result.read(XdrCodec.uint32), Operation.CREATE_SESSION)
        assert.strictEqual(yield* result.read(XdrCodec.uint32), Status.OK)
        yield* result.read(XdrCodec.fixedOpaque(16))
        assert.strictEqual(yield* result.read(XdrCodec.uint32), 1)

        // csa_flags asked for CONN_BACK_CHAN, so csr_flags must echo it: the client binds the
        // connection to the backchannel on the strength of this echo (Section 18.36.3).
        assert.strictEqual(yield* result.read(XdrCodec.uint32), 2)
        assert.deepStrictEqual(
          yield* Effect.forEach(
            Array.from({
              length: 6
            }),
            () => result.read(XdrCodec.uint32)
          ),
          [0, 65_536, 65_536, 65_536, 32, 4]
        )
        assert.deepStrictEqual(yield* result.read(XdrCodec.array(XdrCodec.uint32)), [])
        assert.deepStrictEqual(
          yield* Effect.forEach(
            Array.from({
              length: 6
            }),
            () => result.read(XdrCodec.uint32)
          ),
          [0, 65_536, 65_536, 65_536, 32, 4]
        )
        assert.deepStrictEqual(yield* result.read(XdrCodec.array(XdrCodec.uint32)), [])
        yield* result.finish
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should negotiate and enforce full RPC record bounds when RPC records approach the configured byte bounds", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxRecordBytes: ByteSize.bytes(2_048)
        }

        const handler = yield* makeHandler(caller, { limits: constrained })

        const exchange = yield* make.openReader(
          yield* handler.compound(yield* call([exchangeId("rpc-bounds")])),
          limits
        )

        yield* exchange.read(XdrCodec.uint32)
        yield* exchange.read(XdrCodec.string())
        yield* exchange.read(XdrCodec.uint32)
        yield* exchange.read(XdrCodec.uint32)
        yield* exchange.read(XdrCodec.uint32)
        const client = yield* exchange.read(XdrCodec.uint64)

        const created = yield* make.openReader(
          yield* handler.compound(
            yield* call([(writer) =>
              Effect.gen(function*() {
                yield* Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.CREATE_SESSION)
                  yield* writer.write(XdrCodec.uint64, client)
                  yield* writer.write(XdrCodec.uint32, 1)
                  yield* writer.write(XdrCodec.uint32, 0)
                })
                yield* channel(writer, 2)
                yield* channel(writer, 0)
                yield* Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, 0)
                  yield* writer.write(XdrCodec.uint32, 0)
                })
              })])
          ),
          limits
        )

        assert.strictEqual(yield* created.read(XdrCodec.uint32), Status.OK)
        yield* created.read(XdrCodec.string())
        yield* created.read(XdrCodec.uint32)
        yield* created.read(XdrCodec.uint32)
        yield* created.read(XdrCodec.uint32)
        const session = yield* created.read(XdrCodec.fixedOpaque(16))
        yield* created.read(XdrCodec.uint32)
        yield* created.read(XdrCodec.uint32)
        assert.strictEqual(yield* created.read(XdrCodec.uint32), 0)
        assert.strictEqual(yield* created.read(XdrCodec.uint32), 2_048)
        assert.strictEqual(yield* created.read(XdrCodec.uint32), 2_048)

        const oversized = {
          ...(yield* call([sequence(session, 1)])),
          requestBytes: 2_049
        }

        assert.strictEqual(
          yield* (yield* make.openReader(yield* handler.compound(oversized), limits)).read(XdrCodec.uint32),
          Status.REQ_TOO_BIG
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should return BADXDR before a malformed read-only mutation can report ROFS when a malformed read-only mutation is decoded", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const handler = yield* makeHandler(caller)

        const malformed = yield* Effect.gen(function*() {
          const xdrWriter = yield* make.openWriter(limits, 4294967295)
          yield* xdrWriter.write(XdrCodec.string(), "bad")
          yield* xdrWriter.write(XdrCodec.uint32, 1)
          yield* xdrWriter.write(XdrCodec.uint32, 1)
          yield* xdrWriter.write(XdrCodec.uint32, Operation.WRITE)
          yield* xdrWriter.write(XdrCodec.fixedOpaque(new Uint8Array(16).length), new Uint8Array(16))

          return yield* xdrWriter.bytes
        })

        const reader = yield* make.openReader(
          yield* handler.compound({
            connection: connection(),
            credentials: {
              _tag: "None"
            },
            arguments: malformed
          }),
          limits
        )

        assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.BADXDR)
        assert.strictEqual(yield* reader.read(XdrCodec.string()), "bad")

        const {
          session
        } = yield* startSession(handler, "writer")

        const write = yield* call([
          sequence(session, 1),
          (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.WRITE)
              yield* writer.write(XdrCodec.fixedOpaque(new Uint8Array(16).length), new Uint8Array(16))
              yield* writer.write(XdrCodec.uint64, 0n)
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.opaque(), new Uint8Array([1]))
            })
        ])

        assert.strictEqual((yield* statuses(yield* handler.compound(write))).status, Status.ROFS)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should reject trailing compound bytes and unsupported minor versions when a compound has trailing bytes or an unsupported minor version", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const handler = yield* makeHandler(caller)

        const valid = (yield* call([])).arguments
        const trailing = new Uint8Array(valid.length + 4)
        trailing.set(valid)

        const malformed = yield* make.openReader(
          yield* handler.compound({
            connection: connection(),
            credentials: {
              _tag: "None"
            },
            arguments: trailing
          }),
          limits
        )

        assert.strictEqual(yield* malformed.read(XdrCodec.uint32), Status.BADXDR)

        const wrongMinor = yield* Effect.gen(function*() {
          const xdrWriter = yield* make.openWriter(limits, 4294967295)
          yield* xdrWriter.write(XdrCodec.string(), "minor")
          yield* xdrWriter.write(XdrCodec.uint32, 0)
          yield* xdrWriter.write(XdrCodec.uint32, 0)

          return yield* xdrWriter.bytes
        })

        const response = yield* make.openReader(
          yield* handler.compound({
            connection: connection(),
            credentials: {
              _tag: "None"
            },
            arguments: wrongMinor
          }),
          limits
        )

        assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.MINOR_VERS_MISMATCH)
        assert.strictEqual(yield* response.read(XdrCodec.string()), "minor")
        assert.strictEqual(yield* response.read(XdrCodec.uint32), 0)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should report TOO_MANY_OPS from the header count even when a later operation is malformed", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        const handler = yield* makeHandler(caller)
        const { session } = yield* startSession(handler, "count", { maxOperations: 3 })

        const oversized = call([
          sequence(session, 1),
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
              yield* writer.write(XdrCodec.uint32, 100)
            }),
          (writer) => writer.write(XdrCodec.uint32, Operation.GETFH),

          (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
        ])

        assert.deepStrictEqual((yield* run(handler, oversized)).operations, [
          { code: Operation.SEQUENCE, status: Status.TOO_MANY_OPS }
        ])
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should report an illegal first opcode as OP_ILLEGAL and a malformed operation in place when an opcode is illegal or its body is malformed", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        const handler = yield* makeHandler(caller)

        const illegal = yield* run(
          handler,
          call([(writer) => writer.write(XdrCodec.uint32, 99_999)])
        )

        assert.deepStrictEqual(illegal.operations, [{ code: Operation.ILLEGAL, status: Status.OP_ILLEGAL }])

        // A LOOKUP whose name length exceeds the remaining bytes never decodes.
        const truncatedLookup = (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
            yield* writer.write(XdrCodec.uint32, 100)
          })

        const beforeSession = yield* run(handler, call([truncatedLookup]))
        assert.deepStrictEqual(beforeSession.operations, [{ code: Operation.LOOKUP, status: Status.BADXDR }])

        const { session } = yield* startSession(handler, "malformed")

        const request = yield* call([
          sequence(session, 1, true),
          (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

          truncatedLookup,
          (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
        ])

        // Section 15.1.1.1: the operations before the malformed one are processed and reported.
        const first = yield* handler.compound(request)
        const reply = yield* decode(first)
        assert.strictEqual(reply.status, Status.BADXDR)
        assert.strictEqual(reply.operations.length, 3)
        assert.strictEqual(reply.operations[1]!.status, Status.OK)
        assert.deepStrictEqual(reply.operations[2], { code: Operation.LOOKUP, status: Status.BADXDR })

        // The slot was consumed, so the retry is served from the reply cache.
        assert.deepStrictEqual(yield* handler.compound(request), first)
      }).pipe(Effect.provide(Testing.layer())))
  })
})

describe("Create", () => {
  type Attributes = ReadonlyArray<readonly [number, WriteOperation]>

  const writeBitmap = (writer: EncoderSession, attributes: ReadonlyArray<number>) =>
    Effect.gen(function*() {
      const words = Array.from({
        length: attributes.length === 0 ? 0 : Math.floor(Math.max(...attributes) / 32) + 1
      }, () => 0)

      for (const attribute of attributes) words[Math.floor(attribute / 32)]! |= 1 << attribute % 32
      yield* writer.write(XdrCodec.uint32, words.length)

      for (const xdrValue of words) {
        yield* ((item, word) => item.write(XdrCodec.uint32, word >>> 0))(writer, xdrValue)
      }
    })

  const readBitmap = (reader: DecoderSession) =>
    Effect.gen(function*() {
      return (yield* reader.read(XdrCodec.array(XdrCodec.uint32))).flatMap((word, index) =>
        Array.from({
          length: 32
        }, (_, bit) => index * 32 + bit).filter((attribute) => (word & 1 << attribute % 32) !== 0)
      )
    })

  const create = (
    client: bigint,
    name: string,
    mode = 0,
    attrs: Attributes = [],
    verifier: Uint8Array = new Uint8Array(8).fill(17),
    access = 3,
    owner = "creator",
    deny = 0
  ) =>
  (writer: EncoderSession) =>
    Effect.gen(function*() {
      yield* writer.write(XdrCodec.uint32, Operation.OPEN)
      yield* writer.write(XdrCodec.uint32, 0)
      yield* writer.write(XdrCodec.uint32, access)
      yield* writer.write(XdrCodec.uint32, deny)
      yield* writer.write(XdrCodec.uint64, client)
      yield* writer.write(XdrCodec.string(), owner)
      yield* writer.write(XdrCodec.uint32, 1)
      yield* writer.write(XdrCodec.uint32, mode)

      if (mode === 2 || mode === 3) {
        yield* writer.write(XdrCodec.fixedOpaque(verifier.length), verifier)
      }

      if (mode !== 2) {
        yield* writeBitmap(writer, attrs.map(([attribute]) => attribute))
        const values = yield* make.openWriter(limits, 4294967295)

        for (const [, encode] of attrs) yield* encode(values)
        yield* writer.write(XdrCodec.opaque(), yield* values.bytes)
      }

      yield* writer.write(XdrCodec.uint32, 0)
      yield* writer.write(XdrCodec.string(), name)
    })

  const createCall = (
    client: bigint,
    session: Uint8Array,
    sequenceId: number,
    name = "file",
    mode = 0,
    attrs: Attributes = [],
    verifier?: Uint8Array,
    cache = true,
    owner = "creator"
  ) =>
    call([
      sequence(session, sequenceId, cache),
      (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
      create(client, name, mode, attrs, verifier, 3, owner),
      (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
    ])

  const responseStatus = (bytes: Uint8Array) =>
    Effect.gen(function*() {
      return yield* (yield* make.openReader(bytes, limits)).read(XdrCodec.uint32)
    })

  const afterRoot = (bytes: Uint8Array) =>
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

      return reader
    })

  const readCreate = (bytes: Uint8Array) =>
    Effect.gen(function*() {
      const reader = yield* afterRoot(bytes)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.OPEN)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
      const stateid = yield* reader.read(XdrCodec.fixedOpaque(16))
      const atomic = yield* reader.read(XdrCodec.boolean)
      const before = yield* reader.read(XdrCodec.uint64)
      const after = yield* reader.read(XdrCodec.uint64)
      yield* reader.read(XdrCodec.uint32)
      const attrs = yield* readBitmap(reader)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), 0)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.GETFH)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
      const filehandle = yield* reader.read(XdrCodec.opaque())
      yield* reader.finish

      return {
        stateid,
        filehandle,
        before,
        after,
        atomic,
        attrs
      }
    })

  const server = (caller: Vfs.Caller, volume: Vfs.Volume, options: {
    readonly maxOpens?: number
    readonly writable?: boolean
    readonly mapped?: Vfs.Caller
  } = {}) =>
    makeHandler(caller, {
      limits: {
        ...limits,
        maxOpens: options.maxOpens ?? limits.maxOpens
      },
      writable: options.writable ?? true,
      callerFor: () => Effect.succeed(options.mapped ?? caller)
    }).pipe(Effect.provideService(Vfs.Volume, volume))

  const setup = Effect.fnUntraced(function*(options: Parameters<typeof server>[2] = {}) {
    const volume = yield* Vfs.Volume
    const caller = yield* Vfs.Caller

    const handler = yield* server(caller, volume, options)
    const session = yield* startSession(handler, "create-client")

    return {
      volume,
      caller,
      handler,
      ...session
    }
  })

  const liveOptions: LiveVolume.Options = {
    maxImageBytes: ByteSize.kilobytes(64),
    volume: {
      maxEntries: 16,
      maxBytes: ByteSize.bytes(64),
      maxFileBytes: ByteSize.bytes(32),
      maxPathBytes: ByteSize.bytes(255)
    }
  }

  it.layer(NodeCrypto.layer)("NFS OPEN creation", (it) => {
    it.effect("should apply initial metadata and directory change information when OPEN4_CREATE supplies attributes", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          client,
          session
        } = yield* setup()

        const root = yield* caller.root
        const before = yield* caller.readDirectory(root)

        const opened = yield* readCreate(
          yield* handler.compound(
            yield* createCall(client, session, 1, "file", 0, [
              [4, (writer) => writer.write(XdrCodec.uint64, 3n)],
              [33, (writer) => writer.write(XdrCodec.uint32, 0o640)],
              [36, (writer) => writer.write(XdrCodec.string(), "12")],
              [37, (writer) => writer.write(XdrCodec.string(), "34")],
              [48, (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, 1)
                  yield* writer.write(XdrCodec.uint64, 5n)
                  yield* writer.write(XdrCodec.uint32, 6)
                })],
              [54, (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, 1)
                  yield* writer.write(XdrCodec.uint64, 7n)
                  yield* writer.write(XdrCodec.uint32, 8)
                })]
            ])
          )
        )

        const metadata = yield* caller.stat("/file")
        assert.deepStrictEqual([
          metadata.size,
          metadata.mode,
          metadata.uid,
          metadata.gid,
          metadata.atimeNs,
          metadata.mtimeNs
        ], [3n, 0o640, 12, 34, 5_000_000_006n, 7_000_000_008n])
        assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array(3))
        assert.deepStrictEqual(opened.attrs, [4, 33, 36, 37, 48, 54])
        assert.isTrue(opened.atomic)
        assert.strictEqual(opened.before, before.revision)
        assert.strictEqual(opened.after, (yield* caller.readDirectory(root)).revision)
        assert.notStrictEqual(opened.before, opened.after)
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))

    it.effect("should accept WRITE then reject the old stateid after CLOSE when OPEN4_CREATE returns an open state", () =>
      Effect.gen(function*() {
        const { caller, handler, client, session } = yield* setup()

        const opened = yield* readCreate(
          yield* handler.compound(
            yield* createCall(
              client,
              session,
              1,
              "file",
              0,
              [[4, (writer) => writer.write(XdrCodec.uint64, 3n)]]
            )
          )
        )

        const written = yield* handler.compound(
          yield* call([sequence(session, 2), (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
              yield* writer.write(XdrCodec.opaque(), opened.filehandle)
            }), (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.WRITE)
              yield* writer.write(XdrCodec.fixedOpaque(opened.stateid.length), opened.stateid)
              yield* writer.write(XdrCodec.uint64, 1n)
              yield* writer.write(XdrCodec.uint32, 2)
              yield* writer.write(XdrCodec.opaque(), new Uint8Array([9]))
            })])
        )

        assert.strictEqual(yield* responseStatus(written), Status.OK)
        assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([0, 9, 0]))

        const closed = yield* handler.compound(
          yield* call([sequence(session, 3), (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
              yield* writer.write(XdrCodec.opaque(), opened.filehandle)
            }), (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.CLOSE)
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.fixedOpaque(opened.stateid.length), opened.stateid)
            })])
        )

        assert.strictEqual(yield* responseStatus(closed), Status.OK)
        assert.strictEqual(
          yield* responseStatus(
            yield* handler.compound(
              yield* call([sequence(session, 4), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                  yield* writer.write(XdrCodec.opaque(), opened.filehandle)
                }), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.WRITE)
                  yield* writer.write(XdrCodec.fixedOpaque(opened.stateid.length), opened.stateid)
                  yield* writer.write(XdrCodec.uint64, 0n)
                  yield* writer.write(XdrCodec.uint32, 2)
                  yield* writer.write(XdrCodec.opaque(), new Uint8Array([1]))
                })])
            )
          ),
          Status.BAD_STATEID
        )
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))
    it.effect("should reject an existing name without changing its contents or metadata when guarded creation is requested", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          client,
          session
        } = yield* setup()

        yield* readCreate(
          yield* handler.compound(
            yield* createCall(client, session, 1, "file", 1, [[33, (writer) => writer.write(XdrCodec.uint32, 0o600)]])
          )
        )
        yield* caller.writeFile("/file", new Uint8Array([4, 5]), {
          access: "write"
        })
        const before = yield* caller.stat("/file")
        assert.strictEqual(
          yield* responseStatus(
            yield* handler.compound(
              yield* createCall(client, session, 2, "file", 1, [[4, (writer) => writer.write(XdrCodec.uint64, 0n)], [
                33,
                (writer) => writer.write(XdrCodec.uint32, 0o777)
              ]])
            )
          ),
          Status.EXIST
        )
        assert.deepStrictEqual(yield* caller.stat("/file"), before)
        assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([4, 5]))
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))
    it.effect("should ignore existing-file attributes except size zero truncation when an unchecked OPEN is requested", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          client,
          session
        } = yield* setup()

        yield* caller.writeFile("/file", new Uint8Array([4, 5]), {
          access: "write",
          create: "exclusive",
          mode: 0o600
        })
        const initial = yield* caller.stat("/file")

        const first = yield* readCreate(
          yield* handler.compound(
            yield* createCall(client, session, 1, "file", 0, [
              [4, (writer) => writer.write(XdrCodec.uint64, 8n)],
              [33, (writer) => writer.write(XdrCodec.uint32, 0o777)],
              [36, (writer) => writer.write(XdrCodec.string(), "12")],
              [37, (writer) => writer.write(XdrCodec.string(), "34")]
            ])
          )
        )

        assert.deepStrictEqual(first.attrs, [])
        assert.strictEqual(first.before, first.after)
        assert.deepStrictEqual(yield* caller.stat("/file"), initial)

        const truncated = yield* readCreate(
          yield* handler.compound(
            yield* createCall(client, session, 2, "file", 0, [[4, (writer) => writer.write(XdrCodec.uint64, 0n)], [
              33,
              (writer) => writer.write(XdrCodec.uint32, 0o777)
            ]])
          )
        )

        assert.deepStrictEqual(truncated.attrs, [4])
        assert.deepStrictEqual(truncated.filehandle, first.filehandle)
        assert.strictEqual((yield* caller.stat("/file")).mode, 0o600)
        assert.strictEqual((yield* caller.stat("/file")).size, 0n)
        assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array())
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))
    it.effect("should recognize the verifier and reject another creation attempt when either exclusive mode is used", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          client,
          session
        } = yield* setup()

        let seq = 1

        for (const mode of [2, 3]) {
          const name = `exclusive-${mode}`
          const attrs: Attributes = mode === 3 ? [[33, (writer) => writer.write(XdrCodec.uint32, 0o600)]] : []

          const first = yield* readCreate(
            yield* handler.compound(yield* createCall(client, session, seq++, name, mode, attrs))
          )

          assert.deepStrictEqual(first.attrs, mode === 2 ? [47, 53] : [33, 47, 53])
          const metadata = yield* caller.stat(`/${name}`)

          const retry = yield* readCreate(
            yield* handler.compound(
              yield* createCall(
                client,
                session,
                seq++,
                name,
                mode,
                mode === 3
                  ? [[33, (writer) => writer.write(XdrCodec.uint32, 0o777)]]
                  : []
              )
            )
          )

          assert.deepStrictEqual(retry.filehandle, first.filehandle)
          assert.deepStrictEqual(retry.attrs, [47, 53])
          assert.strictEqual(retry.before, retry.after)
          assert.deepStrictEqual(yield* caller.stat(`/${name}`), metadata)
          assert.strictEqual(
            yield* responseStatus(
              yield* handler.compound(
                yield* createCall(client, session, seq++, name, mode, attrs, new Uint8Array(8).fill(18))
              )
            ),
            Status.EXIST
          )
        }
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))
    it.effect("should ignore unused initial attribute values when the named file already exists", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          client,
          session
        } = yield* setup()

        yield* caller.writeFile("/file", new Uint8Array([4, 5]), {
          access: "write",
          create: "exclusive"
        })
        const initial = yield* caller.stat("/file")

        const unused: Attributes = [[33, (writer) => writer.write(XdrCodec.uint32, 0xffff_ffff)], [
          36,
          (writer) => writer.write(XdrCodec.string(), "unmapped@example.test")
        ]]

        const opened = yield* readCreate(
          yield* handler.compound(yield* createCall(client, session, 1, "file", 0, unused))
        )

        assert.deepStrictEqual(opened.attrs, [])
        assert.deepStrictEqual(yield* caller.stat("/file"), initial)
        assert.strictEqual(
          yield* responseStatus(yield* handler.compound(yield* createCall(client, session, 2, "file", 1, unused))),
          Status.EXIST
        )
        yield* readCreate(yield* handler.compound(yield* createCall(client, session, 3, "exclusive", 3)))
        const exclusiveInitial = yield* caller.stat("/exclusive")

        const retry = yield* readCreate(
          yield* handler.compound(yield* createCall(client, session, 4, "exclusive", 3, unused))
        )

        assert.deepStrictEqual(retry.attrs, [47, 53])
        assert.deepStrictEqual(yield* caller.stat("/exclusive"), exclusiveInitial)

        const unsupported: Attributes = [[35, (writer) => writer.write(XdrCodec.uint32, 1)]]
        yield* readCreate(yield* handler.compound(yield* createCall(client, session, 5, "file", 0, unsupported)))
        assert.strictEqual(
          yield* responseStatus(yield* handler.compound(yield* createCall(client, session, 6, "file", 1, unsupported))),
          Status.EXIST
        )
        yield* readCreate(
          yield* handler.compound(
            yield* createCall(client, session, 7, "file", 0, [[
              33,
              (writer) => writer.write(XdrCodec.uint32, 0o10000)
            ]])
          )
        )
        assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([4, 5]))
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))
    it.effect("should reject timestamp setters before creating a file when EXCLUSIVE4_1 is used", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          client,
          session
        } = yield* setup()

        for (const [index, attribute] of [48, 54].entries()) {
          assert.strictEqual(
            yield* responseStatus(
              yield* handler.compound(
                yield* createCall(client, session, index + 1, "file", 3, [[
                  attribute,
                  (writer) =>
                    Effect.gen(function*() {
                      yield* writer.write(XdrCodec.uint32, 1)
                      yield* writer.write(XdrCodec.uint64, 1n)
                      yield* writer.write(XdrCodec.uint32, 0)
                    })
                ]])
              )
            ),
            Status.INVAL
          )
          assert.strictEqual((yield* Effect.flip(caller.stat("/file"))).code, "NotFound")
        }
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))
    it.effect("should advertise the EXCLUSIVE4_1 initial attributes without timestamp setters when GETATTR requests supported EXCLUSIVE4_1 attributes", () =>
      Effect.gen(function*() {
        const {
          handler,
          session
        } = yield* setup()

        const reader = yield* afterRoot(
          yield* handler.compound(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.GETATTR)
                  yield* writeBitmap(writer, [75])
                })
            ])
          )
        )

        assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.GETATTR)
        assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
        assert.deepStrictEqual(yield* readBitmap(reader), [75])
        const attributes = yield* make.openReader(yield* reader.read(XdrCodec.opaque()), limits)
        assert.deepStrictEqual(yield* readBitmap(attributes), [4, 33, 36, 37])
        yield* attributes.finish
        yield* reader.finish
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))
    it.effect("should reject unsupported initial attributes without leaving a directory entry when OPEN4_CREATE supplies an unsupported attribute", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          client,
          session
        } = yield* setup()

        assert.strictEqual(
          yield* responseStatus(
            yield* handler.compound(
              yield* createCall(client, session, 1, "file", 0, [[12, (writer) => writer.write(XdrCodec.uint32, 0)]])
            )
          ),
          Status.ATTRNOTSUPP
        )
        assert.strictEqual((yield* Effect.flip(caller.stat("/file"))).code, "NotFound")
        yield* readCreate(yield* handler.compound(yield* createCall(client, session, 2, "file")))
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))
    it.effect("should check share reservations before an unchecked open can truncate when an unchecked OPEN requests truncation against a share reservation", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          client,
          session
        } = yield* setup()

        yield* caller.writeFile("/file", new Uint8Array([4, 5]), {
          access: "write",
          create: "exclusive"
        })
        yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openByName(client, "file", 1, 2),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )
        assert.strictEqual(
          yield* responseStatus(
            yield* handler.compound(
              yield* createCall(client, session, 2, "file", 0, [[4, (writer) => writer.write(XdrCodec.uint64, 0n)]])
            )
          ),
          Status.SHARE_DENIED
        )
        assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([4, 5]))
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))
    it.effect("should use the mapped caller's authority before creating or truncating when a mapped caller lacks creation or truncation authority", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume

        const caller = yield* Vfs.Caller

        yield* caller.writeFile("/file", new Uint8Array([4, 5]), {
          access: "write",
          create: "exclusive",
          mode: 0o600
        })

        const guest = yield* Testing.callerAs({
          uid: 1000,
          gid: 1000,
          groups: [],
          privileged: false
        })

        const handler = yield* server(caller, volume, {
          mapped: guest
        })

        const {
          client,
          session
        } = yield* startSession(handler, "guest")

        assert.strictEqual(
          yield* responseStatus(yield* handler.compound(yield* createCall(client, session, 1, "new"))),
          Status.ACCESS
        )
        assert.strictEqual((yield* Effect.flip(caller.stat("/new"))).code, "NotFound")
        assert.strictEqual(
          yield* responseStatus(
            yield* handler.compound(
              yield* createCall(client, session, 2, "file", 0, [[4, (writer) => writer.write(XdrCodec.uint64, 0n)]])
            )
          ),
          Status.ACCESS
        )
        assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([4, 5]))
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))
    it.effect("should leave files unchanged when open-state capacity is exhausted", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          client,
          session
        } = yield* setup({
          maxOpens: 1
        })

        yield* readCreate(yield* handler.compound(yield* createCall(client, session, 1, "held")))
        yield* caller.writeFile("/file", new Uint8Array([4]), {
          access: "write",
          create: "exclusive"
        })
        assert.strictEqual(
          yield* responseStatus(yield* handler.compound(yield* createCall(client, session, 2, "new"))),
          Status.DELAY
        )
        assert.strictEqual(
          yield* responseStatus(
            yield* handler.compound(
              yield* createCall(client, session, 3, "file", 0, [[4, (writer) => writer.write(XdrCodec.uint64, 0n)]])
            )
          ),
          Status.DELAY
        )
        assert.strictEqual((yield* Effect.flip(caller.stat("/new"))).code, "NotFound")
        assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([4]))
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))
    it.effect("should leave no file or open reservation when entry capacity is exhausted", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          client,
          session
        } = yield* setup({
          maxOpens: 1
        })

        yield* caller.writeFile("/occupied", new Uint8Array(), {
          access: "write",
          create: "exclusive"
        })
        assert.strictEqual(
          yield* responseStatus(yield* handler.compound(yield* createCall(client, session, 1, "new"))),
          Status.NOSPC
        )
        assert.strictEqual((yield* Effect.flip(caller.stat("/new"))).code, "NotFound")
        yield* caller.unlink("/occupied")
        yield* readCreate(yield* handler.compound(yield* createCall(client, session, 2, "new")))
      }).pipe(Effect.provide(Testing.layer({ volume: { maxEntries: 1 }, caller: { umask: 0 } }))))
    it.effect("should reject every creation mode and preserve existing data when the handler is read-only", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          client,
          session
        } = yield* setup({
          writable: false
        })

        yield* caller.writeFile("/file", new Uint8Array([4]), {
          access: "write",
          create: "exclusive"
        })

        for (const mode of [0, 1, 2, 3]) {
          assert.strictEqual(
            yield* responseStatus(yield* handler.compound(yield* createCall(client, session, mode + 1, "new", mode))),
            Status.ROFS
          )
        }

        assert.strictEqual(
          yield* responseStatus(
            yield* handler.compound(
              yield* createCall(client, session, 5, "file", 0, [[4, (writer) => writer.write(XdrCodec.uint64, 0n)]])
            )
          ),
          Status.ROFS
        )
        assert.strictEqual((yield* Effect.flip(caller.stat("/new"))).code, "NotFound")
        assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([4]))
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))
    it.effect("should replay a cached reply and never reexecute an uncached creation request when a cached or uncached creation request is replayed", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          client,
          session
        } = yield* setup()

        const cached = yield* createCall(client, session, 1, "cached", 1)
        const first = yield* handler.compound(cached)
        yield* readCreate(first)
        yield* caller.unlink("/cached")
        assert.deepStrictEqual(yield* handler.compound(cached), first)
        assert.strictEqual((yield* Effect.flip(caller.stat("/cached"))).code, "NotFound")
        const uncached = yield* createCall(client, session, 2, "uncached", 1, [], undefined, false)
        yield* readCreate(yield* handler.compound(uncached))
        yield* caller.unlink("/uncached")
        assert.strictEqual(yield* responseStatus(yield* handler.compound(uncached)), Status.RETRY_UNCACHED_REP)
        assert.strictEqual((yield* Effect.flip(caller.stat("/uncached"))).code, "NotFound")
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))
    it.effect("should publish neither the file nor an open reservation when a commit is rejected", () => {
      let reject = true

      const store = Layer.succeed(
        LiveVolume.LiveImageStore,
        LiveVolume.LiveImageStore.of({
          loadOrCreate: (initial) => Effect.succeed(initial),
          commit: () => Effect.succeed(reject ? "rejected" as const : "committed" as const)
        })
      )

      return Effect.gen(function*() {
        const volume = yield* LiveVolume.open(liveOptions)
        const caller = yield* volume.caller()

        const handler = yield* server(caller, volume, {
          maxOpens: 1
        })

        const {
          client,
          session
        } = yield* startSession(handler, "rejected-create")

        assert.strictEqual(
          yield* responseStatus(yield* handler.compound(yield* createCall(client, session, 1, "file", 2))),
          Status.IO
        )
        assert.strictEqual((yield* Effect.flip(caller.stat("/file"))).code, "NotFound")
        reject = false
        yield* readCreate(yield* handler.compound(yield* createCall(client, session, 2, "file", 2)))
      }).pipe(Effect.provide(store))
    })
    it.effect("should refuse success and block subsequent volume access when a commit outcome is unknown", () => {
      const store = Layer.succeed(
        LiveVolume.LiveImageStore,
        LiveVolume.LiveImageStore.of({
          loadOrCreate: (initial) => Effect.succeed(initial),
          commit: () => Effect.succeed("unknown" as const)
        })
      )

      return Effect.gen(function*() {
        const volume = yield* LiveVolume.open(liveOptions)
        const caller = yield* volume.caller()
        const handler = yield* server(caller, volume)

        const {
          client,
          session
        } = yield* startSession(handler, "unknown-create")

        assert.strictEqual(
          yield* responseStatus(yield* handler.compound(yield* createCall(client, session, 1, "file", 2))),
          Status.IO
        )
        assert.strictEqual((yield* Effect.flip(volume.usage)).code, "VolumeUnavailable")
        assert.strictEqual(
          yield* responseStatus(yield* handler.compound(yield* createCall(client, session, 2, "other"))),
          Status.IO
        )
      }).pipe(Effect.provide(store))
    })
    it.effect("should recover the file and exclusive verifier together from the committed image when a committed image is reopened after exclusive creation", () => {
      let image: Uint8Array | undefined

      const store = Layer.succeed(
        LiveVolume.LiveImageStore,
        LiveVolume.LiveImageStore.of({
          loadOrCreate: (initial) => Effect.sync(() => image ??= initial),
          commit: (candidate) =>
            Effect.sync(() => {
              image = candidate.slice()

              return "committed" as const
            })
        })
      )

      return Effect.gen(function*() {
        const inode = yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open(liveOptions)
          const caller = yield* volume.caller()
          const handler = yield* server(caller, volume)

          const {
            client,
            session
          } = yield* startSession(handler, "before-restart")

          yield* readCreate(
            yield* handler.compound(
              yield* createCall(client, session, 1, "file", 3, [[33, (writer) => writer.write(XdrCodec.uint32, 0o640)]])
            )
          )

          return (yield* caller.stat("/file")).ino
        }))

        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open(liveOptions)
          const caller = yield* volume.caller()
          const handler = yield* server(caller, volume)

          const {
            client,
            session
          } = yield* startSession(handler, "after-restart")

          const retry = yield* readCreate(
            yield* handler.compound(
              yield* createCall(client, session, 1, "file", 3, [[33, (writer) => writer.write(XdrCodec.uint32, 0o777)]])
            )
          )

          const metadata = yield* caller.stat("/file")
          assert.strictEqual(metadata.ino, inode)
          assert.strictEqual(metadata.mode, 0o640)
          assert.strictEqual(retry.before, retry.after)
          assert.strictEqual(
            yield* responseStatus(
              yield* handler.compound(yield* createCall(client, session, 2, "file", 3, [], new Uint8Array(8).fill(19)))
            ),
            Status.EXIST
          )
        }))
      }).pipe(Effect.provide(store))
    })
    it.effect("should wait for confirmed commit before returning a successful open when the store delays a creation commit", () =>
      Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()

        const store = Layer.succeed(
          LiveVolume.LiveImageStore,
          LiveVolume.LiveImageStore.of({
            loadOrCreate: (initial) => Effect.succeed(initial),
            commit: () =>
              Effect.gen(function*() {
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(release)

                return "committed" as const
              })
          })
        )

        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open(liveOptions)
          const caller = yield* volume.caller()
          const handler = yield* server(caller, volume)

          const {
            client,
            session
          } = yield* startSession(handler, "held-create")

          const reply = yield* handler.compound(yield* createCall(client, session, 1, "file", 2)).pipe(
            Effect.forkChild({
              startImmediately: true
            })
          )

          yield* Deferred.await(started)
          assert.strictEqual(reply.pollUnsafe(), undefined)
          yield* Deferred.succeed(release, undefined)
          yield* readCreate(yield* Fiber.join(reply))
          assert.strictEqual((yield* caller.stat("/file")).size, 0n)
        })).pipe(Effect.provide(store))
      }))
    it.effect("should close the acquired handle when creation is interrupted during commit", () =>
      Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()

        const store = Layer.succeed(
          LiveVolume.LiveImageStore,
          LiveVolume.LiveImageStore.of({
            loadOrCreate: (initial) => Effect.succeed(initial),
            commit: () =>
              Effect.gen(function*() {
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(release)

                return "committed" as const
              })
          })
        )

        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open(liveOptions)
          const caller = yield* volume.caller()

          const handler = yield* server(caller, volume, {
            maxOpens: 1
          })

          const {
            client,
            session
          } = yield* startSession(handler, "interrupted-create")

          const request = yield* createCall(client, session, 1, "file", 3, [[
            4,
            (writer) => writer.write(XdrCodec.uint64, 8n)
          ]])

          const reply = yield* handler.compound(request).pipe(Effect.forkChild({
            startImmediately: true
          }))

          yield* Deferred.await(started)

          const interrupting = yield* Fiber.interrupt(reply).pipe(Effect.forkChild({
            startImmediately: true
          }))

          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(interrupting)
          assert.strictEqual((yield* caller.stat("/file")).size, 8n)
          yield* caller.unlink("/file")
          assert.strictEqual((yield* volume.usage).usedBytes, 0n)
          assert.strictEqual(yield* responseStatus(yield* handler.compound(request)), Status.RETRY_UNCACHED_REP)
          assert.strictEqual((yield* Effect.flip(caller.stat("/file"))).code, "NotFound")
          yield* readCreate(yield* handler.compound(yield* createCall(client, session, 2, "next", 1)))
        })).pipe(Effect.provide(store))
      }))
  })

  const simpleCreate = (
    client: bigint,
    name: string,
    mode: 0 | 1 = 0,
    access = 3,
    owner = "creator",
    attrs: ReadonlyArray<readonly [number, number | bigint]> = []
  ) =>
    create(
      client,
      name,
      mode,
      [...attrs].sort(([left], [right]) => left - right).map(([attribute, value]) => [attribute, (writer) => {
        if (attribute === 4) return writer.write(XdrCodec.uint64, BigInt(value))

        if (attribute === 36 || attribute === 37) return writer.write(XdrCodec.string(), String(value))

        return writer.write(XdrCodec.uint32, Number(value))
      }]),
      undefined,
      access,
      owner
    )

  it.layer(NodeCrypto.layer)("writable OPEN creation", (it) => {
    it.effect("should apply an explicit mode exactly and reject undefined mode bits when a create requests explicit or undefined mode bits", () =>
      Effect.gen(function*() {
        const { caller, handler, client, session } = yield* setup()

        yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              simpleCreate(client, "exact", 0, 3, "owner", [[4, 0n], [33, 0o1666]]),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )
        assert.deepInclude(yield* caller.stat("/exact"), {
          mode: 0o1666
        })

        const invalid = yield* handler.compound(
          yield* call([
            sequence(session, 2),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
            simpleCreate(client, "invalid", 0, 3, "owner", [[33, 0o10000]])
          ])
        )

        assert.strictEqual(yield* responseStatus(invalid), Status.INVAL)
        assert.isTrue(Result.isFailure(yield* Effect.result(caller.stat("/invalid"))))
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should report a symbolic-link target as SYMLINK for ordinary create when ordinary create names a symbolic link", () =>
      Effect.gen(function*() {
        const { caller, handler, client, session } = yield* setup()
        yield* caller.symlink("target", "/link")

        const reply = yield* handler.compound(
          yield* call([
            sequence(session, 1),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
            simpleCreate(client, "link")
          ])
        )

        assert.strictEqual(yield* responseStatus(reply), Status.SYMLINK)
        assert.strictEqual(Result.isFailure(yield* Effect.result(caller.stat("/target"))), true)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should upgrade the same owner's create open and keep its stateid identity when the same owner upgrades a create OPEN", () =>
      Effect.gen(function*() {
        const { handler, client, session } = yield* setup()

        const first = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              simpleCreate(client, "upgrade", 0, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        const second = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(session, 2),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              simpleCreate(client, "upgrade", 0, 2),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        assert.deepStrictEqual(second.stateid.subarray(4), first.stateid.subarray(4))
        assert.deepStrictEqual(second.filehandle, first.filehandle)
        assert.strictEqual(new DataView(second.stateid.buffer, second.stateid.byteOffset).getUint32(0), 2)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should reject a replaced child before truncation or an extra open reservation when a child is replaced during create lookup", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/victim", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const base = yield* exportFor(caller)

        let replace = false

        const export_ = {
          ...base,
          lookup: (directory: Vfs.ObjectReference, name: Uint8Array) =>
            base.lookup(directory, name).pipe(Effect.tap(() =>
              replace ?
                Effect.gen(function*() {
                  replace = false
                  yield* caller.unlink("/victim")
                  yield* caller.writeFile("/victim", new Uint8Array([7]), {
                    access: "write",
                    create: "exclusive"
                  })
                }) :
                Effect.void
            ))
        }

        const handler = yield* handlerFor(export_, {
          limits: {
            ...limits,
            maxOpens: 1
          },
          writable: true
        })

        const {
          client,
          session
        } = yield* startSession(handler, "replaced")

        yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openByName(client, "victim"),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )
        replace = true

        const reply = yield* handler.compound(
          yield* call([
            sequence(session, 2),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
            simpleCreate(client, "victim", 0, 2, "owner", [[4, 0n]])
          ])
        )

        assert.strictEqual(yield* responseStatus(reply), Status.DELAY)
        assert.deepStrictEqual(yield* caller.readFile("/victim"), new Uint8Array([7]))
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should leave the file unpublished when its requested size exceeds the core limit", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume

        const caller = yield* Vfs.Caller

        const { handler, client, session } = yield* openSession(caller, "too-large", {
          writable: true
        }).pipe(Effect.provideService(Vfs.Volume, volume))

        const reply = yield* handler.compound(
          yield* call([
            sequence(session, 1),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
            simpleCreate(client, "too-large", 0, 1, "creator", [[4, 3n]])
          ])
        )

        assert.strictEqual(yield* responseStatus(reply), Status.FBIG)
        assert.strictEqual(Result.isFailure(yield* Effect.result(caller.stat("/too-large"))), true)
      }).pipe(Effect.provide(Testing.layer({ volume: { maxFileBytes: ByteSize.bytes(2) } }))))
    it.effect("should use the mapped caller's directory permission when a mapped caller lacks directory permission", () =>
      Effect.gen(function*() {
        const admin = yield* Vfs.Caller

        const guest = yield* Testing.callerAs({
          uid: 1000,
          gid: 1000,
          groups: [],
          privileged: false
        })

        const { handler, client, session } = yield* openSession(admin, "guest", {
          writable: true,
          callerFor: () => Effect.succeed(guest)
        })

        const reply = yield* handler.compound(
          yield* call([
            sequence(session, 1),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
            simpleCreate(client, "forbidden")
          ])
        )

        assert.strictEqual(yield* responseStatus(reply), Status.ACCESS)
        assert.strictEqual(Result.isFailure(yield* Effect.result(admin.stat("/forbidden"))), true)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should refuse a create that names another owner for an unprivileged caller as not permitted when an unprivileged caller requests another owner", () =>
      Effect.gen(function*() {
        const admin = yield* Vfs.Caller
        yield* admin.chmod(yield* admin.root, 0o777)

        const guest = yield* Testing.callerAs({
          uid: 1000,
          gid: 1000,
          groups: [],
          privileged: false
        })

        const { handler, client, session } = yield* openSession(admin, "guest-owner", {
          writable: true,
          callerFor: () => Effect.succeed(guest)
        })

        const foreign = yield* handler.compound(
          yield* call([
            sequence(session, 1),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
            simpleCreate(client, "foreign", 0, 3, "creator", [[36, 0]])
          ])
        )

        assert.strictEqual(yield* responseStatus(foreign), Status.PERM)
        assert.strictEqual(Result.isFailure(yield* Effect.result(admin.stat("/foreign"))), true)

        const own = yield* handler.compound(
          yield* call([
            sequence(session, 2),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
            simpleCreate(client, "own", 0, 3, "creator", [[36, 1000]])
          ])
        )

        assert.strictEqual(yield* responseStatus(own), Status.OK)
        assert.strictEqual((yield* admin.stat("/own")).uid, 1000)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should reopen only the confirmed create when a rejected commit is followed by a successful create", () => {
      let saved: Uint8Array | undefined
      let reject = false

      const store = Layer.succeed(
        LiveVolume.LiveImageStore,
        LiveVolume.LiveImageStore.of({
          loadOrCreate: (initial) => Effect.succeed(saved ?? initial),
          commit: (image) =>
            Effect.sync(() => {
              if (reject) return "rejected" as const
              saved = new Uint8Array(image)

              return "committed" as const
            })
        })
      )

      const open = LiveVolume.open({
        maxImageBytes: ByteSize.kilobytes(64),
        volume: {
          maxEntries: 16,
          maxBytes: ByteSize.bytes(32),
          maxFileBytes: ByteSize.bytes(32),
          maxPathBytes: ByteSize.bytes(255)
        }
      })

      return Effect.gen(function*() {
        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* open
          const caller = yield* volume.caller()

          const { handler, client, session } = yield* openSession(caller, "store", {
            writable: true
          }).pipe(Effect.provideService(Vfs.Volume, volume))

          reject = true

          const rejected = yield* handler.compound(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              simpleCreate(client, "rejected")
            ])
          )

          assert.strictEqual(yield* responseStatus(rejected), Status.IO)
          assert.strictEqual(Result.isFailure(yield* Effect.result(caller.stat("/rejected"))), true)
          reject = false
          yield* parseOpen(
            yield* handler.compound(
              yield* call([
                sequence(session, 2),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                simpleCreate(client, "confirmed"),
                (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
              ])
            )
          )
          yield* parseOpen(
            yield* handler.compound(
              yield* call([
                sequence(session, 3),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                simpleCreate(client, "confirmed"),
                (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
              ])
            )
          )
        }))

        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* open
          const caller = yield* volume.caller()
          assert.deepInclude(yield* caller.stat("/confirmed"), { kind: "file" })
          assert.strictEqual((yield* Effect.flip(caller.stat("/rejected"))).code, "NotFound")
        }))
      }).pipe(Effect.provide(store))
    })

    it.effect("should leave no file when creation is interrupted at the core commit gate", () =>
      Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let hold = false

        const store = Layer.succeed(
          LiveVolume.LiveImageStore,
          LiveVolume.LiveImageStore.of({
            loadOrCreate: (initial) => Effect.succeed(initial),
            commit: () =>
              hold
                ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as("committed" as const)
                )
                : Effect.succeed("committed" as const)
          })
        )

        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open({
            maxImageBytes: ByteSize.kilobytes(64),
            volume: {
              maxEntries: 16,
              maxBytes: ByteSize.bytes(32),
              maxFileBytes: ByteSize.bytes(32),
              maxPathBytes: ByteSize.bytes(255)
            }
          })

          const caller = yield* volume.caller()

          const { handler, client, session } = yield* openSession(caller, "interrupted", {
            writable: true
          }).pipe(Effect.provideService(Vfs.Volume, volume))

          hold = true

          const blocked = yield* caller.writeFile("/block", new Uint8Array([1]), {
            access: "write",
            create: "exclusive"
          }).pipe(Effect.forkChild({
            startImmediately: true
          }))

          yield* Deferred.await(entered)

          const attempt = yield* handler.compound(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              simpleCreate(client, "cancelled")
            ])
          ).pipe(Effect.forkChild({
            startImmediately: true
          }))

          yield* Fiber.interrupt(attempt)
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(blocked)
          assert.strictEqual(Result.isFailure(yield* Effect.result(caller.stat("/cancelled"))), true)
        })).pipe(Effect.provide(store))
      }))
  })
})

describe("Filehandles", () => {
  const FH_EXPIRE_TYPE = 2

  const UNIQUE_HANDLES = 9

  // The statuses RFC 8881 Section 15.2 lists for PUTFH that a volume failure can reach.
  const PUTFH_ERRORS: ReadonlyArray<number> = [
    Status.BADHANDLE,
    Status.DELAY,
    Status.FHEXPIRED,
    Status.SERVERFAULT,
    Status.STALE
  ]

  const liveOptions: LiveVolume.Options = {
    maxImageBytes: ByteSize.kilobytes(64),
    volume: {
      maxEntries: 16,
      maxBytes: ByteSize.bytes(64),
      maxFileBytes: ByteSize.bytes(32),
      maxPathBytes: ByteSize.bytes(255)
    }
  }

  // A durable store that keeps its one image in memory, so a test can restart the server over the same volume.
  const durableStore = () => {
    let image: Uint8Array | undefined

    return Layer.succeed(
      LiveVolume.LiveImageStore,
      LiveVolume.LiveImageStore.of({
        durability: "survives-power-loss",
        loadOrCreate: (initial) => Effect.sync(() => image ??= initial),
        commit: (candidate) =>
          Effect.sync(() => {
            image = candidate.slice()

            return "committed" as const
          })
      })
    )
  }

  const putfh = (filehandle: Uint8Array): WriteOperation => (writer) =>
    Effect.gen(function*() {
      yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
      yield* writer.write(XdrCodec.opaque(), filehandle)
    })

  const getfh: WriteOperation = (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)

  const op = (code: number): WriteOperation => (writer) => writer.write(XdrCodec.uint32, code)

  const remove = (name: string): WriteOperation => (writer) =>
    Effect.gen(function*() {
      yield* writer.write(XdrCodec.uint32, Operation.REMOVE)
      yield* writer.write(XdrCodec.string(), name)
    })

  const getattr = (...attributes: ReadonlyArray<number>): WriteOperation => (writer) =>
    Effect.gen(function*() {
      const words = [0, 0]

      for (const attribute of attributes) words[attribute >> 5]! |= 1 << (attribute & 31)
      yield* writer.write(XdrCodec.uint32, Operation.GETATTR)
      yield* writer.write(XdrCodec.array(XdrCodec.uint32), words)
    })

  // READ of the first bytes under the anonymous stateid.
  const read: WriteOperation = (writer) =>
    Effect.gen(function*() {
      yield* writer.write(XdrCodec.uint32, Operation.READ)
      yield* writer.write(XdrCodec.fixedOpaque(16), new Uint8Array(16))
      yield* writer.write(XdrCodec.uint64, 0n)
      yield* writer.write(XdrCodec.uint32, 16)
    })

  // Each operation's status, reading past the bodies of the operations these tests send.
  const replyStatuses = (response: Uint8Array) =>
    Effect.gen(function*() {
      const reader = yield* make.openReader(response, limits)
      yield* reader.read(XdrCodec.uint32)
      yield* reader.read(XdrCodec.string())
      const count = yield* reader.read(XdrCodec.uint32)
      const result: Array<number> = []

      for (let index = 0; index < count; index++) {
        const code = yield* reader.read(XdrCodec.uint32)
        const status = yield* reader.read(XdrCodec.uint32)
        result.push(status)

        if (status !== Status.OK) break

        if (code === Operation.SEQUENCE) {
          yield* reader.read(XdrCodec.fixedOpaque(16))

          for (let field = 0; field < 5; field++) yield* reader.read(XdrCodec.uint32)
        }

        // change_info4: atomic, before, after.
        if (code === Operation.REMOVE) {
          yield* reader.read(XdrCodec.boolean)
          yield* reader.read(XdrCodec.uint64)
          yield* reader.read(XdrCodec.uint64)
        }
      }

      return result
    })

  // One server over `volume`: its export, handler and a confirmed session. Serving the volume again is a restart.
  const serve = Effect.fnUntraced(function*(volume: Vfs.Volume, owner: string) {
    const export_ = yield* exportFor(yield* volume.caller()).pipe(Effect.provideService(Vfs.Volume, volume))
    const handler = yield* handlerFor(export_)
    const { session } = yield* startSession(handler, owner)
    // Each compound takes the slot's next sequence id; repeating one would replay the cached reply.
    let sequenceId = 0

    // The status PUTFH answers for `filehandle`, followed by GETFH so a resolved handle is re-encoded.
    const put = Effect.fnUntraced(function*(filehandle: Uint8Array) {
      const reply = yield* statuses(
        yield* handler.compound(yield* call([sequence(session, ++sequenceId), putfh(filehandle), getfh]))
      )

      return reply.operations[1]![1]
    })

    // The root's fh_expire_type attribute, read beside unique_handles so neither can take the other's place.
    const expireType = Effect.gen(function*() {
      const reader = yield* make.openReader(
        yield* handler.compound(
          yield* call([
            sequence(session, ++sequenceId),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.GETATTR)
                yield* writer.write(XdrCodec.array(XdrCodec.uint32), [(1 << FH_EXPIRE_TYPE) | (1 << UNIQUE_HANDLES)])
              })
          ])
        ),
        limits
      )

      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
      yield* reader.read(XdrCodec.string())
      yield* reader.read(XdrCodec.uint32)
      yield* reader.read(XdrCodec.uint32)
      yield* reader.read(XdrCodec.uint32)
      yield* reader.read(XdrCodec.fixedOpaque(16))

      for (let field = 0; field < 5; field++) yield* reader.read(XdrCodec.uint32)
      yield* reader.read(XdrCodec.uint32)
      yield* reader.read(XdrCodec.uint32)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.GETATTR)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
      yield* reader.read(XdrCodec.array(XdrCodec.uint32))
      const values = yield* make.openReader(yield* reader.read(XdrCodec.opaque()), limits)

      const expire = yield* values.read(XdrCodec.uint32)
      assert.isTrue(yield* values.read(XdrCodec.boolean), "unique_handles")

      return expire
    })

    return { export_, put, expireType }
  })

  it.layer(NodeCrypto.layer)("NFS filehandles", (it) => {
    it.effect("should survive a server restart and report it in fh_expire_type when the volume is durable", () =>
      Effect.gen(function*() {
        const handle = yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open(liveOptions)
          const caller = yield* volume.caller()
          yield* caller.mkdir("/d")
          yield* caller.writeFile("/d/f", new Uint8Array([1]), { access: "write", create: "exclusive" })
          const served = yield* serve(volume, "before-restart")

          assert.strictEqual(yield* served.expireType, 0, "FH4_PERSISTENT")

          return yield* served.export_.handleFor(yield* caller.lookup("/d/f"))
        }))

        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open(liveOptions)
          const served = yield* serve(volume, "after-restart")

          assert.strictEqual(yield* served.put(handle), Status.OK)
          assert.strictEqual(yield* served.export_.resolve(handle), yield* (yield* volume.caller()).lookup("/d/f"))
          assert.deepStrictEqual(yield* served.export_.handleFor(yield* served.export_.resolve(handle)), handle)
        }))
      }).pipe(Effect.provide(durableStore())))

    it.effect("should answer STALE when a persistent handle names a removed object or another volume", () =>
      Effect.scoped(Effect.gen(function*() {
        const volume = yield* LiveVolume.open(liveOptions)
        const caller = yield* volume.caller()
        yield* caller.writeFile("/f", new Uint8Array([1]), { access: "write", create: "exclusive" })
        const served = yield* serve(volume, "persistent-stale")
        const removed = yield* served.export_.handleFor(yield* caller.lookup("/f"))
        yield* caller.unlink("/f")

        const other = yield* Vfs.make()
        const otherServer = yield* serve(other, "other-volume")
        const foreign = yield* otherServer.export_.handleFor(yield* (yield* other.caller()).root)

        assert.strictEqual(yield* served.put(removed), Status.STALE)
        assert.strictEqual(yield* served.put(foreign), Status.STALE)
        assert.strictEqual(yield* served.put(removed.subarray(0, 56)), Status.BADHANDLE)
      })).pipe(Effect.provide(durableStore())))

    it.effect("should expire after restart when a memory volume retains the same identity", () =>
      Effect.gen(function*() {
        const identity = Vfs.VolumeIdentity.make("0123456789abcdef0123456789abcdef")
        const volume = yield* Vfs.make({ identity })
        const caller = yield* volume.caller()
        yield* caller.writeFile("/f", new Uint8Array([1]), { access: "write", create: "exclusive" })
        const before = yield* serve(volume, "memory-before")
        const handle = yield* before.export_.handleFor(yield* caller.lookup("/f"))

        assert.strictEqual(yield* before.expireType, 0x3, "FH4_VOLATILE_ANY | FH4_NOEXPIRE_WITH_OPEN")
        assert.strictEqual(yield* before.put(handle), Status.OK)

        // A restart builds a new volume: a fresh one, or one restored from a snapshot under the same identity.
        for (const next of [yield* Vfs.make(), yield* Vfs.fromSnapshot(yield* volume.snapshot, { identity })]) {
          assert.strictEqual(yield* (yield* serve(next, "memory-after")).put(handle), Status.FHEXPIRED)
        }
      }))

    // Inode numbers are sequential, so without the tag a client holding the root's handle could name any object and
    // skip the search permission on every directory above it.
    it.effect("should answer BADHANDLE when a handle is forged by changing its inode or tag", () =>
      Effect.gen(function*() {
        const admin = yield* Vfs.Caller
        yield* admin.mkdir("/secret", { mode: 0o700 })
        yield* admin.writeFile("/secret/f", new Uint8Array([42]), { access: "write", create: "exclusive" })
        const secret = (yield* admin.stat("/secret/f")).ino
        const guest = yield* Testing.callerAs({ uid: 2000, gid: 2000, groups: [], privileged: false })
        assert.strictEqual((yield* Effect.flip(guest.lookup("/secret/f"))).code, "AccessDenied")

        const handler = yield* handlerFor(yield* exportFor(guest))
        const { session } = yield* startSession(handler, "forged")
        const root = yield* (yield* exportFor(guest)).handleFor(yield* guest.root)
        const forged = root.slice()
        new DataView(forged.buffer).setBigUint64(33, secret)
        const altered = root.slice()
        altered[41] = altered[41]! ^ 0x80

        let sequenceId = 0

        for (const handle of [forged, altered]) {
          const reply = yield* replyStatuses(
            yield* handler.compound(yield* call([sequence(session, ++sequenceId), putfh(handle), read]))
          )

          assert.deepStrictEqual(reply, [Status.OK, Status.BADHANDLE])
        }
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should answer STALE from GETFH and filehandle attributes when the current object is removed", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        const export_ = yield* exportFor(caller)
        const handler = yield* handlerFor(export_, { writable: true })
        const { session } = yield* startSession(handler, "removed-current")
        let sequenceId = 0

        for (const [name, last] of [["f", getfh], ["g", getattr(19)]] as const) {
          yield* caller.writeFile(`/${name}`, new Uint8Array([1]), { access: "write", create: "exclusive" })
          const handle = yield* export_.handleFor(yield* caller.lookup(`/${name}`))

          // The file stays current across SAVEFH and RESTOREFH while REMOVE takes its only name.
          const reply = yield* replyStatuses(
            yield* handler.compound(
              yield* call([
                sequence(session, ++sequenceId),
                putfh(handle),
                op(Operation.SAVEFH),
                op(Operation.PUTROOTFH),
                remove(name),
                op(Operation.RESTOREFH),
                last
              ])
            )
          )

          assert.deepStrictEqual(reply, [
            Status.OK,
            Status.OK,
            Status.OK,
            Status.OK,
            Status.OK,
            Status.OK,
            Status.STALE
          ])
          assert.strictEqual(
            yield* (yield* make.openReader(
              yield* handler.compound(yield* call([sequence(session, ++sequenceId), putfh(handle)])),
              limits
            )).read(XdrCodec.uint32),
            Status.STALE
          )
        }
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should answer PUTFH with an allowed status when the volume reports a failure", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const caller = yield* Vfs.Caller
        const handle = yield* (yield* exportFor(caller)).handleFor(yield* caller.root)

        const pinned = new Map([
          ["InvalidReference", Status.BADHANDLE],
          ["ForeignReference", Status.FHEXPIRED],
          ["StaleReference", Status.STALE],
          ["VolumeBusy", Status.DELAY],
          ["VolumeUnavailable", Status.SERVERFAULT],
          ["StorageRejected", Status.SERVERFAULT],
          ["FutureCode", Status.SERVERFAULT]
        ])

        for (const code of [...Vfs.VfsCode.literals, "FutureCode"]) {
          // The constructor validates its code, so an unknown runtime code is forced onto a valid error afterwards.
          // SAFETY: the stub stands in for a volume whose failure carries any code, a newer core's included.
          // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- see the invariant above.
          const failure = Object.assign(new Vfs.VfsError({ code: "NotFound", operation: "resolveReferenceKey" }), {
            code
          }) as Vfs.FsFailure

          const failing = makeExport(
            { ...volume, resolveReferenceKey: () => Effect.fail(failure) },
            caller,
            EXPORT_LIMITS
          )

          const handler = yield* handlerFor(failing)
          const { session } = yield* startSession(handler, `putfh-${code}`)

          const [, status] = yield* replyStatuses(
            yield* handler.compound(yield* call([sequence(session, 1), putfh(handle)]))
          )

          assert.isTrue(PUTFH_ERRORS.some((listed) => listed === status), `${code} answered ${status}`)

          if (pinned.has(code)) assert.strictEqual(status, pinned.get(code), code)
        }
      }).pipe(Effect.provide(Testing.layer())))
  })
})

describe("Lifecycle", () => {
  const live = <E>(name: string, body: () => Effect.Effect<void, E, Crypto.Crypto | Scope.Scope>, timeout?: number) =>
    liveTest(name, () => body().pipe(Effect.provide(NodeCrypto.layer)), timeout)

  it.layer(NodeCrypto.layer)("NFSv4.1 Lifecycle", (it) => {
    it.effect("should sweep expired clients before applying capacity limits and close their opens when expired clients count toward capacity", () =>
      Effect.gen(function*() {
        let now = 0
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        const root = yield* caller.root
        const reference = yield* caller.lookup(Vfs.Entry(root, new TextEncoder().encode("file")))

        const constrained = {
          ...limits,
          maxClients: 1,
          maxSessions: 1,
          maxOpens: 1
        }

        const handler = yield* makeHandler(caller, { leaseDurationSeconds: 1, now: () => now, limits: constrained })

        const first = yield* startSession(handler, "expires")
        yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(first.session, 1, true),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openReadOnly(first.client, "file"),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )
        yield* caller.unlink("/file")
        assert.strictEqual((yield* caller.stat(reference)).nlink, 0)
        now = 1_001
        yield* startSession(handler, "replacement")
        assert.strictEqual((yield* Effect.flip(caller.stat(reference))).code, "StaleReference")
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should reclaim an expired lease without waiting for another client's traffic when an open-owning client lease expires without other traffic", () =>
      Effect.gen(function*() {
        let now = 0
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        const root = yield* caller.root
        const reference = yield* caller.lookup(Vfs.Entry(root, new TextEncoder().encode("file")))

        const handler = yield* makeHandler(caller, { leaseDurationSeconds: 1, now: () => now })

        // One connection object for both calls: `session.connections` is keyed by identity, so a
        // fresh `connection()` would disconnect nothing and the drop below would prove nothing.
        const dropped = connection(1)
        const abandoned = yield* startSession(handler, "abandoned", {}, new Uint8Array(8), dropped)
        yield* parseOpen(
          yield* handler.compound(
            yield* call(
              [
                sequence(abandoned.session, 1, true),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                openReadOnly(abandoned.client, "file"),
                (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
              ],
              "probe",
              dropped
            )
          )
        )
        yield* caller.unlink("/file")
        assert.strictEqual((yield* caller.stat(reference)).nlink, 0)

        // The client drops its connection and never returns. Nothing else reaches the server, so
        // reclamation has to come from the handler's own schedule rather than another compound.
        yield* handler.disconnect(dropped)
        now = 1_001
        yield* TestClock.adjust("2 seconds")

        // Observed through the VFS rather than a compound: any compound would itself sweep, which
        // is exactly the traffic this test must do without.
        assert.strictEqual((yield* Effect.flip(caller.stat(reference))).code, "StaleReference")
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should close remaining opens when the handler scope closes", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        const root = yield* caller.root
        const reference = yield* caller.lookup(Vfs.Entry(root, new TextEncoder().encode("file")))
        const scope = yield* Scope.make()

        const handler = yield* makeHandler(caller).pipe(Effect.provideService(Scope.Scope, scope))

        const client = yield* startSession(handler, "handler-finalizer")
        yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(client.session, 1, true),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openReadOnly(client.client, "file"),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )
        yield* caller.unlink("/file")
        assert.strictEqual((yield* caller.stat(reference)).nlink, 0)
        yield* Scope.close(scope, Exit.void)
        assert.strictEqual((yield* Effect.flip(caller.stat(reference))).code, "StaleReference")
      }).pipe(Effect.provide(Testing.layer())))
    live(
      "should not let a connection finalizer wait out an in-flight compound when a connection closes during a compound",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          yield* caller.writeFile("/file", new Uint8Array([1]), {
            access: "write",
            create: "exclusive"
          })

          const base = yield* exportFor(caller)

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

          const handler = yield* handlerFor(export_)

          const stalling = connection(1)
          const departing = connection(2)
          const held = yield* startSession(handler, "stalling", {}, new Uint8Array(8), stalling)
          yield* startSession(handler, "departing", {}, new Uint8Array(8), departing)

          const inFlight = yield* Effect.forkChild(handler.compound(
            yield* call(
              [
                sequence(held.session, 1),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                openReadOnly(held.client, "file")
              ],
              "stalling-probe",
              stalling
            )
          ))

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
          assert.isTrue(Option.isSome(finished), "a connection finalizer stalled behind an in-flight compound")
        }).pipe(Effect.provide(Testing.layer()))
    )

    // A real bound needs the live clock: it.effect runs on the test clock, which never advances.
    live(
      "should interrupt a stalled compound without reopening its consumed slot when a compound stalls after consuming its slot",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          yield* caller.writeFile("/file", new Uint8Array([1]), {
            access: "write",
            create: "exclusive"
          })

          const base = yield* exportFor(caller)

          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let opens = 0

          // The underlying open completes before the export parks, so cancellation arrives after
          // the first state change but before the compound has recorded its result.
          const export_ = {
            ...base,
            open: (reference: Vfs.ObjectReference) =>
              base.open(reference).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    opens++
                  })
                ),
                Effect.tap(() => Deferred.succeed(entered, undefined)),
                Effect.tap(() => Deferred.await(release))
              )
          }

          const handler = yield* handlerFor(export_)

          const carrier = connection(1)
          const held = yield* startSession(handler, "stalling", {}, new Uint8Array(8), carrier)

          const stalled = yield* Effect.forkChild(handler.compound(
            yield* call(
              [
                sequence(held.session, 1),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                openReadOnly(held.client, "file")
              ],
              "stalled",
              carrier
            )
          ))

          yield* Deferred.await(entered)
          const interrupting = yield* Effect.forkChild(Fiber.interrupt(stalled))
          const finished = yield* Fiber.join(interrupting).pipe(Effect.timeoutOption("2 seconds"))
          yield* Deferred.succeed(release, undefined)
          assert.isTrue(Option.isSome(finished), "a stalled OPEN blocked cancellation")

          // The interrupted caller may not have seen the reply. Its slot still records consumption.
          const retried = yield* handler.compound(
            yield* call(
              [
                sequence(held.session, 1),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                openReadOnly(held.client, "file")
              ],
              "stalled",
              carrier
            )
          )

          assert.deepStrictEqual((yield* statuses(retried)).operations, [[Operation.SEQUENCE, Status.OK], [
            Operation.PUTROOTFH,
            Status.RETRY_UNCACHED_REP
          ]])
          assert.strictEqual(opens, 1)
        }).pipe(Effect.provide(Testing.layer()))
    )
    live(
      "should interrupt an observation before a later OPEN without dispatching it when an observation stalls before a later OPEN",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          yield* caller.writeFile("/file", new Uint8Array([1]), {
            access: "write",
            create: "exclusive"
          })

          const base = yield* exportFor(caller)

          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let opens = 0

          const export_ = {
            ...base,
            observeMetadata: (reference: Vfs.ObjectReference) =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(base.observeMetadata(reference))
              ),
            open: (reference: Vfs.ObjectReference) => {
              opens++

              return base.open(reference)
            }
          }

          const handler = yield* handlerFor(export_)

          const {
            session,
            client
          } = yield* startSession(handler, "pre-open-stall")

          const request = yield* call([sequence(session, 1), (writer) =>
            writer.write(XdrCodec.uint32, Operation.PUTROOTFH), (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.GETATTR)
              yield* writer.write(XdrCodec.uint32, 0)
            }), openReadOnly(client, "file")])

          const stalled = yield* Effect.forkChild(handler.compound(request))
          yield* Deferred.await(entered)
          const interrupting = yield* Effect.forkChild(Fiber.interrupt(stalled))
          const finished = yield* Fiber.join(interrupting).pipe(Effect.timeoutOption("2 seconds"))
          yield* Deferred.succeed(release, undefined)
          assert.isTrue(Option.isSome(finished), "GETATTR blocked cancellation before OPEN")
          assert.strictEqual(opens, 0)
          assert.deepStrictEqual((yield* statuses(yield* handler.compound(request))).operations, [[
            Operation.SEQUENCE,
            Status.OK
          ], [Operation.PUTROOTFH, Status.RETRY_UNCACHED_REP]])
        }).pipe(Effect.provide(Testing.layer()))
    )

    // A real bound needs the live clock: it.effect runs on the test clock, which never advances.
    live("should close an open exactly once when CLOSE is interrupted", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const base = yield* exportFor(caller)

        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let closes = 0

        // A close parked in the export leaves an interrupt pending until it settles. Dropping the
        // handle from `opens` has to land in the same region: an interrupt delivered between the two
        // would leave a closed handle for the handler scope's finalizer to close a second time.
        const export_ = {
          ...base,
          open: (reference: Vfs.ObjectReference) =>
            base.open(reference).pipe(Effect.map((opened) => ({
              ...opened,
              // Counted on entry, not after the park: a close abandoned mid-flight never reaches a
              // counter placed after it, which is the case under test.
              close: Effect.sync(() => {
                closes += 1
              }).pipe(
                Effect.andThen(Deferred.succeed(entered, undefined)),
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(opened.close)
              )
            })))
        }

        // The special current stateid: sequence 1 over an otherwise zero stateid, which CLOSE reads
        // as the open the same compound just created.
        const currentStateid = new Uint8Array(16)
        new DataView(currentStateid.buffer).setUint32(0, 1)
        yield* Effect.scoped(Effect.gen(function*() {
          const handler = yield* handlerFor(export_)

          const carrier = connection(1)
          const held = yield* startSession(handler, "closing", {}, new Uint8Array(8), carrier)

          const stalled = yield* Effect.forkChild(handler.compound(
            yield* call(
              [
                sequence(held.session, 1),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                openReadOnly(held.client, "file"),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.CLOSE)
                    yield* writer.write(XdrCodec.uint32, 0)
                    yield* writer.write(XdrCodec.fixedOpaque(currentStateid.length), currentStateid)
                  })
              ],
              "stalled-close",
              carrier
            )
          ))

          yield* Deferred.await(entered)

          // The interrupt cannot land while the close runs; it is delivered the moment that region
          // ends, which is the boundary under test.
          const interrupting = yield* Effect.forkChild(Fiber.interrupt(stalled))

          // The interrupt has to be signalled before the close settles, or it lands after the
          // boundary and proves nothing.
          yield* Effect.sleep("50 millis")
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(interrupting).pipe(Effect.timeoutOption("2 seconds"))
        }))

        // The scope has closed, so its finalizer has swept whatever `opens` still held.
        assert.strictEqual(closes, 1, "the interrupted CLOSE left a closed handle for the finalizer")
      }).pipe(Effect.provide(Testing.layer())))

    // A real bound needs the live clock: it.effect runs on the test clock, which never advances.
    live(
      "should close a revoked client's open exactly once when revocation is interrupted",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          yield* caller.writeFile("/file", new Uint8Array([1]), {
            access: "write",
            create: "exclusive"
          })

          const base = yield* exportFor(caller)

          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let closes = 0

          // Revocation reaches `open.close` from EXCHANGE_ID, CREATE_SESSION and an expired SEQUENCE,
          // which are interruptible operations, so it needs the same close-and-delete atomicity as
          // CLOSE. A client restart reaches it without the lease lapsing, which matters: the sweep
          // ahead of every compound is uninterruptible and would otherwise revoke an expired client
          // before the operation ran.
          const export_ = {
            ...base,
            open: (reference: Vfs.ObjectReference) =>
              base.open(reference).pipe(Effect.map((opened) => ({
                ...opened,
                // Counted on entry, not after the park: a close abandoned mid-flight never reaches a
                // counter placed after it, which is the case under test.
                close: Effect.sync(() => {
                  closes += 1
                }).pipe(
                  Effect.andThen(Deferred.succeed(entered, undefined)),
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(opened.close)
                )
              })))
          }

          yield* Effect.scoped(Effect.gen(function*() {
            const handler = yield* handlerFor(export_)

            const carrier = connection(1)
            const held = yield* startSession(handler, "restarting", {}, new Uint8Array(8), carrier)

            // An open the client still holds when it restarts is what revocation has to close.
            yield* handler.compound(
              yield* call(
                [
                  sequence(held.session, 1),
                  (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                  openReadOnly(held.client, "file")
                ],
                "open",
                carrier
              )
            )

            // The same owner with a new verifier is a restart: CREATE_SESSION revokes the record the
            // previous incarnation left behind, and its lease has not lapsed.
            const restarted = yield* Effect.forkChild(
              startSession(handler, "restarting", {}, new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]), carrier)
            )

            yield* Deferred.await(entered)

            // The interrupt has to be signalled before the close settles, or it lands after the
            // boundary and proves nothing.
            const interrupting = yield* Effect.forkChild(Fiber.interrupt(restarted))
            yield* Effect.sleep("50 millis")
            yield* Deferred.succeed(release, undefined)
            yield* Fiber.join(interrupting).pipe(Effect.timeoutOption("2 seconds"))
          }))
          assert.strictEqual(closes, 1, "interrupted revocation left a closed handle for the finalizer")
        }).pipe(Effect.provide(Testing.layer()))
    )
    it.effect("should reuse session and open capacity after explicit teardown when sessions and opens are explicitly torn down", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const constrained = {
          ...limits,
          maxSessions: 1,
          maxOpens: 1
        }

        const handler = yield* makeHandler(caller, { limits: constrained })

        const first = yield* startSession(handler, "first-capacity")

        const secondExchange = yield* make.openReader(
          yield* handler.compound(yield* call([exchangeId("second-capacity")])),
          constrained
        )

        yield* secondExchange.read(XdrCodec.uint32)
        yield* secondExchange.read(XdrCodec.string())
        yield* secondExchange.read(XdrCodec.uint32)
        yield* secondExchange.read(XdrCodec.uint32)
        yield* secondExchange.read(XdrCodec.uint32)
        const secondClient = yield* secondExchange.read(XdrCodec.uint64)

        const createSecond = (sequenceId: number) =>
          call([(writer) =>
            Effect.gen(function*() {
              yield* Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.CREATE_SESSION)
                yield* writer.write(XdrCodec.uint64, secondClient)
                yield* writer.write(XdrCodec.uint32, sequenceId)
                yield* writer.write(XdrCodec.uint32, 0)
              })
              yield* channel(writer, 2)
              yield* channel(writer, 0)
              yield* Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.uint32, 0)
              })
            })])

        const failedCreate = yield* createSecond(1)
        assert.strictEqual(
          yield* (yield* make.openReader(yield* handler.compound(failedCreate), constrained)).read(XdrCodec.uint32),
          Status.DELAY
        )
        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(
              yield* call([(writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.DESTROY_SESSION)
                  yield* writer.write(XdrCodec.fixedOpaque(first.session.length), first.session)
                })])
            ),
            constrained
          )).read(XdrCodec.uint32),
          Status.OK
        )
        // The failed attempt did not consume the sequence slot, so the same request now succeeds.
        const created = yield* make.openReader(yield* handler.compound(failedCreate), constrained)
        assert.strictEqual(yield* created.read(XdrCodec.uint32), Status.OK)
        yield* created.read(XdrCodec.string())
        yield* created.read(XdrCodec.uint32)
        yield* created.read(XdrCodec.uint32)
        yield* created.read(XdrCodec.uint32)
        const secondSession = yield* created.read(XdrCodec.fixedOpaque(16))

        const opened = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(secondSession, 1, true),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openReadOnly(secondClient, "file"),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        const full = yield* call([
          sequence(secondSession, 2),
          (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.OPEN)
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.uint32, 1)
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.uint64, secondClient)
              yield* writer.write(XdrCodec.string(), "other-owner")
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.string(), "file")
            })
        ])

        assert.strictEqual(
          yield* (yield* make.openReader(yield* handler.compound(full), constrained)).read(XdrCodec.uint32),
          Status.DELAY
        )
        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(
              yield* call([sequence(secondSession, 3), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                  yield* writer.write(XdrCodec.opaque(), opened.filehandle)
                }), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.CLOSE)
                  yield* writer.write(XdrCodec.uint32, 0)
                  yield* writer.write(XdrCodec.fixedOpaque(opened.stateid.length), opened.stateid)
                })])
            ),
            constrained
          )).read(XdrCodec.uint32),
          Status.OK
        )
        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(
              yield* call([
                sequence(secondSession, 4),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                openReadOnly(secondClient, "file")
              ])
            ),
            constrained
          )).read(XdrCodec.uint32),
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should keep a client busy until its open and session are destroyed when a client still owns an open and session", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        const root = yield* caller.root
        const reference = yield* caller.lookup(Vfs.Entry(root, new TextEncoder().encode("file")))

        const handler = yield* makeHandler(caller)

        const client = yield* startSession(handler, "destroy-client")

        const opened = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(client.session, 1, true),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openReadOnly(client.client, "file"),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(
              yield* call([sequence(client.session, 2), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.RECLAIM_COMPLETE)
                  yield* writer.write(XdrCodec.boolean, false)
                })])
            ),
            limits
          )).read(XdrCodec.uint32),
          Status.OK
        )
        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(
              yield* call([sequence(client.session, 3), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.RECLAIM_COMPLETE)
                  yield* writer.write(XdrCodec.boolean, false)
                })])
            ),
            limits
          )).read(XdrCodec.uint32),
          Status.COMPLETE_ALREADY
        )
        yield* caller.unlink("/file")
        assert.strictEqual((yield* caller.stat(reference)).nlink, 0)
        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(
              yield* call([(writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.DESTROY_CLIENTID)
                  yield* writer.write(XdrCodec.uint64, client.client)
                })])
            ),
            limits
          )).read(XdrCodec.uint32),
          Status.CLIENTID_BUSY
        )

        const sequencedDestroy = yield* call([sequence(client.session, 4, true), (writer) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.DESTROY_CLIENTID)
            yield* writer.write(XdrCodec.uint64, client.client)
          })])

        const firstBusy = yield* handler.compound(sequencedDestroy)
        assert.strictEqual(
          yield* (yield* make.openReader(firstBusy, limits)).read(XdrCodec.uint32),
          Status.CLIENTID_BUSY
        )
        assert.deepStrictEqual(yield* handler.compound(sequencedDestroy), firstBusy)
        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(
              yield* call([sequence(client.session, 5), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                  yield* writer.write(XdrCodec.opaque(), opened.filehandle)
                }), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.CLOSE)
                  yield* writer.write(XdrCodec.uint32, 0)
                  yield* writer.write(XdrCodec.fixedOpaque(opened.stateid.length), opened.stateid)
                })])
            ),
            limits
          )).read(XdrCodec.uint32),
          Status.OK
        )
        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(
              yield* call([(writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.DESTROY_SESSION)
                  yield* writer.write(XdrCodec.fixedOpaque(client.session.length), client.session)
                })])
            ),
            limits
          )).read(XdrCodec.uint32),
          Status.OK
        )
        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(
              yield* call([(writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.DESTROY_CLIENTID)
                  yield* writer.write(XdrCodec.uint64, client.client)
                })])
            ),
            limits
          )).read(XdrCodec.uint32),
          Status.OK
        )
        assert.strictEqual((yield* Effect.flip(caller.stat(reference))).code, "StaleReference")
        assert.strictEqual(
          yield* (yield* make.openReader(yield* handler.compound(yield* call([sequence(client.session, 6)])), limits))
            .read(XdrCodec.uint32),
          Status.BADSESSION
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should preserve prior results before an unknown operation and structurally validates mutation attrs when a compound reaches an unknown operation or malformed mutation attrs", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const handler = yield* makeHandler(caller)

        const client = yield* startSession(handler, "decode")

        const unknown = yield* call([
          sequence(client.session, 1),
          (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, 99_999)
              yield* writer.write(XdrCodec.uint32, 0xdeadbeef)
            })
        ])

        const unknownResult = yield* statuses(yield* handler.compound(unknown))
        assert.strictEqual(unknownResult.status, Status.OP_ILLEGAL)
        assert.deepStrictEqual(unknownResult.operations.at(-1), [Operation.ILLEGAL, Status.OP_ILLEGAL])

        const malformed = yield* call([
          sequence(client.session, 2),
          (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.SETATTR)
              yield* writer.write(XdrCodec.fixedOpaque(new Uint8Array(16).length), new Uint8Array(16))
              yield* writer.write(XdrCodec.uint32, 2)
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.uint32, 1 << 1)
              yield* writer.write(XdrCodec.opaque(), new Uint8Array())
            })
        ])

        assert.strictEqual(
          yield* (yield* make.openReader(yield* handler.compound(malformed), limits)).read(XdrCodec.uint32),
          Status.BADXDR
        )
      }).pipe(Effect.provide(Testing.layer())))
  })
})

describe("Locks", () => {
  const lock =
    (stateid: Uint8Array, client: bigint, owner: string, offset: bigint, length: bigint, type = 1) =>
    (writer: EncoderSession) =>
      Effect.gen(function*() {
        yield* writer.write(XdrCodec.uint32, Operation.LOCK)
        yield* writer.write(XdrCodec.uint32, type)
        yield* writer.write(XdrCodec.boolean, false)
        yield* writer.write(XdrCodec.uint64, offset)
        yield* writer.write(XdrCodec.uint64, length)
        yield* writer.write(XdrCodec.boolean, true)
        yield* writer.write(XdrCodec.uint32, 0)
        yield* writer.write(XdrCodec.fixedOpaque(stateid.length), stateid)
        yield* writer.write(XdrCodec.uint32, 0)
        yield* writer.write(XdrCodec.uint64, client)
        yield* writer.write(XdrCodec.string(), owner)
      })

  const lockExisting = (stateid: Uint8Array, offset: bigint, length: bigint, type = 1) => (writer: EncoderSession) =>
    Effect.gen(function*() {
      yield* writer.write(XdrCodec.uint32, Operation.LOCK)
      yield* writer.write(XdrCodec.uint32, type)
      yield* writer.write(XdrCodec.boolean, false)
      yield* writer.write(XdrCodec.uint64, offset)
      yield* writer.write(XdrCodec.uint64, length)
      yield* writer.write(XdrCodec.boolean, false)
      yield* writer.write(XdrCodec.fixedOpaque(stateid.length), stateid)
      yield* writer.write(XdrCodec.uint32, 0)
    })

  const unlock = (stateid: Uint8Array, offset: bigint, length: bigint) => (writer: EncoderSession) =>
    Effect.gen(function*() {
      yield* writer.write(XdrCodec.uint32, Operation.LOCKU)
      yield* writer.write(XdrCodec.uint32, 1)
      yield* writer.write(XdrCodec.uint32, 0)
      yield* writer.write(XdrCodec.fixedOpaque(stateid.length), stateid)
      yield* writer.write(XdrCodec.uint64, offset)
      yield* writer.write(XdrCodec.uint64, length)
    })

  const lockTest =
    (client: bigint, owner: string, offset: bigint, length: bigint, type = 1) => (writer: EncoderSession) =>
      Effect.gen(function*() {
        yield* writer.write(XdrCodec.uint32, Operation.LOCKT)
        yield* writer.write(XdrCodec.uint32, type)
        yield* writer.write(XdrCodec.uint64, offset)
        yield* writer.write(XdrCodec.uint64, length)
        yield* writer.write(XdrCodec.uint64, client)
        yield* writer.write(XdrCodec.string(), owner)
      })

  const denied = (bytes: Uint8Array, operation: number) =>
    Effect.gen(function*() {
      const reader = yield* make.openReader(bytes, limits)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.DENIED)
      yield* reader.read(XdrCodec.string())
      yield* reader.read(XdrCodec.uint32)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.SEQUENCE)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
      yield* reader.read(XdrCodec.fixedOpaque(16))

      for (let field = 0; field < 5; field++) yield* reader.read(XdrCodec.uint32)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.PUTFH)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), operation)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.DENIED)

      return {
        offset: yield* reader.read(XdrCodec.uint64),
        length: yield* reader.read(XdrCodec.uint64),
        type: yield* reader.read(XdrCodec.uint32),
        client: yield* reader.read(XdrCodec.uint64),
        owner: yield* reader.read(XdrCodec.string())
      }
    })

  const resultStateid = (bytes: Uint8Array, operation: number) =>
    Effect.gen(function*() {
      const reader = yield* make.openReader(bytes, limits)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
      yield* reader.read(XdrCodec.string())
      yield* reader.read(XdrCodec.uint32)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.SEQUENCE)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
      yield* reader.read(XdrCodec.fixedOpaque(16))

      for (let field = 0; field < 5; field++) yield* reader.read(XdrCodec.uint32)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.PUTFH)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), operation)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)

      return yield* reader.read(XdrCodec.fixedOpaque(16))
    })

  it.layer(NodeCrypto.layer)("NFSv4.1 byte-range locks", (it) => {
    it.effect("should share one owner's range across separate open stateids when one owner uses separate open stateids", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const handler = yield* makeHandler(caller, { writable: true })

        const first = yield* startSession(handler, "shared-lock-owner")
        const second = yield* startSession(handler, "other-lock-owner")

        const open = (number: number, owner: string) =>
          Effect.gen(function*() {
            return yield* handler.compound(
              yield* call([
                sequence(first.session, number),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.OPEN)
                    yield* writer.write(XdrCodec.uint32, 0)
                    yield* writer.write(XdrCodec.uint32, 3)
                    yield* writer.write(XdrCodec.uint32, 0)
                    yield* writer.write(XdrCodec.uint64, first.client)
                    yield* writer.write(XdrCodec.string(), owner)
                    yield* writer.write(XdrCodec.uint32, 0)
                    yield* writer.write(XdrCodec.uint32, 0)
                    yield* writer.write(XdrCodec.string(), "file")
                  }),
                (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
              ])
            )
          })

        const openedA = yield* parseOpen(yield* open(1, "open-a"))
        const openedB = yield* parseOpen(yield* open(2, "open-b"))

        const onFile = (number: number, operation: WriteOperation) =>
          Effect.gen(function*() {
            return yield* handler.compound(
              yield* call([sequence(first.session, number), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                  yield* writer.write(XdrCodec.opaque(), openedA.filehandle)
                }), operation])
            )
          })

        const heldA = yield* resultStateid(
          yield* onFile(3, lock(openedA.stateid, first.client, "shared", 0n, 100n, 2)),
          Operation.LOCK
        )

        const heldB = yield* resultStateid(
          yield* onFile(4, lock(openedB.stateid, first.client, "shared", 0n, 100n, 2)),
          Operation.LOCK
        )

        assert.strictEqual(
          (yield* statuses(
            yield* onFile(5, (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.FREE_STATEID)
                yield* writer.write(XdrCodec.fixedOpaque(heldA.length), heldA)
              }))
          )).status,
          Status.OK
        )
        assert.strictEqual(
          (yield* statuses(
            yield* onFile(6, (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.CLOSE)
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.fixedOpaque(openedA.stateid.length), openedA.stateid)
              }))
          )).status,
          Status.OK
        )
        yield* resultStateid(yield* onFile(7, unlock(heldB, 0n, 100n)), Operation.LOCKU)

        const openedOther = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(second.session, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openByName(second.client, "file", 3),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        yield* resultStateid(
          yield* handler.compound(
            yield* call([sequence(second.session, 2), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                yield* writer.write(XdrCodec.opaque(), openedOther.filehandle)
              }), lock(openedOther.stateid, second.client, "other", 0n, 100n, 2)])
          ),
          Operation.LOCK
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should report two-client read/write conflicts and permit disjoint ranges when two clients request overlapping or disjoint ranges", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const handler = yield* makeHandler(caller, { writable: true })

        const a = yield* startSession(handler, "writer-a")
        const b = yield* startSession(handler, "writer-b")

        const open = (client: typeof a) =>
          Effect.gen(function*() {
            return yield* handler.compound(
              yield* call([
                sequence(client.session, 1),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                openByName(client.client, "file", 3),
                (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
              ])
            )
          })

        const openedA = yield* parseOpen(yield* open(a))
        const openedB = yield* parseOpen(yield* open(b))

        const onFile = (client: typeof a, number: number, operation: WriteOperation) =>
          Effect.gen(function*() {
            return yield* handler.compound(
              yield* call([sequence(client.session, number), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                  yield* writer.write(XdrCodec.opaque(), openedA.filehandle)
                }), operation])
            )
          })

        const held = yield* resultStateid(
          yield* onFile(a, 2, lock(openedA.stateid, a.client, "owner-a", 100n, 100n, 2)),
          Operation.LOCK
        )

        assert.deepStrictEqual(
          yield* denied(yield* onFile(b, 2, lockTest(b.client, "owner-b", 150n, 5n)), Operation.LOCKT),
          {
            offset: 100n,
            length: 100n,
            type: 2,
            client: a.client,
            owner: "owner-a"
          }
        )
        assert.deepStrictEqual(
          yield* denied(yield* onFile(b, 3, lock(openedB.stateid, b.client, "owner-b", 150n, 5n, 4)), Operation.LOCK),
          {
            offset: 100n,
            length: 100n,
            type: 2,
            client: a.client,
            owner: "owner-a"
          }
        )
        yield* resultStateid(
          yield* onFile(b, 4, lock(openedB.stateid, b.client, "owner-b", 200n, 5n, 2)),
          Operation.LOCK
        )
        const changed = yield* resultStateid(yield* onFile(a, 3, lockExisting(held, 125n, 25n, 1)), Operation.LOCK)
        assert.strictEqual(
          (yield* statuses(yield* onFile(b, 5, lockTest(b.client, "owner-b", 125n, 25n)))).status,
          Status.OK
        )
        const released = yield* resultStateid(yield* onFile(a, 4, unlock(changed, 150n, 50n)), Operation.LOCKU)
        yield* resultStateid(
          yield* onFile(b, 6, lock(openedB.stateid, b.client, "owner-b", 150n, 50n, 2)),
          Operation.LOCK
        )
        assert.strictEqual((yield* statuses(yield* onFile(a, 5, unlock(released, 100n, 50n)))).status, Status.OK)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should hold read locks through stateids and release them before CLOSE when read locks are held and CLOSE follows", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1, 2]), {
          access: "write",
          create: "exclusive"
        })

        const { handler, client, session } = yield* openSession(caller, "lock-holder")

        const opened = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openReadOnly(client, "file"),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        const onFile = (number: number, operation: WriteOperation) =>
          Effect.gen(function*() {
            return yield* handler.compound(
              yield* call([sequence(session, number), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                  yield* writer.write(XdrCodec.opaque(), opened.filehandle)
                }), operation])
            )
          })

        const granted = yield* resultStateid(
          yield* onFile(2, lock(opened.stateid, client, "owner", 0n, 2n)),
          Operation.LOCK
        )

        assert.strictEqual(new DataView(granted.buffer, granted.byteOffset, 4).getUint32(0), 1)
        const extended = yield* resultStateid(yield* onFile(3, lockExisting(granted, 4n, 2n)), Operation.LOCK)
        assert.strictEqual(new DataView(extended.buffer, extended.byteOffset, 4).getUint32(0), 2)

        const testStateids = (response: Uint8Array) =>
          Effect.gen(function*() {
            const reader = yield* make.openReader(response, limits)
            assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
            yield* reader.read(XdrCodec.string())
            yield* reader.read(XdrCodec.uint32)
            assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.SEQUENCE)
            assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
            yield* reader.read(XdrCodec.fixedOpaque(16))

            for (let field = 0; field < 5; field++) yield* reader.read(XdrCodec.uint32)
            const next = yield* reader.read(XdrCodec.uint32)

            if (next === Operation.PUTFH) {
              assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
              assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.TEST_STATEID)
            } else {
              assert.strictEqual(next, Operation.TEST_STATEID)
            }

            assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)

            return yield* reader.read(XdrCodec.array(XdrCodec.uint32))
          })

        const test = (stateids: ReadonlyArray<Uint8Array>): WriteOperation => (writer) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.TEST_STATEID)
            yield* writer.write(XdrCodec.array(XdrCodec.fixedOpaque(16)), stateids)
          })

        assert.deepStrictEqual(yield* testStateids(yield* onFile(4, test([extended, granted]))), [
          Status.OK,
          Status.OLD_STATEID
        ])
        const foreign = yield* startSession(handler, "foreign-lock-client")
        assert.deepStrictEqual(
          yield* testStateids(yield* handler.compound(yield* call([sequence(foreign.session, 1), test([extended])]))),
          [Status.BAD_STATEID]
        )

        const replaced = yield* resultStateid(
          yield* onFile(5, lock(opened.stateid, client, "owner", 1n, 2n)),
          Operation.LOCK
        )

        assert.strictEqual(
          (yield* statuses(
            yield* onFile(6, (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.CLOSE)
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.fixedOpaque(opened.stateid.length), opened.stateid)
              }))
          )).status,
          Status.LOCKS_HELD
        )
        assert.strictEqual(
          (yield* statuses(
            yield* onFile(7, (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.READ)
                yield* writer.write(XdrCodec.fixedOpaque(replaced.length), replaced)
                yield* writer.write(XdrCodec.uint64, 0n)
                yield* writer.write(XdrCodec.uint32, 2)
              }))
          )).status,
          Status.OK
        )
        assert.strictEqual((yield* statuses(yield* onFile(8, unlock(granted, 0n, 2n)))).status, Status.OLD_STATEID)
        const partial = yield* resultStateid(yield* onFile(9, unlock(replaced, 1n, 1n)), Operation.LOCKU)
        const narrowed = yield* resultStateid(yield* onFile(10, unlock(partial, 0n, 3n)), Operation.LOCKU)
        assert.strictEqual((yield* statuses(yield* onFile(11, unlock(narrowed, 4n, 2n)))).status, Status.OK)
        assert.strictEqual(
          (yield* statuses(
            yield* onFile(12, (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.CLOSE)
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.fixedOpaque(opened.stateid.length), opened.stateid)
              }))
          )).status,
          Status.OK
        )
        assert.strictEqual((yield* statuses(yield* onFile(13, unlock(narrowed, 4n, 2n)))).status, Status.BAD_STATEID)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should bound lock records without consuming owner capacity on a rejected request when a lock request exceeds the record limit", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const constrained = {
          ...limits,
          maxLockOwners: 1,
          maxLocks: 1
        }

        const { handler, client, session } = yield* openSession(caller, "lock-limits", { limits: constrained })

        const opened = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openReadOnly(client, "file"),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        const onFile = (number: number, operation: WriteOperation) =>
          Effect.gen(function*() {
            return yield* handler.compound(
              yield* call([sequence(session, number), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                  yield* writer.write(XdrCodec.opaque(), opened.filehandle)
                }), operation])
            )
          })

        assert.strictEqual(
          (yield* statuses(yield* onFile(2, lock(opened.stateid, client, "a", 0n, 0n)))).status,
          Status.INVAL
        )
        const first = yield* resultStateid(yield* onFile(3, lock(opened.stateid, client, "a", 0n, 1n)), Operation.LOCK)
        assert.strictEqual(
          (yield* statuses(yield* onFile(4, lock(opened.stateid, client, "a", 2n, 1n)))).status,
          Status.DELAY
        )
        assert.strictEqual(
          (yield* statuses(yield* onFile(5, lock(opened.stateid, client, "b", 2n, 1n)))).status,
          Status.DELAY
        )
        const released = yield* resultStateid(yield* onFile(6, unlock(first, 0n, 1n)), Operation.LOCKU)
        assert.strictEqual(
          (yield* statuses(
            yield* onFile(7, (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.FREE_STATEID)
                yield* writer.write(XdrCodec.fixedOpaque(released.length), released)
              }))
          )).status,
          Status.OK
        )
        assert.strictEqual(
          (yield* statuses(yield* onFile(8, lock(opened.stateid, client, "b", 2n, 0xffff_ffff_ffff_ffffn)))).status,
          Status.OK
        )
        assert.strictEqual(
          (yield* statuses(yield* onFile(9, lock(opened.stateid, client, "b", 0xffff_ffff_ffff_fffen, 2n)))).status,
          Status.INVAL
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should keep a split within the range limit and replay a lock only once when a split lock and replay approach the range limit", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const handler = yield* makeHandler(caller, {
          limits: {
            ...limits,
            maxLocks: 1
          }
        })

        const client = yield* startSession(handler, "split-limit")

        const opened = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(client.session, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openReadOnly(client.client, "file"),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        const request = yield* call([sequence(client.session, 2, true), (writer) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
            yield* writer.write(XdrCodec.opaque(), opened.filehandle)
          }), lock(opened.stateid, client.client, "owner", 0n, 10n)])

        const first = yield* handler.compound(request)
        const held = yield* resultStateid(first, Operation.LOCK)
        assert.deepStrictEqual(yield* handler.compound(request), first)

        const onFile = (number: number, operation: WriteOperation) =>
          Effect.gen(function*() {
            return yield* handler.compound(
              yield* call([sequence(client.session, number), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                  yield* writer.write(XdrCodec.opaque(), opened.filehandle)
                }), operation])
            )
          })

        assert.strictEqual((yield* statuses(yield* onFile(3, unlock(held, 4n, 2n)))).status, Status.DELAY)
        const released = yield* resultStateid(yield* onFile(4, unlock(held, 0n, 5n)), Operation.LOCKU)
        assert.strictEqual((yield* statuses(yield* onFile(5, unlock(released, 5n, 5n)))).status, Status.OK)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should reject another client's unlock when the byte range belongs to an owner", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const handler = yield* makeHandler(caller)

        const first = yield* startSession(handler, "first-lock-client")

        const opened = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(first.session, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openReadOnly(first.client, "file"),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        const granted = yield* resultStateid(
          yield* handler.compound(
            yield* call([sequence(first.session, 2), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                yield* writer.write(XdrCodec.opaque(), opened.filehandle)
              }), lock(opened.stateid, first.client, "owner", 0n, 1n)])
          ),
          Operation.LOCK
        )

        const second = yield* startSession(handler, "second-lock-client")
        assert.strictEqual(
          (yield* statuses(
            yield* handler.compound(
              yield* call([sequence(second.session, 1), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                  yield* writer.write(XdrCodec.opaque(), opened.filehandle)
                }), unlock(granted, 0n, 1n)])
            )
          )).status,
          Status.BAD_STATEID
        )
        assert.strictEqual(
          (yield* statuses(
            yield* handler.compound(
              yield* call([sequence(first.session, 3), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                  yield* writer.write(XdrCodec.opaque(), opened.filehandle)
                }), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.CLOSE)
                  yield* writer.write(XdrCodec.uint32, 0)
                  yield* writer.write(XdrCodec.fixedOpaque(opened.stateid.length), opened.stateid)
                })])
            )
          )).status,
          Status.LOCKS_HELD
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should release lock-owner capacity when a client's lease expires", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const constrained = {
          ...limits,
          maxLockOwners: 1,
          maxLocks: 1
        }

        let now = 0

        const handler = yield* makeHandler(caller, { leaseDurationSeconds: 1, now: () => now, limits: constrained })

        const first = yield* startSession(handler, "expired-lock-client")

        const opened = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(first.session, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openReadOnly(first.client, "file"),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        yield* resultStateid(
          yield* handler.compound(
            yield* call([sequence(first.session, 2), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                yield* writer.write(XdrCodec.opaque(), opened.filehandle)
              }), lock(opened.stateid, first.client, "owner", 0n, 1n)])
          ),
          Operation.LOCK
        )
        now = 2_000
        assert.strictEqual(
          (yield* statuses(yield* handler.compound(yield* call([sequence(first.session, 3)])))).status,
          Status.BADSESSION
        )
        const second = yield* startSession(handler, "new-lock-client")

        const reopened = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(second.session, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openReadOnly(second.client, "file"),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        assert.strictEqual(
          (yield* statuses(
            yield* handler.compound(
              yield* call([sequence(second.session, 2), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                  yield* writer.write(XdrCodec.opaque(), reopened.filehandle)
                }), lock(reopened.stateid, second.client, "owner", 0n, 1n)])
            )
          )).status,
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))
  })
})

describe("MetadataReadDir", () => {
  it.layer(NodeCrypto.layer)("NFSv4.1 MetadataReadDir", (it) => {
    it.effect("should encode every advertised GETATTR value from one file observation when GETATTR requests all advertised attributes", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1, 2, 3]), {
          access: "write",
          create: "exclusive"
        })
        yield* caller.link("/file", "/alias")
        yield* caller.chmod("/file", 0o640)
        yield* caller.chown("/file", {
          uid: 501,
          gid: 20
        })

        const export_ = yield* exportFor(caller)

        const root = yield* caller.root
        const reference = yield* caller.lookup(Vfs.Entry(root, new TextEncoder().encode("file")))
        const observation = yield* caller.stat(reference)
        const expectedHandle = yield* export_.handleFor(reference)

        const handler = yield* handlerFor(export_)

        const {
          session
        } = yield* startSession(handler, "all-attributes")

        const requested = [3_826_978_815, 12_099_646, 6_144]

        const response = yield* make.openReader(
          yield* handler.compound(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                  yield* writer.write(XdrCodec.string(), "file")
                }),
              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.GETATTR)
                  yield* writer.write(XdrCodec.uint32, requested.length)

                  for (const xdrValue of requested) {
                    yield* ((item, word) =>
                      Effect.gen(function*() {
                        const xdrWriter = item
                        yield* xdrWriter.write(XdrCodec.uint32, word)
                      }))(writer, xdrValue)
                  }
                })
            ])
          ),
          limits
        )

        assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.OK)
        yield* response.read(XdrCodec.string())
        yield* response.read(XdrCodec.uint32)
        yield* response.read(XdrCodec.uint32)
        yield* response.read(XdrCodec.uint32)
        yield* response.read(XdrCodec.fixedOpaque(16))

        for (let field = 0; field < 5; field++) {
          yield* response.read(XdrCodec.uint32)
        }

        yield* response.read(XdrCodec.uint32)
        yield* response.read(XdrCodec.uint32)
        yield* response.read(XdrCodec.uint32)
        yield* response.read(XdrCodec.uint32)
        assert.strictEqual(yield* response.read(XdrCodec.uint32), Operation.GETATTR)
        assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.OK)
        assert.deepStrictEqual(yield* response.read(XdrCodec.array(XdrCodec.uint32)), requested)
        const values = yield* make.openReader(yield* response.read(XdrCodec.opaque()), limits)
        // The supported set adds maxfilesize (27), which this request leaves out.
        assert.deepStrictEqual(yield* values.read(XdrCodec.array(XdrCodec.uint32)), [
          3_961_196_543,
          12_099_646,
          6_144
        ])
        assert.strictEqual(yield* values.read(XdrCodec.uint32), 1)
        assert.strictEqual(yield* values.read(XdrCodec.uint32), 0x3)
        assert.strictEqual(yield* values.read(XdrCodec.uint64), observation.revision)
        assert.strictEqual(yield* values.read(XdrCodec.uint64), 3n)
        assert.isTrue(yield* values.read(XdrCodec.boolean))
        assert.isTrue(yield* values.read(XdrCodec.boolean))
        assert.isFalse(yield* values.read(XdrCodec.boolean))
        assert.deepStrictEqual([yield* values.read(XdrCodec.uint64), yield* values.read(XdrCodec.uint64)], export_.fsid)
        assert.isTrue(yield* values.read(XdrCodec.boolean))
        assert.strictEqual(yield* values.read(XdrCodec.uint32), 30)
        assert.strictEqual(yield* values.read(XdrCodec.uint32), Status.OK)
        assert.isFalse(yield* values.read(XdrCodec.boolean), "case_insensitive")
        assert.isTrue(yield* values.read(XdrCodec.boolean), "case_preserving")
        assert.deepStrictEqual(yield* values.read(XdrCodec.opaque()), expectedHandle)
        assert.strictEqual(yield* values.read(XdrCodec.uint64), observation.ino)
        assert.isTrue(yield* values.read(XdrCodec.boolean), "homogeneous")
        assert.strictEqual(yield* values.read(XdrCodec.uint32), ByteSize.toNumberUnsafe(limits.maxNameBytes))
        assert.strictEqual(yield* values.read(XdrCodec.uint64), BigInt(limits.maxReadBytes))
        assert.strictEqual(yield* values.read(XdrCodec.uint64), BigInt(limits.maxWriteBytes))
        assert.strictEqual(yield* values.read(XdrCodec.uint32), 0o640)
        assert.isTrue(yield* values.read(XdrCodec.boolean), "no_trunc")
        assert.strictEqual(yield* values.read(XdrCodec.uint32), 2)
        assert.strictEqual(yield* values.read(XdrCodec.string()), "501")
        assert.strictEqual(yield* values.read(XdrCodec.string()), "20")
        assert.strictEqual(yield* values.read(XdrCodec.uint64), 3n)

        const readTime = () =>
          Effect.gen(function*() {
            const seconds = yield* values.read(XdrCodec.uint64)
            const nanoseconds = yield* values.read(XdrCodec.uint32)

            return {
              seconds,
              nanoseconds
            }
          })

        const expectTime = (timestamp: bigint) =>
          Effect.gen(function*() {
            assert.deepStrictEqual(yield* readTime(), {
              seconds: timestamp / 1_000_000_000n,
              nanoseconds: Number(timestamp % 1_000_000_000n)
            })
          })

        yield* expectTime(observation.atimeNs)
        assert.deepStrictEqual(yield* readTime(), {
          seconds: 0n,
          nanoseconds: 1
        }, "time_delta")
        yield* expectTime(observation.ctimeNs)
        yield* expectTime(observation.mtimeNs)
        assert.strictEqual(yield* values.read(XdrCodec.uint64), observation.ino)
        assert.deepStrictEqual(yield* values.read(XdrCodec.array(XdrCodec.uint32)), [])
        assert.strictEqual(yield* values.read(XdrCodec.uint32), 0x2, "fs_charset_cap: FSCHARSET_CAP4_ALLOWS_ONLY_UTF8")
        yield* values.finish
        yield* response.finish
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should report bounded volume capacity and omit unbounded totals when GETATTR queries bounded and unbounded volumes", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.mkdir("/dir")
        yield* caller.writeFile("/file", new Uint8Array([1, 2, 3]), {
          access: "write",
          create: "exclusive"
        })

        const export_ = yield* exportFor(caller)

        const handler = yield* handlerFor(export_)

        const {
          session
        } = yield* startSession(handler, "bounded-capacity")

        const requested = [1 | 1 << 21 | 1 << 22 | 1 << 23 | 1 << 27, 1 << 10 | 1 << 11 | 1 << 12]

        const response = yield* make.openReader(
          yield* handler.compound(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.GETATTR)
                  yield* writer.write(XdrCodec.uint32, requested.length)

                  for (const xdrValue of requested) {
                    yield* ((item, word) =>
                      Effect.gen(function*() {
                        const xdrWriter = item
                        yield* xdrWriter.write(XdrCodec.uint32, word)
                      }))(writer, xdrValue)
                  }
                })
            ])
          ),
          limits
        )

        assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.OK)
        yield* response.read(XdrCodec.string())
        yield* response.read(XdrCodec.uint32)
        yield* response.read(XdrCodec.uint32)
        yield* response.read(XdrCodec.uint32)
        yield* response.read(XdrCodec.fixedOpaque(16))

        for (let field = 0; field < 5; field++) {
          yield* response.read(XdrCodec.uint32)
        }

        yield* response.read(XdrCodec.uint32)
        yield* response.read(XdrCodec.uint32)
        assert.strictEqual(yield* response.read(XdrCodec.uint32), Operation.GETATTR)
        assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.OK)
        assert.deepStrictEqual(yield* response.read(XdrCodec.array(XdrCodec.uint32)), requested)
        const values = yield* make.openReader(yield* response.read(XdrCodec.opaque()), limits)
        const supported = yield* values.read(XdrCodec.array(XdrCodec.uint32))
        assert.strictEqual(supported[0]! & requested[0]!, requested[0]!)
        assert.strictEqual(supported[1]! & requested[1]!, requested[1]!)
        assert.strictEqual(yield* values.read(XdrCodec.uint64), 1n, "files_avail")
        assert.strictEqual(yield* values.read(XdrCodec.uint64), 1n, "files_free")
        assert.strictEqual(yield* values.read(XdrCodec.uint64), 3n, "files_total")
        assert.strictEqual(yield* values.read(XdrCodec.uint64), 0xffff_ffffn, "maxfilesize")
        assert.strictEqual(yield* values.read(XdrCodec.uint64), 7n, "space_avail")
        assert.strictEqual(yield* values.read(XdrCodec.uint64), 7n, "space_free")
        assert.strictEqual(yield* values.read(XdrCodec.uint64), 10n, "space_total")
        yield* values.finish
        yield* response.finish
        const unlimited = yield* Vfs.make()
        const unlimitedCaller = yield* unlimited.caller()

        const unlimitedHandler = yield* makeHandler(unlimitedCaller).pipe(
          Effect.provideService(Vfs.Volume, unlimited)
        )

        const unlimitedSession = yield* startSession(unlimitedHandler, "unbounded-capacity")

        const unboundedResponse = yield* make.openReader(
          yield* unlimitedHandler.compound(
            yield* call([
              sequence(unlimitedSession.session, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.GETATTR)
                  yield* writer.write(XdrCodec.uint32, requested.length)

                  for (const xdrValue of requested) {
                    yield* ((item, word) =>
                      Effect.gen(function*() {
                        const xdrWriter = item
                        yield* xdrWriter.write(XdrCodec.uint32, word)
                      }))(writer, xdrValue)
                  }
                })
            ])
          ),
          limits
        )

        assert.strictEqual(yield* unboundedResponse.read(XdrCodec.uint32), Status.OK)
        yield* unboundedResponse.read(XdrCodec.string())
        yield* unboundedResponse.read(XdrCodec.uint32)
        yield* unboundedResponse.read(XdrCodec.uint32)
        yield* unboundedResponse.read(XdrCodec.uint32)
        yield* unboundedResponse.read(XdrCodec.fixedOpaque(16))

        for (let field = 0; field < 5; field++) {
          yield* unboundedResponse.read(XdrCodec.uint32)
        }

        yield* unboundedResponse.read(XdrCodec.uint32)
        yield* unboundedResponse.read(XdrCodec.uint32)
        assert.strictEqual(yield* unboundedResponse.read(XdrCodec.uint32), Operation.GETATTR)
        assert.strictEqual(yield* unboundedResponse.read(XdrCodec.uint32), Status.OK)
        assert.deepStrictEqual(yield* unboundedResponse.read(XdrCodec.array(XdrCodec.uint32)), [1 | 1 << 27])
        const unboundedValues = yield* make.openReader(yield* unboundedResponse.read(XdrCodec.opaque()), limits)
        const unboundedSupported = yield* unboundedValues.read(XdrCodec.array(XdrCodec.uint32))
        assert.strictEqual(unboundedSupported[0]! & requested[0]!, 1 | 1 << 27)
        assert.strictEqual((unboundedSupported[1] ?? 0) & requested[1]!, 0)
        assert.strictEqual(yield* unboundedValues.read(XdrCodec.uint64), 0xffff_ffffn)
        yield* unboundedValues.finish
        yield* unboundedResponse.finish

        const unsupportedVerify = yield* unlimitedHandler.compound(
          yield* call([
            sequence(unlimitedSession.session, 2),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.VERIFY)
                yield* writer.write(XdrCodec.uint32, [0, 1 << 10].length)

                for (const xdrValue of [0, 1 << 10]) {
                  yield* ((item, word) =>
                    Effect.gen(function*() {
                      const xdrWriter = item
                      yield* xdrWriter.write(XdrCodec.uint32, word)
                    }))(writer, xdrValue)
                }

                yield* writer.write(XdrCodec.opaque(), new Uint8Array())
              })
          ])
        )

        assert.strictEqual(
          yield* (yield* make.openReader(unsupportedVerify, limits)).read(XdrCodec.uint32),
          Status.ATTRNOTSUPP
        )
      }).pipe(Effect.provide(Testing.layer({ volume: { maxBytes: ByteSize.bytes(10), maxEntries: 3 } }))))
    it.effect("should normalize negative timestamps and reject seconds outside the NFS int64 range when NFS timestamps are negative or exceed int64 seconds", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        yield* caller.utimes("/file", {
          access: {
            kind: "value",
            nanoseconds: -500_000_000n
          },
          modification: {
            kind: "omit"
          }
        })

        const { handler, session } = yield* openSession(caller, "timestamp-bounds")

        const getattr = (sequenceId: number) =>
          Effect.gen(function*() {
            return yield* handler.compound(
              yield* call([
                sequence(session, sequenceId),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                    yield* writer.write(XdrCodec.string(), "file")
                  }),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.GETATTR)
                    yield* writer.write(XdrCodec.uint32, [0, 1 << 15].length)

                    for (const xdrValue of [0, 1 << 15]) {
                      yield* ((item, word) =>
                        Effect.gen(function*() {
                          const xdrWriter = item
                          yield* xdrWriter.write(XdrCodec.uint32, word)
                        }))(writer, xdrValue)
                    }
                  })
              ])
            )
          })

        const response = yield* make.openReader(yield* getattr(1), limits)
        assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.OK)
        yield* response.read(XdrCodec.string())
        yield* response.read(XdrCodec.uint32)
        yield* response.read(XdrCodec.uint32)
        yield* response.read(XdrCodec.uint32)
        yield* response.read(XdrCodec.fixedOpaque(16))

        for (let field = 0; field < 5; field++) yield* response.read(XdrCodec.uint32)

        for (let operation = 0; operation < 2; operation++) {
          yield* response.read(XdrCodec.uint32)
          yield* response.read(XdrCodec.uint32)
        }

        assert.strictEqual(yield* response.read(XdrCodec.uint32), Operation.GETATTR)
        assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.OK)
        assert.deepStrictEqual(yield* response.read(XdrCodec.array(XdrCodec.uint32)), [0, 1 << 15])
        const values = yield* make.openReader(yield* response.read(XdrCodec.opaque()), limits)
        assert.strictEqual(yield* values.read(XdrCodec.uint64), 0xffff_ffff_ffff_ffffn)
        assert.strictEqual(yield* values.read(XdrCodec.uint32), 500_000_000)
        yield* values.finish
        yield* response.finish
        yield* caller.utimes("/file", {
          access: {
            kind: "value",
            nanoseconds: 0x8000_0000_0000_0000n * 1_000_000_000n
          },
          modification: {
            kind: "omit"
          }
        })
        assert.strictEqual(
          yield* (yield* make.openReader(yield* getattr(2), limits)).read(XdrCodec.uint32),
          Status.SERVERFAULT
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should reject every decoded mutation as read-only without changing the volume when a decoded mutation reaches a read-only export", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        const original = new Uint8Array([1, 2, 3])
        yield* caller.writeFile("/file", original, {
          access: "write",
          create: "exclusive"
        })

        const handler = yield* makeHandler(caller)

        const client = yield* startSession(handler, "mutations")

        const mutations: ReadonlyArray<{
          readonly setup?: WriteOperation
          readonly operation: WriteOperation
        }> = [{
          setup: (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
              yield* writer.write(XdrCodec.string(), "file")
            }),
          operation: (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.SETATTR)
              yield* writer.write(XdrCodec.fixedOpaque(new Uint8Array(16).length), new Uint8Array(16))
              yield* writer.write(XdrCodec.uint32, 1)
              yield* writer.write(XdrCodec.uint32, 1 << 12)
              yield* writer.write(XdrCodec.opaque(), new Uint8Array())
            })
        }, {
          setup: (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
              yield* writer.write(XdrCodec.string(), "file")
            }),
          operation: (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.WRITE)
              yield* writer.write(XdrCodec.fixedOpaque(new Uint8Array(16).length), new Uint8Array(16))
              yield* writer.write(XdrCodec.uint64, 0n)
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.opaque(), new Uint8Array([9]))
            })
        }, {
          operation: (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.CREATE)
              yield* writer.write(XdrCodec.uint32, 2)
              yield* writer.write(XdrCodec.string(), "created")
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.opaque(), new Uint8Array())
            })
        }, {
          operation: (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.REMOVE)
              yield* writer.write(XdrCodec.string(), "file")
            })
        }, {
          setup: (writer) => writer.write(XdrCodec.uint32, Operation.SAVEFH),
          operation: (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.RENAME)
              yield* writer.write(XdrCodec.string(), "file")
              yield* writer.write(XdrCodec.string(), "renamed")
            })
        }, {
          setup: (writer) => writer.write(XdrCodec.uint32, Operation.SAVEFH),
          operation: (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.LINK)
              yield* writer.write(XdrCodec.string(), "linked")
            })
        }]

        for (let index = 0; index < mutations.length; index++) {
          const mutation = mutations[index]!

          const response = yield* handler.compound(
            yield* call([
              sequence(client.session, index + 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              ...(mutation.setup === undefined ? [] : [mutation.setup]),
              mutation.operation
            ])
          )

          assert.strictEqual(yield* (yield* make.openReader(response, limits)).read(XdrCodec.uint32), Status.ROFS)
        }

        assert.deepStrictEqual(yield* caller.readFile("/file"), original)

        for (const path of ["/created", "/renamed", "/linked"]) {
          assert.strictEqual((yield* Effect.flip(caller.stat(path))).code, "NotFound")
        }
      }).pipe(Effect.provide(Testing.layer())))
  })
})

describe("Namespace", () => {
  const root = (writer: EncoderSession) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)

  const save = (writer: EncoderSession) => writer.write(XdrCodec.uint32, Operation.SAVEFH)

  const lookup = (name: string) => (writer: EncoderSession) =>
    Effect.gen(function*() {
      yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
      yield* writer.write(XdrCodec.string(), name)
    })

  const createDirectory = (name: string) => (writer: EncoderSession) =>
    Effect.gen(function*() {
      yield* writer.write(XdrCodec.uint32, Operation.CREATE)
      yield* writer.write(XdrCodec.uint32, 2)
      yield* writer.write(XdrCodec.string(), name)
      yield* writer.write(XdrCodec.uint32, 0)
      yield* writer.write(XdrCodec.opaque(), new Uint8Array())
    })

  const createSymlink = (name: string, target: string) => (writer: EncoderSession) =>
    Effect.gen(function*() {
      yield* writer.write(XdrCodec.uint32, Operation.CREATE)
      yield* writer.write(XdrCodec.uint32, 5)
      yield* writer.write(XdrCodec.string(), target)
      yield* writer.write(XdrCodec.string(), name)
      yield* writer.write(XdrCodec.uint32, 0)
      yield* writer.write(XdrCodec.opaque(), new Uint8Array())
    })

  const link = (name: string) => (writer: EncoderSession) =>
    Effect.gen(function*() {
      yield* writer.write(XdrCodec.uint32, Operation.LINK)
      yield* writer.write(XdrCodec.string(), name)
    })

  const remove = (name: string) => (writer: EncoderSession) =>
    Effect.gen(function*() {
      yield* writer.write(XdrCodec.uint32, Operation.REMOVE)
      yield* writer.write(XdrCodec.string(), name)
    })

  const rename = (from: string, to: string) => (writer: EncoderSession) =>
    Effect.gen(function*() {
      yield* writer.write(XdrCodec.uint32, Operation.RENAME)
      yield* writer.write(XdrCodec.string(), from)
      yield* writer.write(XdrCodec.string(), to)
    })

  const status = (bytes: Uint8Array) =>
    Effect.gen(function*() {
      return yield* (yield* make.openReader(bytes, limits)).read(XdrCodec.uint32)
    })

  const namespaceChange = (bytes: Uint8Array, operation: number, prefix: ReadonlyArray<number>) =>
    Effect.gen(function*() {
      const reader = yield* make.openReader(bytes, limits)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
      yield* reader.read(XdrCodec.string())
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), prefix.length + 2)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.SEQUENCE)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
      yield* reader.read(XdrCodec.fixedOpaque(16))

      for (let field = 0; field < 5; field++) yield* reader.read(XdrCodec.uint32)

      for (const code of prefix) {
        assert.strictEqual(yield* reader.read(XdrCodec.uint32), code)
        assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
      }

      assert.strictEqual(yield* reader.read(XdrCodec.uint32), operation)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)

      const readChange = () =>
        Effect.gen(function*() {
          assert.isTrue(yield* reader.read(XdrCodec.boolean))
          const before = yield* reader.read(XdrCodec.uint64)
          const after = yield* reader.read(XdrCodec.uint64)
          assert.notStrictEqual(before, after)

          return {
            before,
            after
          }
        })

      const first = yield* readChange()
      const second = operation === Operation.RENAME ? yield* readChange() : undefined

      if (operation === Operation.CREATE) {
        assert.deepStrictEqual(yield* reader.read(XdrCodec.array(XdrCodec.uint32)), [])
      }

      yield* reader.finish

      return {
        first,
        second
      }
    })

  it.layer(NodeCrypto.layer)("NFS namespace mutations", (it) => {
    it.effect("should create a directory and symlink, reporting the directory change and retaining the created handle when CREATE makes a directory or symlink", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const { handler, session } = yield* openSession(caller, "namespace-create", {
          writable: true
        })

        const response = yield* make.openReader(
          yield* handler.compound(
            yield* call([
              sequence(session, 1),
              root,
              createDirectory("docs"),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          ),
          limits
        )

        assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.OK)
        yield* response.read(XdrCodec.string())
        assert.strictEqual(yield* response.read(XdrCodec.uint32), 4)
        assert.strictEqual(yield* response.read(XdrCodec.uint32), Operation.SEQUENCE)
        assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.OK)
        yield* response.read(XdrCodec.fixedOpaque(16))

        for (let field = 0; field < 5; field++) yield* response.read(XdrCodec.uint32)
        assert.strictEqual(yield* response.read(XdrCodec.uint32), Operation.PUTROOTFH)
        assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.OK)
        assert.strictEqual(yield* response.read(XdrCodec.uint32), Operation.CREATE)
        assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.OK)
        assert.strictEqual(yield* response.read(XdrCodec.boolean), true)
        assert.notStrictEqual(yield* response.read(XdrCodec.uint64), yield* response.read(XdrCodec.uint64))
        assert.deepStrictEqual(yield* response.read(XdrCodec.array(XdrCodec.uint32)), [])
        assert.strictEqual(yield* response.read(XdrCodec.uint32), Operation.GETFH)
        assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.OK)
        const directoryHandle = yield* response.read(XdrCodec.opaque())
        assert.ok(directoryHandle.length > 0)
        yield* response.finish
        assert.strictEqual(
          yield* status(
            yield* handler.compound(yield* call([sequence(session, 2), root, createSymlink("shortcut", "docs/guide")]))
          ),
          Status.OK
        )
        assert.strictEqual(new TextDecoder().decode(yield* caller.readLink("/shortcut")), "docs/guide")
        assert.strictEqual(
          yield* status(
            yield* handler.compound(
              yield* call([sequence(session, 3), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                  yield* writer.write(XdrCodec.opaque(), directoryHandle)
                }), createDirectory("nested")])
            )
          ),
          Status.OK
        )
        assert.strictEqual((yield* caller.stat("/docs/nested")).kind, "directory")
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should link and rename by saved and current handles while preserving inode identity when LINK and RENAME use saved and current filehandles", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.mkdir("/from")
        yield* caller.mkdir("/to")
        yield* caller.writeFile("/from/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        const original = yield* caller.stat("/from/file")

        const { handler, session } = yield* openSession(caller, "namespace-move", {
          writable: true
        })

        assert.strictEqual(
          yield* status(
            yield* handler.compound(
              yield* call([
                sequence(session, 1),
                root,
                lookup("from"),
                lookup("file"),
                save,
                root,
                lookup("to"),
                link("linked")
              ])
            )
          ),
          Status.OK
        )
        assert.strictEqual((yield* caller.stat("/to/linked")).ino, original.ino)
        assert.strictEqual(
          yield* status(
            yield* handler.compound(
              yield* call([
                sequence(session, 2),
                root,
                lookup("from"),
                save,
                root,
                lookup("to"),
                rename("file", "moved")
              ])
            )
          ),
          Status.OK
        )
        assert.strictEqual((yield* caller.stat("/to/moved")).ino, original.ino)
        assert.strictEqual(
          yield* status(
            yield* handler.compound(yield* call([sequence(session, 3), root, lookup("to"), remove("linked")]))
          ),
          Status.OK
        )
        assert.deepStrictEqual(yield* caller.readFile("/to/moved"), new Uint8Array([1]))
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should keep earlier compound mutations when a later operation fails", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const { handler, session } = yield* openSession(caller, "namespace-partial", {
          writable: true
        })

        const reply = yield* handler.compound(
          yield* call([sequence(session, 1), root, createDirectory("kept"), root, remove("missing")])
        )

        assert.strictEqual(yield* status(reply), Status.NOENT)
        assert.strictEqual((yield* caller.stat("/kept")).kind, "directory")
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should report changes for links, directory removal, and replacement rename when LINK, REMOVE, and replacement RENAME change directories", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.mkdir("/from")
        yield* caller.mkdir("/to")
        yield* caller.mkdir("/to/empty")
        yield* caller.writeFile("/from/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        yield* caller.writeFile("/to/replaced", new Uint8Array([2]), {
          access: "write",
          create: "exclusive"
        })
        const original = yield* caller.stat("/from/file")
        const rootReference = yield* caller.root
        const fromReference = yield* caller.lookup(Vfs.Entry(rootReference, new TextEncoder().encode("from")))
        const toReference = yield* caller.lookup(Vfs.Entry(rootReference, new TextEncoder().encode("to")))

        const { handler, session } = yield* openSession(caller, "namespace-change", {
          writable: true
        })

        const beforeLink = (yield* caller.stat(toReference)).revision

        const linked = yield* namespaceChange(
          yield* handler.compound(
            yield* call([
              sequence(session, 1),
              root,
              lookup("from"),
              lookup("file"),
              save,
              root,
              lookup("to"),
              link("alias")
            ])
          ),
          Operation.LINK,
          [
            Operation.PUTROOTFH,
            Operation.LOOKUP,
            Operation.LOOKUP,
            Operation.SAVEFH,
            Operation.PUTROOTFH,
            Operation.LOOKUP
          ]
        )

        assert.deepStrictEqual(linked.first, {
          before: beforeLink,
          after: (yield* caller.stat(toReference)).revision
        })
        assert.strictEqual((yield* caller.stat("/to/alias")).ino, original.ino)
        yield* namespaceChange(
          yield* handler.compound(yield* call([sequence(session, 2), root, lookup("to"), remove("empty")])),
          Operation.REMOVE,
          [Operation.PUTROOTFH, Operation.LOOKUP]
        )
        assert.strictEqual((yield* Effect.flip(caller.stat("/to/empty"))).code, "NotFound")
        const beforeFrom = (yield* caller.stat(fromReference)).revision
        const beforeTo = (yield* caller.stat(toReference)).revision

        const renamed = yield* namespaceChange(
          yield* handler.compound(
            yield* call([
              sequence(session, 3),
              root,
              lookup("from"),
              save,
              root,
              lookup("to"),
              rename("file", "replaced")
            ])
          ),
          Operation.RENAME,
          [Operation.PUTROOTFH, Operation.LOOKUP, Operation.SAVEFH, Operation.PUTROOTFH, Operation.LOOKUP]
        )

        assert.deepStrictEqual(renamed.first, {
          before: beforeFrom,
          after: (yield* caller.stat(fromReference)).revision
        })
        assert.deepStrictEqual(renamed.second, {
          before: beforeTo,
          after: (yield* caller.stat(toReference)).revision
        })
        assert.strictEqual((yield* caller.stat("/to/replaced")).ino, original.ino)
        assert.deepStrictEqual(yield* caller.readFile("/to/replaced"), new Uint8Array([1]))
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should reject invalid namespace operands when a namespace operand is invalid", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        const writable = yield* makeHandler(caller, { writable: true })

        const {
          session
        } = yield* startSession(writable, "namespace-errors")

        assert.strictEqual(
          yield* status(yield* writable.compound(yield* call([sequence(session, 1), root, remove("..")]))),
          Status.BADNAME
        )
        assert.strictEqual(
          yield* status(yield* writable.compound(yield* call([sequence(session, 2), root, remove("")]))),
          Status.INVAL
        )
        assert.strictEqual(
          yield* status(yield* writable.compound(yield* call([sequence(session, 3), root, remove("absent")]))),
          Status.NOENT
        )
        assert.strictEqual(
          yield* status(
            yield* writable.compound(yield* call([sequence(session, 4), root, lookup("file"), remove("x")]))
          ),
          Status.NOTDIR
        )
        assert.strictEqual(
          yield* status(yield* writable.compound(yield* call([sequence(session, 5), root, rename("file", "other")]))),
          Status.NOFILEHANDLE
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should enforce the mapped caller's directory permissions for namespace changes when a mapped caller changes a directory", () =>
      Effect.gen(function*() {
        const admin = yield* Vfs.Caller
        yield* admin.mkdir("/private", {
          mode: 0o700
        })
        yield* admin.writeFile("/private/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const guest = yield* Testing.callerAs({
          uid: 1000,
          gid: 1000,
          groups: [],
          privileged: false
        })

        const { handler, session } = yield* openSession(admin, "namespace-mapped-denial", {
          writable: true,
          callerFor: () => Effect.succeed(guest)
        })

        assert.strictEqual(
          yield* status(yield* handler.compound(yield* call([sequence(session, 1), root, createDirectory("blocked")]))),
          Status.ACCESS
        )
        assert.strictEqual(
          yield* status(yield* handler.compound(yield* call([sequence(session, 2), root, remove("private")]))),
          Status.ACCESS
        )
        assert.strictEqual((yield* admin.stat("/private/file")).kind, "file")
        assert.strictEqual((yield* Effect.flip(admin.stat("/blocked"))).code, "NotFound")
      }).pipe(Effect.provide(Testing.layer())))
    // Core fails these NotPermitted (EPERM). RFC 8881 Section 15.2 lists no NFS4ERR_PERM for REMOVE or RENAME,
    // so the answer is ACCESS.
    it.effect("should refuse removing, moving or replacing another owner's entry in a sticky directory as ACCESS when a sticky directory entry belongs to another owner", () =>
      Effect.gen(function*() {
        const admin = yield* Vfs.Caller
        yield* admin.chmod(yield* admin.root, 0o1777)
        yield* admin.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const guest = yield* Testing.callerAs({
          uid: 1000,
          gid: 1000,
          groups: [],
          privileged: false
        })

        yield* guest.writeFile("/mine", new Uint8Array([2, 2]), {
          access: "write",
          create: "exclusive"
        })

        const { handler, session } = yield* openSession(admin, "namespace-sticky-denial", {
          writable: true,
          callerFor: () => Effect.succeed(guest)
        })

        assert.deepStrictEqual(
          {
            remove: yield* status(yield* handler.compound(yield* call([sequence(session, 1), root, remove("file")]))),
            moveSource: yield* status(
              yield* handler.compound(yield* call([sequence(session, 2), root, save, root, rename("file", "moved")]))
            ),
            replaceTarget: yield* status(
              yield* handler.compound(yield* call([sequence(session, 3), root, save, root, rename("mine", "file")]))
            )
          },
          {
            remove: Status.ACCESS,
            moveSource: Status.ACCESS,
            replaceTarget: Status.ACCESS
          }
        )
        assert.strictEqual((yield* admin.stat("/file")).size, 1n)
        assert.strictEqual((yield* admin.stat("/mine")).size, 2n)
        assert.strictEqual((yield* Effect.flip(admin.stat("/moved"))).code, "NotFound")
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should reopen an injected committed image with NFS namespace and metadata changes when a committed namespace image is reopened", () => {
      let image: Uint8Array | undefined

      const store = Layer.succeed(
        LiveVolume.LiveImageStore,
        LiveVolume.LiveImageStore.of({
          loadOrCreate: (initial) => Effect.sync(() => image ??= initial),
          commit: (candidate) =>
            Effect.sync(() => {
              image = candidate.slice()

              return "committed" as const
            })
        })
      )

      const options: LiveVolume.Options = {
        maxImageBytes: ByteSize.kilobytes(64),
        volume: {
          maxEntries: 16,
          maxBytes: ByteSize.bytes(64),
          maxFileBytes: ByteSize.bytes(32),
          maxPathBytes: ByteSize.bytes(255)
        }
      }

      return Effect.gen(function*() {
        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open(options)
          const caller = yield* volume.caller()

          const { handler, session } = yield* openSession(caller, "namespace-live-before", {
            writable: true
          }).pipe(Effect.provideService(Vfs.Volume, volume))

          assert.strictEqual(
            yield* status(yield* handler.compound(yield* call([sequence(session, 1), root, createDirectory("docs")]))),
            Status.OK
          )
          assert.strictEqual(
            yield* status(
              yield* handler.compound(
                yield* call([sequence(session, 2), root, lookup("docs"), createSymlink("guide", "../target")])
              )
            ),
            Status.OK
          )
          assert.strictEqual(
            yield* status(
              yield* handler.compound(
                yield* call([sequence(session, 3), root, lookup("docs"), (writer) =>
                  Effect.gen(function*() {
                    const values = yield* make.openWriter(limits, 4)
                    yield* values.write(XdrCodec.uint32, 0o750)
                    yield* writer.write(XdrCodec.uint32, Operation.SETATTR)
                    yield* writer.write(XdrCodec.fixedOpaque(16), new Uint8Array(16))
                    yield* writer.write(XdrCodec.array(XdrCodec.uint32), [0, 1 << 1])
                    yield* writer.write(XdrCodec.opaque(), yield* values.finish)
                  })])
              )
            ),
            Status.OK
          )
        }))
        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open(options)
          const caller = yield* volume.caller()
          assert.strictEqual((yield* caller.stat("/docs")).mode, 0o750)
          assert.strictEqual(new TextDecoder().decode(yield* caller.readLink("/docs/guide")), "../target")
        }))
      }).pipe(Effect.provide(store))
    })
  })
})

describe("OpenRead", () => {
  const live = <E>(name: string, body: () => Effect.Effect<void, E, Crypto.Crypto | Scope.Scope>, timeout?: number) =>
    liveTest(name, () => body().pipe(Effect.provide(NodeCrypto.layer)), timeout)

  it.layer(NodeCrypto.layer)("NFSv4.1 OpenRead", (it) => {
    it.effect("should report read-only access and non-atomic name resolution for OPEN when OPEN names a path on a read-only export", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        yield* caller.writeFile("/other", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const handler = yield* makeHandler(caller)

        const client = yield* startSession(handler, "open-contract")

        const writeAccess = yield* call([
          sequence(client.session, 1),
          (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
          openByName(client.client, "file", 2)
        ])

        assert.strictEqual(
          yield* (yield* make.openReader(yield* handler.compound(writeAccess), limits)).read(XdrCodec.uint32),
          Status.ROFS
        )

        // Deny modes are share reservations, not an error on a read-only export; only undefined
        // values are rejected (RFC 8881 Section 18.16.3).
        const denyRead = yield* call([
          sequence(client.session, 2),
          (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
          openByName(client.client, "file", 1, 1)
        ])

        assert.strictEqual(
          yield* (yield* make.openReader(yield* handler.compound(denyRead), limits)).read(XdrCodec.uint32),
          Status.OK
        )

        const undefinedDeny = yield* call([
          sequence(client.session, 3),
          (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
          openByName(client.client, "file", 1, 4)
        ])

        assert.strictEqual(
          yield* (yield* make.openReader(yield* handler.compound(undefinedDeny), limits)).read(XdrCodec.uint32),
          Status.INVAL
        )

        const opened = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(client.session, 4),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openReadOnly(client.client, "other"),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        assert.isFalse(opened.atomic)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should require a first SEQUENCE and keep another client from using an open stateid when SEQUENCE is missing or an open stateid crosses clients", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1, 2]), {
          access: "write",
          create: "exclusive"
        })

        const handler = yield* makeHandler(caller)

        assert.strictEqual(
          (yield* statuses(
            yield* handler.compound(yield* call([(writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)]))
          )).status,
          Status.OP_NOT_IN_SESSION
        )

        // Section 18.46.3: the first operation is judged on its own; a SEQUENCE later in the
        // compound is only reached when the operations before it succeed.
        const misplaced = yield* call([
          (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
          sequence(new Uint8Array(16), 1)
        ])

        assert.deepStrictEqual((yield* statuses(yield* handler.compound(misplaced))).operations, [[
          Operation.PUTROOTFH,
          Status.OP_NOT_IN_SESSION
        ]])
        const a = yield* startSession(handler, "a")

        const opened = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(a.session, 1, true),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openReadOnly(a.client, "file"),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        const b = yield* startSession(handler, "b")

        const stolenRead = yield* call([sequence(b.session, 1), (writer) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
            yield* writer.write(XdrCodec.opaque(), opened.filehandle)
          }), (writer) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.READ)
            yield* writer.write(XdrCodec.fixedOpaque(opened.stateid.length), opened.stateid)
            yield* writer.write(XdrCodec.uint64, 0n)
            yield* writer.write(XdrCodec.uint32, 2)
          })])

        assert.strictEqual(
          yield* (yield* make.openReader(yield* handler.compound(stolenRead), limits)).read(XdrCodec.uint32),
          Status.BAD_STATEID
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should report EOF on an exact-boundary read and let the owning session close when READ reaches the exact file boundary before CLOSE", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1, 2]), {
          access: "write",
          create: "exclusive"
        })

        const handler = yield* makeHandler(caller)

        const client = yield* startSession(handler, "reader")

        const opened = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(client.session, 1, true),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openReadOnly(client.client, "file"),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        const read = yield* make.openReader(
          yield* handler.compound(
            yield* call([sequence(client.session, 2), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                yield* writer.write(XdrCodec.opaque(), opened.filehandle)
              }), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.READ)
                yield* writer.write(XdrCodec.fixedOpaque(opened.stateid.length), opened.stateid)
                yield* writer.write(XdrCodec.uint64, 0n)
                yield* writer.write(XdrCodec.uint32, 2)
              })])
          ),
          limits
        )

        assert.strictEqual(yield* read.read(XdrCodec.uint32), Status.OK)
        yield* read.read(XdrCodec.string())
        yield* read.read(XdrCodec.uint32)
        yield* read.read(XdrCodec.uint32)
        yield* read.read(XdrCodec.uint32)
        yield* read.read(XdrCodec.fixedOpaque(16))

        for (let field = 0; field < 5; field++) yield* read.read(XdrCodec.uint32)
        yield* read.read(XdrCodec.uint32)
        yield* read.read(XdrCodec.uint32)
        assert.strictEqual(yield* read.read(XdrCodec.uint32), Operation.READ)
        assert.strictEqual(yield* read.read(XdrCodec.uint32), Status.OK)
        assert.isTrue(yield* read.read(XdrCodec.boolean))
        assert.deepStrictEqual(yield* read.read(XdrCodec.opaque()), new Uint8Array([1, 2]))

        const close = yield* make.openReader(
          yield* handler.compound(
            yield* call([sequence(client.session, 3), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                yield* writer.write(XdrCodec.opaque(), opened.filehandle)
              }), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.CLOSE)
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.fixedOpaque(opened.stateid.length), opened.stateid)
              })])
          ),
          limits
        )

        assert.strictEqual(yield* close.read(XdrCodec.uint32), Status.OK)
        yield* close.read(XdrCodec.string())
        yield* close.read(XdrCodec.uint32)
        yield* close.read(XdrCodec.uint32)
        yield* close.read(XdrCodec.uint32)
        yield* close.read(XdrCodec.fixedOpaque(16))

        for (let field = 0; field < 5; field++) yield* close.read(XdrCodec.uint32)
        yield* close.read(XdrCodec.uint32)
        yield* close.read(XdrCodec.uint32)
        assert.strictEqual(yield* close.read(XdrCodec.uint32), Operation.CLOSE)
        assert.strictEqual(yield* close.read(XdrCodec.uint32), Status.OK)
        const closedStateid = yield* close.read(XdrCodec.fixedOpaque(16))
        assert.strictEqual(new DataView(closedStateid.buffer, closedStateid.byteOffset, 4).getUint32(0), 2)
        assert.deepStrictEqual(closedStateid.subarray(4), opened.stateid.subarray(4))
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should open the current filehandle with the macOS CLAIM_FH sequence when macOS sends OPEN with CLAIM_FH", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const export_ = yield* exportFor(caller)

        const root = yield* caller.root
        const reference = yield* caller.lookup(Vfs.Entry(root, new TextEncoder().encode("file")))
        const filehandle = yield* export_.handleFor(reference)

        const handler = yield* handlerFor(export_)

        const client = yield* startSession(handler, "claim-fh")

        const response = yield* handler.compound(
          yield* call([
            sequence(client.session, 1),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                yield* writer.write(XdrCodec.opaque(), filehandle)
              }),
            (writer) => writer.write(XdrCodec.uint32, Operation.SAVEFH),
            (writer) => writer.write(XdrCodec.uint32, Operation.RESTOREFH),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.OPEN)
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.uint32, 1)
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.uint64, client.client)
                yield* writer.write(XdrCodec.string(), "owner")
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.uint32, 4)
              })
          ])
        )

        assert.strictEqual(yield* (yield* make.openReader(response, limits)).read(XdrCodec.uint32), Status.OK)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should serve metadata, access, directory entries, and symbolic-link targets when GETATTR, ACCESS, READDIR, and READLINK query one export", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        yield* caller.symlink("file", "/link")

        const handler = yield* makeHandler(caller)

        const client = yield* startSession(handler, "browser")
        const root = yield* caller.root
        const directoryObservation = yield* caller.readDirectory(root)

        const browse = yield* call([
          sequence(client.session, 1),
          (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.GETATTR)
              yield* writer.write(XdrCodec.uint32, 1)
              yield* writer.write(XdrCodec.uint32, 1 << 0 | 1 << 1 | 1 << 2)
            }),
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.ACCESS)
              yield* writer.write(XdrCodec.uint32, 3)
            }),
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.READDIR)
              yield* writer.write(XdrCodec.uint64, 0n)
              yield* writer.write(XdrCodec.fixedOpaque(new Uint8Array(8).length), new Uint8Array(8))
              yield* writer.write(XdrCodec.uint32, 4_096)
              yield* writer.write(XdrCodec.uint32, 4_096)
              yield* writer.write(XdrCodec.uint32, 1)
              yield* writer.write(XdrCodec.uint32, 1 << 1)
            })
        ])

        const browseResponse = yield* make.openReader(yield* handler.compound(browse), limits)
        assert.strictEqual(yield* browseResponse.read(XdrCodec.uint32), Status.OK)
        yield* browseResponse.read(XdrCodec.string())
        assert.strictEqual(yield* browseResponse.read(XdrCodec.uint32), 5)
        assert.strictEqual(yield* browseResponse.read(XdrCodec.uint32), Operation.SEQUENCE)
        assert.strictEqual(yield* browseResponse.read(XdrCodec.uint32), Status.OK)
        yield* browseResponse.read(XdrCodec.fixedOpaque(16))

        for (let field = 0; field < 5; field++) {
          yield* browseResponse.read(XdrCodec.uint32)
        }

        assert.strictEqual(yield* browseResponse.read(XdrCodec.uint32), Operation.PUTROOTFH)
        assert.strictEqual(yield* browseResponse.read(XdrCodec.uint32), Status.OK)
        assert.strictEqual(yield* browseResponse.read(XdrCodec.uint32), Operation.GETATTR)
        assert.strictEqual(yield* browseResponse.read(XdrCodec.uint32), Status.OK)
        assert.deepStrictEqual(yield* browseResponse.read(XdrCodec.array(XdrCodec.uint32)), [7])
        const attributeValues = yield* make.openReader(yield* browseResponse.read(XdrCodec.opaque()), limits)
        // Every export reports its volume's maxfilesize (27); an unbounded volume adds no other capacity attribute.
        assert.deepStrictEqual(yield* attributeValues.read(XdrCodec.array(XdrCodec.uint32)), [
          3961196543,
          12099646,
          6144
        ])
        assert.strictEqual(yield* attributeValues.read(XdrCodec.uint32), 2)
        assert.strictEqual(yield* attributeValues.read(XdrCodec.uint32), 0x3)
        yield* attributeValues.finish
        assert.strictEqual(yield* browseResponse.read(XdrCodec.uint32), Operation.ACCESS)
        assert.strictEqual(yield* browseResponse.read(XdrCodec.uint32), Status.OK)
        assert.strictEqual(yield* browseResponse.read(XdrCodec.uint32), 3)
        assert.strictEqual(yield* browseResponse.read(XdrCodec.uint32), 3)
        assert.strictEqual(yield* browseResponse.read(XdrCodec.uint32), Operation.READDIR)
        assert.strictEqual(yield* browseResponse.read(XdrCodec.uint32), Status.OK)
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
        assert.deepStrictEqual(yield* browseResponse.read(XdrCodec.fixedOpaque(8)), expectedVerifier)

        const entries: Array<{
          readonly cookie: bigint
          readonly name: string
          readonly type: number
        }> = []

        while (yield* browseResponse.read(XdrCodec.boolean)) {
          const cookie = yield* browseResponse.read(XdrCodec.uint64)
          const name = yield* browseResponse.read(XdrCodec.string())
          assert.deepStrictEqual(yield* browseResponse.read(XdrCodec.array(XdrCodec.uint32)), [2])
          const values = yield* make.openReader(yield* browseResponse.read(XdrCodec.opaque()), limits)
          const type = yield* values.read(XdrCodec.uint32)
          yield* values.finish
          entries.push({
            cookie,
            name,
            type
          })
        }

        assert.deepStrictEqual(entries, [{
          cookie: 3n,
          name: "file",
          type: 1
        }, {
          cookie: 4n,
          name: "link",
          type: 5
        }])
        assert.isTrue(yield* browseResponse.read(XdrCodec.boolean))
        yield* browseResponse.finish

        const link = yield* make.openReader(
          yield* handler.compound(
            yield* call([
              sequence(client.session, 2),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                  yield* writer.write(XdrCodec.string(), "link")
                }),
              (writer) => writer.write(XdrCodec.uint32, Operation.READLINK)
            ])
          ),
          limits
        )

        assert.strictEqual(yield* link.read(XdrCodec.uint32), Status.OK)
        yield* link.read(XdrCodec.string())
        yield* link.read(XdrCodec.uint32)
        yield* link.read(XdrCodec.uint32)
        yield* link.read(XdrCodec.uint32)
        yield* link.read(XdrCodec.fixedOpaque(16))

        for (let field = 0; field < 5; field++) {
          yield* link.read(XdrCodec.uint32)
        }

        yield* link.read(XdrCodec.uint32)
        yield* link.read(XdrCodec.uint32)
        yield* link.read(XdrCodec.uint32)
        yield* link.read(XdrCodec.uint32)
        assert.strictEqual(yield* link.read(XdrCodec.uint32), Operation.READLINK)
        assert.strictEqual(yield* link.read(XdrCodec.uint32), Status.OK)
        assert.strictEqual(yield* link.read(XdrCodec.string()), "file")
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should bound READLINK results before advancing beyond the negotiated reply budget when READLINK would exceed the negotiated reply budget", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.symlink("12345678901234567", "/link")

        const constrained = {
          ...limits,
          maxStringBytes: ByteSize.bytes(16)
        }

        const { handler, session } = yield* openSession(caller, "link-bound", { limits: constrained })

        const response = yield* handler.compound(
          yield* call([
            sequence(session, 1),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                yield* writer.write(XdrCodec.string(), "link")
              }),
            (writer) => writer.write(XdrCodec.uint32, Operation.READLINK)
          ], "link")
        )

        assert.strictEqual(
          yield* (yield* make.openReader(response, constrained)).read(XdrCodec.uint32),
          Status.SERVERFAULT
        )
        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(yield* call([sequence(session, 2)], "next")),
            constrained
          )).read(XdrCodec.uint32),
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should list entries without encoding filehandles when no attributes are requested", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/a", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        yield* caller.writeFile("/b", new Uint8Array([2]), {
          access: "write",
          create: "exclusive"
        })

        const { handler, session } = yield* openSession(caller, "attribute-free-readdir")

        const response = yield* handler.compound(
          yield* call([
            sequence(session, 1),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.READDIR)
                yield* writer.write(XdrCodec.uint64, 0n)
                yield* writer.write(XdrCodec.fixedOpaque(new Uint8Array(8).length), new Uint8Array(8))
                yield* writer.write(XdrCodec.uint32, 4_096)
                yield* writer.write(XdrCodec.uint32, 4_096)
                yield* writer.write(XdrCodec.uint32, 0)
              })
          ])
        )

        assert.strictEqual(yield* (yield* make.openReader(response, limits)).read(XdrCodec.uint32), Status.OK)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should continue READDIR from its cookie and reject a stale verifier when READDIR resumes with a cookie or stale verifier", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxReaddirEntries: 1
        }

        const { handler, session } = yield* openSession(caller, "pagination", { limits: constrained })

        const readPage = (sequenceId: number, cookie: bigint, verifier: Uint8Array) =>
          Effect.gen(function*() {
            return yield* handler.compound(
              yield* call([
                sequence(session, sequenceId),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.READDIR)
                    yield* writer.write(XdrCodec.uint64, cookie)
                    yield* writer.write(XdrCodec.fixedOpaque(verifier.length), verifier)
                    yield* writer.write(XdrCodec.uint32, 4_096)
                    yield* writer.write(XdrCodec.uint32, 4_096)
                    yield* writer.write(XdrCodec.uint32, 1)
                    yield* writer.write(XdrCodec.uint32, 1 << 1)
                  })
              ])
            )
          })

        const parsePage = (response: Uint8Array) =>
          Effect.gen(function*() {
            const reader = yield* make.openReader(response, constrained)
            assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
            yield* reader.read(XdrCodec.string())
            yield* reader.read(XdrCodec.uint32)
            yield* reader.read(XdrCodec.uint32)
            yield* reader.read(XdrCodec.uint32)
            yield* reader.read(XdrCodec.fixedOpaque(16))

            for (let field = 0; field < 5; field++) yield* reader.read(XdrCodec.uint32)
            yield* reader.read(XdrCodec.uint32)
            yield* reader.read(XdrCodec.uint32)
            assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.READDIR)
            assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
            const pageVerifier = yield* reader.read(XdrCodec.fixedOpaque(8))
            assert.isTrue(yield* reader.read(XdrCodec.boolean))
            const nextCookie = yield* reader.read(XdrCodec.uint64)
            const name = yield* reader.read(XdrCodec.string())
            yield* reader.read(XdrCodec.array(XdrCodec.uint32))
            yield* reader.read(XdrCodec.opaque())
            assert.isFalse(yield* reader.read(XdrCodec.boolean))
            const eof = yield* reader.read(XdrCodec.boolean)
            yield* reader.finish

            return {
              pageVerifier,
              nextCookie,
              name,
              eof
            }
          })

        const first = yield* parsePage(yield* readPage(1, 0n, new Uint8Array(8)))
        assert.deepStrictEqual({
          name: first.name,
          eof: first.eof
        }, {
          name: "a",
          eof: false
        })
        const second = yield* parsePage(yield* readPage(2, first.nextCookie, first.pageVerifier))
        assert.deepStrictEqual({
          name: second.name,
          eof: second.eof
        }, {
          name: "b",
          eof: false
        })
        const third = yield* parsePage(yield* readPage(3, second.nextCookie, second.pageVerifier))
        assert.deepStrictEqual({
          name: third.name,
          eof: third.eof
        }, {
          name: "c",
          eof: true
        })
        assert.strictEqual(
          yield* (yield* make.openReader(yield* readPage(4, 1n, third.pageVerifier), constrained)).read(
            XdrCodec.uint32
          ),
          Status.BAD_COOKIE
        )
        yield* caller.writeFile("/d", new Uint8Array([4]), {
          access: "write",
          create: "exclusive"
        })
        const stale = yield* readPage(5, third.nextCookie, third.pageVerifier)
        assert.strictEqual(yield* (yield* make.openReader(stale, constrained)).read(XdrCodec.uint32), Status.NOT_SAME)
      }).pipe(Effect.provide(Testing.layer({
        fixture: {
          entries: ["a", "b", "c"].map((path, index) => ({
            kind: "file" as const,
            path: `/${path}`,
            bytes: new Uint8Array([index])
          }))
        }
      }))))
    it.effect("should page READDIR within the record ceiling when READDIR entries approach the RPC record ceiling", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxRecordBytes: ByteSize.bytes(2_048),
          maxReaddirEntries: 100
        }

        const { handler, session } = yield* openSession(caller, "record-page", {
          limits: constrained
        })

        const readPage = (sequenceId: number, cookie: bigint, verifier: Uint8Array) =>
          Effect.gen(function*() {
            return yield* handler.compound(
              yield* call([
                sequence(session, sequenceId),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.READDIR)
                    yield* writer.write(XdrCodec.uint64, cookie)
                    yield* writer.write(XdrCodec.fixedOpaque(verifier.length), verifier)
                    yield* writer.write(XdrCodec.uint32, 0)
                    yield* writer.write(XdrCodec.uint32, 4_096)
                    yield* writer.write(XdrCodec.uint32, 0)
                  })
              ])
            )
          })

        const parsePage = (response: Uint8Array) =>
          Effect.gen(function*() {
            assert.isAtMost(response.length + 24, 2_048)
            const reader = yield* make.openReader(response, constrained)
            assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
            yield* reader.read(XdrCodec.string())
            assert.strictEqual(yield* reader.read(XdrCodec.uint32), 3)
            assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.SEQUENCE)
            assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
            yield* reader.read(XdrCodec.fixedOpaque(16))

            for (let field = 0; field < 5; field++) yield* reader.read(XdrCodec.uint32)
            assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.PUTROOTFH)
            assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
            assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.READDIR)
            assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
            const verifier = yield* reader.read(XdrCodec.fixedOpaque(8))
            const names: Array<string> = []
            let cookie = 0n

            while (yield* reader.read(XdrCodec.boolean)) {
              cookie = yield* reader.read(XdrCodec.uint64)
              names.push(yield* reader.read(XdrCodec.string()))
              yield* reader.read(XdrCodec.array(XdrCodec.uint32))
              yield* reader.read(XdrCodec.opaque())
            }

            const eof = yield* reader.read(XdrCodec.boolean)
            yield* reader.finish

            return {
              verifier,
              cookie,
              names,
              eof
            }
          })

        const first = yield* parsePage(yield* readPage(1, 0n, new Uint8Array(8)))
        assert.isAbove(first.names.length, 0)
        assert.isBelow(first.names.length, 100)
        assert.isFalse(first.eof)
        const second = yield* parsePage(yield* readPage(2, first.cookie, first.verifier))
        assert.isAbove(second.names.length, 0)
        assert.strictEqual(second.names[0], `entry-${String(first.names.length).padStart(4, "0")}`)
      }).pipe(Effect.provide(Testing.layer({
        fixture: {
          entries: Array.from({
            length: 100
          }, (_, index) => ({
            kind: "file" as const,
            path: `/entry-${String(index).padStart(4, "0")}`,
            bytes: new Uint8Array([index])
          }))
        }
      }))))
    it.effect("should preserve client capacity when EXCHANGE_ID reply encoding fails", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxClients: 1,
          maxRecordBytes: ByteSize.bytes(64)
        }

        const handler = yield* makeHandler(caller, { limits: constrained })

        const first = yield* handler.compound(yield* call([exchangeId("first-owner")]))
        const second = yield* handler.compound(yield* call([exchangeId("second-owner")]))
        assert.strictEqual(
          yield* (yield* make.openReader(first, constrained)).read(XdrCodec.uint32),
          Status.REP_TOO_BIG
        )
        assert.strictEqual(
          yield* (yield* make.openReader(second, constrained)).read(XdrCodec.uint32),
          Status.REP_TOO_BIG
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should use maxcount alone when READDIR dircount is zero", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const { handler, session } = yield* openSession(caller, "zero-dircount")

        const response = yield* handler.compound(
          yield* call([sequence(session, 1), (writer) =>
            writer.write(XdrCodec.uint32, Operation.PUTROOTFH), (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.READDIR)
              yield* writer.write(XdrCodec.uint64, 0n)
              yield* writer.write(XdrCodec.fixedOpaque(new Uint8Array(8).length), new Uint8Array(8))
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.uint32, 4_096)
              yield* writer.write(XdrCodec.uint32, 1)
              yield* writer.write(XdrCodec.uint32, 1 << 1)
            })])
        )

        assert.strictEqual(yield* (yield* make.openReader(response, limits)).read(XdrCodec.uint32), Status.OK)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should reject OPEN without read access without consuming open capacity when OPEN omits read access", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const constrained = {
          ...limits,
          maxOpens: 1
        }

        const { handler, client, session } = yield* openSession(caller, "invalid-open-access", { limits: constrained })

        const invalid = yield* handler.compound(
          yield* call([
            sequence(session, 1),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.OPEN)
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.uint64, client)
                yield* writer.write(XdrCodec.string(), "owner")
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.string(), "file")
              })
          ])
        )

        assert.strictEqual(yield* (yield* make.openReader(invalid, constrained)).read(XdrCodec.uint32), Status.INVAL)
        yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(session, 2),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openReadOnly(client, "file"),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should coalesce repeated OPEN state and validate stateid sequences when one owner repeats OPEN and uses stateid sequences", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const constrained = {
          ...limits,
          maxOpens: 1
        }

        const { handler, client, session } = yield* openSession(caller, "repeated-open", { limits: constrained })

        const first = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openReadOnly(client, "file"),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        assert.strictEqual(new DataView(first.stateid.buffer, first.stateid.byteOffset, 4).getUint32(0), 1)

        const second = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(session, 2),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openReadOnly(client, "file"),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        assert.strictEqual(new DataView(second.stateid.buffer, second.stateid.byteOffset, 4).getUint32(0), 2)
        assert.deepStrictEqual(second.stateid.subarray(4), first.stateid.subarray(4))

        const readStatus = (requestSequence: number, stateid: Uint8Array) =>
          Effect.gen(function*() {
            return yield* handler.compound(
              yield* call([sequence(session, requestSequence), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                  yield* writer.write(XdrCodec.opaque(), second.filehandle)
                }), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.READ)
                  yield* writer.write(XdrCodec.fixedOpaque(stateid.length), stateid)
                  yield* writer.write(XdrCodec.uint64, 0n)
                  yield* writer.write(XdrCodec.uint32, 1)
                })])
            ).pipe(Effect.flatMap((response) =>
              Effect.gen(function*() {
                return yield* (yield* make.openReader(response, constrained)).read(XdrCodec.uint32)
              })
            ))
          })

        assert.strictEqual(yield* readStatus(3, stateidWithSequence(second.stateid, 0)), Status.OK)
        assert.strictEqual(yield* readStatus(4, first.stateid), Status.OLD_STATEID)
        assert.strictEqual(yield* readStatus(5, stateidWithSequence(second.stateid, 3)), Status.BAD_STATEID)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should check an open-owner's own deny mode on a repeated OPEN when an open owner repeats OPEN with its own deny mode", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const { handler, client, session } = yield* openSession(caller, "self-deny")

        const first = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openByName(client, "file", 1, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        assert.strictEqual(
          (yield* statuses(
            yield* handler.compound(
              yield* call([
                sequence(session, 2),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                openReadOnly(client, "file")
              ])
            )
          )).status,
          Status.SHARE_DENIED
        )
        assert.strictEqual(
          (yield* statuses(
            yield* handler.compound(
              yield* call([sequence(session, 3), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                  yield* writer.write(XdrCodec.opaque(), first.filehandle)
                }), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.OPEN_DOWNGRADE)
                  yield* writer.write(XdrCodec.fixedOpaque(first.stateid.length), first.stateid)
                  yield* writer.write(XdrCodec.uint32, 0)
                  yield* writer.write(XdrCodec.uint32, 1)
                  yield* writer.write(XdrCodec.uint32, 0)
                })])
            )
          )).status,
          Status.OK
        )
        assert.strictEqual(
          (yield* statuses(
            yield* handler.compound(
              yield* call([
                sequence(session, 4),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                openReadOnly(client, "file")
              ])
            )
          )).status,
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should coordinate write opens across clients and release a denial on downgrade when clients contend for write opens and later downgrade", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const handler = yield* makeHandler(caller, { writable: true })

        const a = yield* startSession(handler, "write-share-a")
        const b = yield* startSession(handler, "write-share-b")

        const held = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(a.session, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openByName(a.client, "file", 1, 2),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        const bWrite = (slotSequence: number) =>
          Effect.gen(function*() {
            return yield* handler.compound(
              yield* call([
                sequence(b.session, slotSequence),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                openByName(b.client, "file", 2)
              ])
            ).pipe(Effect.flatMap((reply) =>
              Effect.gen(function*() {
                return (yield* statuses(reply)).status
              })
            ))
          })

        assert.strictEqual(yield* bWrite(1), Status.SHARE_DENIED)
        assert.strictEqual(
          (yield* statuses(
            yield* handler.compound(
              yield* call([sequence(a.session, 2), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                  yield* writer.write(XdrCodec.opaque(), held.filehandle)
                }), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.OPEN_DOWNGRADE)
                  yield* writer.write(XdrCodec.fixedOpaque(held.stateid.length), held.stateid)
                  yield* writer.write(XdrCodec.uint32, 0)
                  yield* writer.write(XdrCodec.uint32, 1)
                  yield* writer.write(XdrCodec.uint32, 0)
                })])
            )
          )).status,
          Status.OK
        )
        assert.strictEqual(
          (yield* statuses(
            yield* handler.compound(
              yield* call([
                sequence(b.session, 2),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                openByName(b.client, "file", 2, 1)
              ])
            )
          )).status,
          Status.SHARE_DENIED
        )
        assert.strictEqual(yield* bWrite(3), Status.OK)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should reject reads through a write-only stateid when READ uses a write-only stateid", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const handler = yield* makeHandler(caller, { writable: true })

        const client = yield* startSession(handler, "write-only")

        const opened = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(client.session, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openByName(client.client, "file", 2),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        const reply = yield* handler.compound(
          yield* call([sequence(client.session, 2), (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
              yield* writer.write(XdrCodec.opaque(), opened.filehandle)
            }), (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.READ)
              yield* writer.write(XdrCodec.fixedOpaque(opened.stateid.length), opened.stateid)
              yield* writer.write(XdrCodec.uint64, 0n)
              yield* writer.write(XdrCodec.uint32, 1)
            })])
        )

        assert.strictEqual((yield* statuses(reply)).status, Status.OPENMODE)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should upgrade one open-owner from read to read-write and keep one open record when one owner upgrades a read OPEN to read-write", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const constrained = {
          ...limits,
          maxOpens: 1
        }

        const handler = yield* makeHandler(caller, { limits: constrained, writable: true })

        const client = yield* startSession(handler, "upgrade")

        const firstRequest = yield* call([
          sequence(client.session, 1, true),
          (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
          openByName(client.client, "file", 1),
          (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
        ])

        const firstReply = yield* handler.compound(firstRequest)
        const first = yield* parseOpen(firstReply)
        assert.deepStrictEqual(yield* handler.compound(firstRequest), firstReply)

        const upgraded = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(client.session, 2),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openByName(client.client, "file", 2),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        assert.deepStrictEqual(upgraded.stateid.subarray(4), first.stateid.subarray(4))
        assert.strictEqual(new DataView(upgraded.stateid.buffer, upgraded.stateid.byteOffset, 4).getUint32(0), 2)
        assert.strictEqual(
          (yield* statuses(
            yield* handler.compound(
              yield* call([sequence(client.session, 3), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                  yield* writer.write(XdrCodec.opaque(), upgraded.filehandle)
                }), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.READ)
                  yield* writer.write(XdrCodec.fixedOpaque(upgraded.stateid.length), upgraded.stateid)
                  yield* writer.write(XdrCodec.uint64, 0n)
                  yield* writer.write(XdrCodec.uint32, 1)
                })])
            )
          )).status,
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should keep earlier read access when upgrading after read permission is removed", () =>
      Effect.gen(function*() {
        const admin = yield* Vfs.Caller

        yield* admin.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive",
          mode: 0o600
        })
        yield* admin.chown("/file", {
          uid: 1000,
          gid: 1000
        })
        yield* admin.chmod("/", 0o111)

        const owner = yield* Testing.callerAs({
          uid: 1000,
          gid: 1000,
          groups: [],
          privileged: false
        })

        const handler = yield* makeHandler(admin, { writable: true, callerFor: () => Effect.succeed(owner) })

        const client = yield* startSession(handler, "permission-upgrade")

        const first = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(client.session, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openByName(client.client, "file", 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        yield* admin.chmod("/file", 0o200)

        const upgraded = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(client.session, 2),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openByName(client.client, "file", 2),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        assert.deepStrictEqual(upgraded.stateid.subarray(4), first.stateid.subarray(4))
        yield* admin.chmod("/file", 0o600)
        assert.strictEqual(
          (yield* statuses(
            yield* handler.compound(
              yield* call([sequence(client.session, 3), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                  yield* writer.write(XdrCodec.opaque(), upgraded.filehandle)
                }), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.READ)
                  yield* writer.write(XdrCodec.fixedOpaque(upgraded.stateid.length), upgraded.stateid)
                  yield* writer.write(XdrCodec.uint64, 0n)
                  yield* writer.write(XdrCodec.uint32, 1)
                })])
            )
          )).status,
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))
    live(
      "should interrupt a stalled write-open upgrade without closing the original handle when a write-open upgrade stalls before commit",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          yield* caller.writeFile("/file", new Uint8Array([1]), {
            access: "write",
            create: "exclusive"
          })

          const base = yield* exportFor(caller)

          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()

          const export_ = {
            ...base,
            open: (reference: Vfs.ObjectReference, access?: Vfs.OpenOptions["access"]) =>
              access === "write"
                ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(base.open(reference, access))
                )
                : base.open(reference, access)
          }

          const handler = yield* handlerFor(export_, { writable: true })

          const client = yield* startSession(handler, "interrupted-upgrade")

          const first = yield* parseOpen(
            yield* handler.compound(
              yield* call([
                sequence(client.session, 1),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                openByName(client.client, "file", 1),
                (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
              ])
            )
          )

          const upgrade = yield* Effect.forkChild(handler.compound(
            yield* call([
              sequence(client.session, 2),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openByName(client.client, "file", 2)
            ])
          ))

          yield* Deferred.await(entered)
          const interrupting = yield* Effect.forkChild(Fiber.interrupt(upgrade))
          const finished = yield* Fiber.join(interrupting).pipe(Effect.timeoutOption("2 seconds"))
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(interrupting)
          assert.isTrue(Option.isSome(finished), "the upgrade kept the server uninterruptible while opening storage")
          assert.strictEqual(
            (yield* statuses(
              yield* handler.compound(
                yield* call([sequence(client.session, 3), (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                    yield* writer.write(XdrCodec.opaque(), first.filehandle)
                  }), (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.READ)
                    yield* writer.write(XdrCodec.fixedOpaque(first.stateid.length), first.stateid)
                    yield* writer.write(XdrCodec.uint64, 0n)
                    yield* writer.write(XdrCodec.uint32, 1)
                  })])
              )
            )).status,
            Status.OK
          )
        }).pipe(Effect.provide(Testing.layer()))
    )
    it.effect("should support anonymous and current-stateid READ forms when READ uses anonymous or current-stateid forms", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const { handler, client, session } = yield* openSession(caller, "special-stateids")

        const anonymous = new Uint8Array(16)
        const current = stateidWithSequence(anonymous, 1)
        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(
              yield* call([
                sequence(session, 1),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                    yield* writer.write(XdrCodec.string(), "file")
                  }),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.READ)
                    yield* writer.write(XdrCodec.fixedOpaque(anonymous.length), anonymous)
                    yield* writer.write(XdrCodec.uint64, 0n)
                    yield* writer.write(XdrCodec.uint32, 1)
                  })
              ])
            ),
            limits
          )).read(XdrCodec.uint32),
          Status.OK
        )
        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(
              yield* call([
                sequence(session, 2),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                openReadOnly(client, "file"),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.READ)
                    yield* writer.write(XdrCodec.fixedOpaque(current.length), current)
                    yield* writer.write(XdrCodec.uint64, 0n)
                    yield* writer.write(XdrCodec.uint32, 1)
                  })
              ])
            ),
            limits
          )).read(XdrCodec.uint32),
          Status.OK
        )
        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(
              yield* call([
                sequence(session, 3),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                    yield* writer.write(XdrCodec.string(), "file")
                  }),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.READ)
                    yield* writer.write(XdrCodec.fixedOpaque(current.length), current)
                    yield* writer.write(XdrCodec.uint64, 0n)
                    yield* writer.write(XdrCodec.uint32, 1)
                  })
              ])
            ),
            limits
          )).read(XdrCodec.uint32),
          Status.BAD_STATEID
        )
        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(
              yield* call([
                sequence(session, 4),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                    yield* writer.write(XdrCodec.string(), "file")
                  }),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.READ)
                    yield* writer.write(XdrCodec.fixedOpaque(anonymous.length), anonymous)
                    yield* writer.write(XdrCodec.uint64, 0n)
                    yield* writer.write(XdrCodec.uint32, ByteSize.toNumberUnsafe(limits.maxReadBytes) + 1)
                  })
              ])
            ),
            limits
          )).read(XdrCodec.uint32),
          Status.OK
        )
        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(
              yield* call([
                sequence(session, 5),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                    yield* writer.write(XdrCodec.string(), "file")
                  }),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.READ)
                    yield* writer.write(
                      XdrCodec.fixedOpaque(new Uint8Array(16).fill(0xff).length),
                      new Uint8Array(16).fill(0xff)
                    )
                    yield* writer.write(XdrCodec.uint64, 0n)
                    yield* writer.write(XdrCodec.uint32, 1)
                  })
              ])
            ),
            limits
          )).read(XdrCodec.uint32),
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should enforce negotiated channel operation and cached-reply limits before advancing a slot when channel limits are exceeded before a slot advances", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxReplayBytes: ByteSize.bytes(580)
        }

        const handler = yield* makeHandler(caller, { limits: constrained })

        const operationsSession = yield* startSession(handler, "channel-operations", {
          maxOperations: 2
        })

        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(
              yield* call([
                sequence(operationsSession.session, 1),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
              ])
            ),
            constrained
          )).read(XdrCodec.uint32),
          Status.TOO_MANY_OPS
        )
        const cachedSession = yield* startSession(handler, "channel-cache")

        const oversized = yield* call([
          sequence(cachedSession.session, 1, true),
          (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)
        ], "x".repeat(520))

        assert.strictEqual(
          yield* (yield* make.openReader(yield* handler.compound(oversized), constrained)).read(XdrCodec.uint32),
          Status.REP_TOO_BIG_TO_CACHE
        )
        assert.strictEqual(
          yield* (yield* make.openReader(yield* handler.compound(oversized), constrained)).read(XdrCodec.uint32),
          Status.REP_TOO_BIG_TO_CACHE
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should read successive offsets and report EOF only at the file boundary when READ advances through successive offsets", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6])
        yield* caller.writeFile("/file", bytes, {
          access: "write",
          create: "exclusive"
        })

        const constrained = {
          ...limits,
          maxReadBytes: ByteSize.bytes(3)
        }

        const handler = yield* makeHandler(caller, { limits: constrained })

        const client = yield* startSession(handler, "offset-reader")

        const opened = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(client.session, 1, true),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openReadOnly(client.client, "file"),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        const read = (sequenceId: number, offset: bigint, count: number) =>
          Effect.gen(function*() {
            return yield* handler.compound(
              yield* call([sequence(client.session, sequenceId), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                  yield* writer.write(XdrCodec.opaque(), opened.filehandle)
                }), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.READ)
                  yield* writer.write(XdrCodec.fixedOpaque(opened.stateid.length), opened.stateid)
                  yield* writer.write(XdrCodec.uint64, offset)
                  yield* writer.write(XdrCodec.uint32, count)
                })])
            )
          })

        const parse = (response: Uint8Array) =>
          Effect.gen(function*() {
            const reader = yield* make.openReader(response, constrained)
            const result = yield* statuses(response)

            if (result.status !== Status.OK) {
              return {
                status: result.status
              } as const
            }

            yield* reader.read(XdrCodec.uint32)
            yield* reader.read(XdrCodec.string())
            yield* reader.read(XdrCodec.uint32)
            yield* reader.read(XdrCodec.uint32)
            yield* reader.read(XdrCodec.uint32)
            yield* reader.read(XdrCodec.fixedOpaque(16))

            for (let field = 0; field < 5; field++) yield* reader.read(XdrCodec.uint32)
            yield* reader.read(XdrCodec.uint32)
            yield* reader.read(XdrCodec.uint32)
            yield* reader.read(XdrCodec.uint32)
            yield* reader.read(XdrCodec.uint32)

            return {
              status: Status.OK,
              eof: yield* reader.read(XdrCodec.boolean),
              bytes: yield* reader.read(XdrCodec.opaque())
            } as const
          })

        assert.deepStrictEqual(yield* parse(yield* read(2, 0n, 3)), {
          status: Status.OK,
          eof: false,
          bytes: new Uint8Array([0, 1, 2])
        })
        assert.deepStrictEqual(yield* parse(yield* read(3, 3n, 3)), {
          status: Status.OK,
          eof: false,
          bytes: new Uint8Array([3, 4, 5])
        })
        assert.deepStrictEqual(yield* parse(yield* read(4, 6n, 3)), {
          status: Status.OK,
          eof: true,
          bytes: new Uint8Array([6])
        })
        assert.deepStrictEqual(yield* parse(yield* read(5, 20n, 3)), {
          status: Status.OK,
          eof: true,
          bytes: new Uint8Array()
        })
        assert.deepStrictEqual(yield* parse(yield* read(6, 0n, 4)), {
          status: Status.OK,
          eof: false,
          bytes: new Uint8Array([0, 1, 2])
        })
      }).pipe(Effect.provide(Testing.layer())))
  })
})

describe("ReadOnlyOperations", () => {
  it.layer(NodeCrypto.layer)("NFSv4.1 ReadOnlyOperations", (it) => {
    it.effect("should answer must-not-implement and optional operations with NOTSUPP when a must-not-implement or optional operation is sent", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        const handler = yield* makeHandler(caller)

        const setclientid = yield* run(
          handler,
          call([(writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.SETCLIENTID)
              yield* writer.write(XdrCodec.uint32, 1)
            })])
        )

        assert.strictEqual(setclientid.status, Status.NOTSUPP)
        assert.deepStrictEqual(setclientid.operations, [{ code: Operation.SETCLIENTID, status: Status.NOTSUPP }])

        const optionalFirst = yield* run(
          handler,
          call([(writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.OPENATTR)
              yield* writer.write(XdrCodec.boolean, false)
            })])
        )

        assert.strictEqual(optionalFirst.status, Status.OP_NOT_IN_SESSION)

        const { session } = yield* startSession(handler, "notsupp")

        for (
          const [index, code] of [
            Operation.RENEW,
            Operation.OPEN_CONFIRM,
            Operation.RELEASE_LOCKOWNER,
            Operation.OPENATTR,
            Operation.LAYOUTGET,
            Operation.DELEGRETURN
          ]
            .entries()
        ) {
          const reply = yield* run(
            handler,
            call([
              sequence(session, index + 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, code)
                  yield* writer.write(XdrCodec.uint32, 0xdead_beef)
                })
            ])
          )

          assert.strictEqual(reply.status, Status.NOTSUPP, `operation ${code}`)
          assert.strictEqual(reply.operations.length, 3)
          assert.strictEqual(reply.operations[1]!.status, Status.OK)
          assert.deepStrictEqual(reply.operations[2], { code, status: Status.NOTSUPP })
        }

        const unknown = yield* run(
          handler,
          call([sequence(session, 7), (writer) => writer.write(XdrCodec.uint32, 99_999)])
        )

        assert.deepStrictEqual(unknown.operations[1], { code: Operation.ILLEGAL, status: Status.OP_ILLEGAL })
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should complete COMMIT, PUTPUBFH, and SECINFO on a read-only export when COMMIT, PUTPUBFH, or SECINFO is sent", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1, 2, 3]), { access: "write", create: "exclusive" })
        const { handler, session } = yield* openSession(caller, "commit")

        const handles = yield* run(
          handler,
          call([
            sequence(session, 1),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

            (writer) => writer.write(XdrCodec.uint32, Operation.GETFH),

            (writer) => writer.write(XdrCodec.uint32, Operation.PUTPUBFH),

            (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
          ])
        )

        assert.strictEqual(handles.status, Status.OK)
        assert.deepStrictEqual(handles.operations[2]!.value, handles.operations[4]!.value)

        const commit = yield* run(
          handler,
          call([
            sequence(session, 2),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                yield* writer.write(XdrCodec.string(), "file")
              }),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.COMMIT)
                yield* writer.write(XdrCodec.uint64, 0n)
                yield* writer.write(XdrCodec.uint32, 0)
              })
          ])
        )

        assert.strictEqual(commit.status, Status.OK)

        const verifier = commit.operations[3]!.value

        if (!(verifier instanceof Uint8Array)) throw new Error("COMMIT did not return a verifier")
        assert.strictEqual(verifier.length, 8)

        const commitDirectory = yield* run(
          handler,
          call([
            sequence(session, 3),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.COMMIT)
                yield* writer.write(XdrCodec.uint64, 0n)
                yield* writer.write(XdrCodec.uint32, 0)
              })
          ])
        )

        assert.strictEqual(commitDirectory.status, Status.ISDIR)

        const secinfo = yield* run(
          handler,
          call([
            sequence(session, 4),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.SECINFO)
                yield* writer.write(XdrCodec.string(), "file")
              }),
            (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
          ])
        )

        assert.strictEqual(secinfo.status, Status.NOFILEHANDLE, "SECINFO consumes the current filehandle")
        assert.deepStrictEqual(secinfo.operations[2]!.value, [1, 0])

        const missing = yield* run(
          handler,
          call([
            sequence(session, 5),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.SECINFO)
                yield* writer.write(XdrCodec.string(), "missing")
              })
          ])
        )

        assert.strictEqual(missing.status, Status.NOENT)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should compare attributes with VERIFY and NVERIFY when VERIFY or NVERIFY compares attributes", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1, 2, 3]), { access: "write", create: "exclusive" })
        const { handler, session } = yield* openSession(caller, "verify")

        const probe = (
          sequenceId: number,
          code: number,
          attribute: number,
          value: (values: EncoderSession) => Effect.Effect<void, XdrEncodeError>
        ) =>
          run(
            handler,
            call([
              sequence(session, sequenceId),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                  yield* writer.write(XdrCodec.string(), "file")
                }),
              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, code)
                  yield* fattr(writer, attribute, value)
                }),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          ).pipe(Effect.map((reply) => reply.status))

        assert.strictEqual(
          yield* probe(1, Operation.VERIFY, 4, (values) => values.write(XdrCodec.uint64, 3n)),
          Status.OK
        )
        assert.strictEqual(
          yield* probe(2, Operation.NVERIFY, 4, (values) => values.write(XdrCodec.uint64, 3n)),
          Status.SAME
        )
        assert.strictEqual(
          yield* probe(3, Operation.VERIFY, 4, (values) => values.write(XdrCodec.uint64, 9n)),
          Status.NOT_SAME
        )
        assert.strictEqual(
          yield* probe(4, Operation.NVERIFY, 4, (values) => values.write(XdrCodec.uint64, 9n)),
          Status.OK
        )
        assert.strictEqual(
          yield* probe(5, Operation.VERIFY, 1, (values) => values.write(XdrCodec.uint32, 1)),
          Status.OK
        )
        assert.strictEqual(
          yield* probe(6, Operation.VERIFY, 12, (values) => values.write(XdrCodec.uint32, 0)),
          Status.ATTRNOTSUPP
        )
        assert.strictEqual(
          yield* probe(7, Operation.VERIFY, 11, (values) => values.write(XdrCodec.uint32, 0)),
          Status.INVAL
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should report ACCESS from mode bits against the RPC identity without granting writes when ACCESS is requested under an RPC identity", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
        yield* caller.chmod("/file", 0o640)
        yield* caller.chown("/file", { uid: 501, gid: 20 })
        yield* caller.writeFile("/tool", new Uint8Array([1]), { access: "write", create: "exclusive" })
        yield* caller.chmod("/tool", 0o750)
        yield* caller.chown("/tool", { uid: 501, gid: 20 })
        yield* caller.mkdir("/dir")
        yield* caller.chmod("/dir", 0o751)
        yield* caller.chown("/dir", { uid: 501, gid: 20 })
        const { handler, session } = yield* openSession(caller, "access")
        let sequenceId = 0

        const access = (credentials: CompoundCall["credentials"], name: string) =>
          run(
            handler,
            callAs(credentials, [
              sequence(session, ++sequenceId),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                  yield* writer.write(XdrCodec.string(), name)
                }),
              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.ACCESS)
                  yield* writer.write(XdrCodec.uint32, ACCESS_ALL)
                })
            ])
          ).pipe(Effect.map((reply) => reply.operations[3]!.value))

        const fileSupported = 0x01 | 0x04 | 0x08 | 0x20
        assert.deepStrictEqual(yield* access(sys(501, 501), "file"), { supported: fileSupported, access: 0x01 })
        assert.deepStrictEqual(yield* access(sys(999, 20), "file"), { supported: fileSupported, access: 0x01 })
        assert.deepStrictEqual(yield* access(sys(999, 999, [20]), "file"), { supported: fileSupported, access: 0x01 })
        assert.deepStrictEqual(yield* access(sys(999, 999), "file"), { supported: fileSupported, access: 0 })
        assert.deepStrictEqual(yield* access({ _tag: "None" }, "file"), { supported: fileSupported, access: 0 })
        assert.deepStrictEqual(yield* access(sys(0, 0), "file"), { supported: fileSupported, access: 0x01 })
        assert.deepStrictEqual(yield* access(sys(501, 501), "tool"), { supported: fileSupported, access: 0x21 })
        assert.deepStrictEqual(yield* access(sys(0, 0), "tool"), { supported: fileSupported, access: 0x21 })

        const directorySupported = 0x01 | 0x02 | 0x04 | 0x08 | 0x10
        assert.deepStrictEqual(yield* access({ _tag: "None" }, "dir"), { supported: directorySupported, access: 0x02 })
        assert.deepStrictEqual(yield* access(sys(501, 501), "dir"), { supported: directorySupported, access: 0x03 })
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should distinguish reserved names from invalid names when a reserved or invalid name is sent", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        const { handler, session } = yield* openSession(caller, "names")

        const lookup = (sequenceId: number, name: Uint8Array) =>
          run(
            handler,
            call([
              sequence(session, sequenceId),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                  yield* writer.write(XdrCodec.opaque(), name)
                })
            ])
          ).pipe(Effect.map((reply) => reply.status))

        assert.strictEqual(yield* lookup(1, new TextEncoder().encode(".")), Status.BADNAME)
        assert.strictEqual(yield* lookup(2, new TextEncoder().encode("..")), Status.BADNAME)
        assert.strictEqual(yield* lookup(3, new Uint8Array([0xff, 0xfe])), Status.INVAL)
        assert.strictEqual(yield* lookup(4, new TextEncoder().encode("missing")), Status.NOENT)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should scope RECLAIM_COMPLETE with rca_one_fs to the current filehandle when RECLAIM_COMPLETE uses rca_one_fs", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        const { handler, session } = yield* openSession(caller, "reclaim")

        const reclaim = (oneFs: boolean) => (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.RECLAIM_COMPLETE)
            yield* writer.write(XdrCodec.boolean, oneFs)
          })

        const oneFs = yield* run(
          handler,
          call([sequence(session, 1), (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH), reclaim(true)])
        )

        assert.strictEqual(oneFs.status, Status.OK)
        assert.strictEqual(
          (yield* run(handler, call([sequence(session, 2), reclaim(true)]))).status,
          Status.NOFILEHANDLE
        )
        assert.strictEqual((yield* run(handler, call([sequence(session, 3), reclaim(false)]))).status, Status.OK)
        assert.strictEqual(
          (yield* run(handler, call([sequence(session, 4), reclaim(false)]))).status,
          Status.COMPLETE_ALREADY
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should answer SECINFO_NO_NAME for the current object and its parent when SECINFO_NO_NAME targets the current object or parent", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.mkdir("/dir")
        const { handler, session } = yield* openSession(caller, "secinfo-no-name")

        const current = yield* run(
          handler,
          call([
            sequence(session, 1),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.SECINFO_NO_NAME)
                yield* writer.write(XdrCodec.uint32, 0)
              }),
            (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
          ])
        )

        assert.strictEqual(current.status, Status.NOFILEHANDLE)
        assert.deepStrictEqual(current.operations[2]!.value, [1, 0])

        const rootParent = yield* run(
          handler,
          call([
            sequence(session, 2),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.SECINFO_NO_NAME)
                yield* writer.write(XdrCodec.uint32, 1)
              })
          ])
        )

        assert.strictEqual(rootParent.status, Status.NOENT)

        const parent = yield* run(
          handler,
          call([
            sequence(session, 3),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                yield* writer.write(XdrCodec.string(), "dir")
              }),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.SECINFO_NO_NAME)
                yield* writer.write(XdrCodec.uint32, 1)
              })
          ])
        )

        assert.strictEqual(parent.status, Status.OK)

        const lookupp = yield* run(
          handler,
          call([
            sequence(session, 4),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

            (writer) => writer.write(XdrCodec.uint32, Operation.LOOKUPP)
          ])
        )

        assert.strictEqual(lookupp.status, Status.NOENT)

        const badStyle = yield* run(
          handler,
          call([
            sequence(session, 5),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.SECINFO_NO_NAME)
                yield* writer.write(XdrCodec.uint32, 7)
              })
          ])
        )

        assert.strictEqual(badStyle.status, Status.BADXDR)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should return INVAL when VERIFY requests a write-only time_access_set attribute", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
        const handler = yield* makeHandler(caller)
        const { session } = yield* startSession(handler, "precedence-verify")

        const verify = yield* run(
          handler,
          call([
            sequence(session, 1),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                yield* writer.write(XdrCodec.string(), "file")
              }),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.VERIFY)
                yield* fattr(writer, 48, (values) => values.write(XdrCodec.uint32, 0))
              })
          ])
        )

        assert.strictEqual(verify.status, Status.INVAL, "time_access_set is write-only, not unsupported")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should check filehandles, object kinds, and name before rejecting mutations as read-only when mutation operands are invalid on a read-only export", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
        yield* caller.symlink("file", "/link")
        const { handler, session } = yield* openSession(caller, "precedence")
        let sequenceId = 0

        const attempt = (
          ...operations: ReadonlyArray<(writer: EncoderSession) => Effect.Effect<void, XdrEncodeError>>
        ) =>
          run(handler, call([sequence(session, ++sequenceId), ...operations])).pipe(Effect.map((reply) => reply.status))

        const root = (writer: EncoderSession) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)

        const lookup = (name: string) => (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
            yield* writer.write(XdrCodec.string(), name)
          })

        const remove = (name: string) => (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.REMOVE)
            yield* writer.write(XdrCodec.string(), name)
          })

        const rename = (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.RENAME)
            yield* writer.write(XdrCodec.string(), "file")
            yield* writer.write(XdrCodec.string(), "moved")
          })

        const link = (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.LINK)
            yield* writer.write(XdrCodec.string(), "linked")
          })

        const savefh = (writer: EncoderSession) => writer.write(XdrCodec.uint32, Operation.SAVEFH)

        assert.strictEqual(yield* attempt(remove("file")), Status.NOFILEHANDLE)
        assert.strictEqual(yield* attempt(root, rename), Status.NOFILEHANDLE, "RENAME needs a saved filehandle")
        assert.strictEqual(yield* attempt(root, link), Status.NOFILEHANDLE, "LINK needs a saved object")
        assert.strictEqual(yield* attempt(root, lookup("file"), remove("x")), Status.NOTDIR)
        assert.strictEqual(yield* attempt(root, lookup("link"), remove("x")), Status.NOTDIR, "REMOVE lists no SYMLINK")
        assert.strictEqual(
          yield* attempt(root, lookup("file"), savefh, root, rename),
          Status.NOTDIR,
          "saved source dir"
        )
        assert.strictEqual(
          yield* attempt(root, lookup("link"), savefh, root, rename),
          Status.NOTDIR,
          "RENAME lists no SYMLINK"
        )
        assert.strictEqual(yield* attempt(root, savefh, lookup("link"), link), Status.SYMLINK, "LINK lists SYMLINK")
        assert.strictEqual(yield* attempt(root, remove("..")), Status.BADNAME)
        assert.strictEqual(yield* attempt(root, remove("")), Status.INVAL)
        assert.strictEqual(yield* attempt(root, remove("x".repeat(300))), Status.NAMETOOLONG)
        assert.strictEqual(yield* attempt(root, savefh, rename), Status.ROFS)
        assert.strictEqual(yield* attempt(root, lookup("file"), savefh, root, link), Status.ROFS)
        assert.strictEqual(yield* attempt(root, remove("file")), Status.ROFS)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should name the object type when OPEN, READ, COMMIT, and locks meet a non-regular object", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1, 2, 3, 4]), { access: "write", create: "exclusive" })
        yield* caller.mkdir("/dir")
        yield* caller.symlink("file", "/link")
        const { handler, client, session } = yield* openSession(caller, "object-types")
        let sequenceId = 0

        const attempt = (
          ...operations: ReadonlyArray<(writer: EncoderSession) => Effect.Effect<void, XdrEncodeError>>
        ) => run(handler, call([sequence(session, ++sequenceId), ...operations]))

        const status = (
          ...operations: ReadonlyArray<(writer: EncoderSession) => Effect.Effect<void, XdrEncodeError>>
        ) => attempt(...operations).pipe(Effect.map((reply) => reply.status))

        const root = (writer: EncoderSession) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)

        const lookup = (name: string) => (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
            yield* writer.write(XdrCodec.string(), name)
          })

        const anonymous = new Uint8Array(16)

        const read = (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.READ)
            yield* writer.write(XdrCodec.fixedOpaque(anonymous.length), anonymous)
            yield* writer.write(XdrCodec.uint64, 0n)
            yield* writer.write(XdrCodec.uint32, 4)
          })

        const commit = (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.COMMIT)
            yield* writer.write(XdrCodec.uint64, 0n)
            yield* writer.write(XdrCodec.uint32, 0)
          })

        const lock = (lockType: number) => (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.LOCK)
            yield* writer.write(XdrCodec.uint32, lockType)
            yield* writer.write(XdrCodec.boolean, false)
            yield* writer.write(XdrCodec.uint64, 0n)
            yield* writer.write(XdrCodec.uint64, 1n)
            yield* writer.write(XdrCodec.boolean, true)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(
              XdrCodec.fixedOpaque(
                anonymous.length
              ),
              anonymous
            )
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.uint64, client)
            yield* writer.write(XdrCodec.string(), "lock-owner")
          })

        const lockt = (lockType: number) => (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.LOCKT)
            yield* writer.write(XdrCodec.uint32, lockType)
            yield* writer.write(XdrCodec.uint64, 0n)
            yield* writer.write(XdrCodec.uint64, 1n)
            yield* writer.write(XdrCodec.uint64, client)
            yield* writer.write(XdrCodec.string(), "lock-owner")
          })

        const locku = (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.LOCKU)
            yield* writer.write(XdrCodec.uint32, 1)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.fixedOpaque(anonymous.length), anonymous)
            yield* writer.write(XdrCodec.uint64, 0n)
            yield* writer.write(XdrCodec.uint64, 1n)
          })

        // Sections 18.16.4 and 18.22.3 name the type; COMMIT lists SYMLINK and WRONG_TYPE, not INVAL.
        assert.strictEqual(yield* status(root, openReadOnly(client, "link")), Status.SYMLINK)
        assert.strictEqual(yield* status(root, openReadOnly(client, "dir")), Status.ISDIR)
        assert.strictEqual(yield* status(root, lookup("link"), read), Status.SYMLINK)
        assert.strictEqual(yield* status(root, read), Status.ISDIR)
        assert.strictEqual(yield* status(root, lookup("link"), commit), Status.SYMLINK)

        // Locks check the filehandle and object type before the read-only answer.
        assert.strictEqual(yield* status(lock(1)), Status.NOFILEHANDLE)
        assert.strictEqual(yield* status(root, lock(1)), Status.ISDIR)
        assert.strictEqual(yield* status(root, lookup("link"), lockt(1)), Status.SYMLINK)
        assert.strictEqual(yield* status(root, lookup("file"), lock(2)), Status.ROFS, "WRITE_LT")
        assert.strictEqual(yield* status(root, lookup("file"), lock(1)), Status.BAD_STATEID, "READ_LT needs open state")
        assert.strictEqual(
          yield* status(root, lookup("file"), lockt(1)),
          Status.OK,
          "no lock conflicts with a read test"
        )
        assert.strictEqual(yield* status(root, lookup("file"), lockt(4)), Status.ROFS, "WRITEW_LT")
        assert.strictEqual(yield* status(root, lookup("file"), locku), Status.BAD_STATEID)
        assert.strictEqual(yield* status(locku), Status.NOFILEHANDLE)

        const badLockType = yield* attempt(root, lookup("file"), lock(5))
        assert.strictEqual(badLockType.status, Status.BADXDR)
        assert.deepStrictEqual(badLockType.operations[3], { code: Operation.LOCK, status: Status.BADXDR })

        const badUnlockType = yield* attempt(
          root,
          lookup("file"),
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.LOCKU)
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.fixedOpaque(anonymous.length), anonymous)
              yield* writer.write(XdrCodec.uint64, 0n)
              yield* writer.write(XdrCodec.uint64, 1n)
            })
        )

        assert.deepStrictEqual(badUnlockType.operations[3], { code: Operation.LOCKU, status: Status.BADXDR })
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should keep anonymous READ, LOOKUP, READLINK, LOCKU, and OPEN4_CREATE inside their error lists when anonymous operations produce RFC-listed errors", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1, 2]), { access: "write", create: "exclusive" })
        yield* caller.mkdir("/dir")
        yield* caller.symlink("file", "/link")
        const { handler, client, session } = yield* openSession(caller, "error-lists")
        let sequenceId = 0

        const attempt = (
          ...operations: ReadonlyArray<(writer: EncoderSession) => Effect.Effect<void, XdrEncodeError>>
        ) => run(handler, call([sequence(session, ++sequenceId), ...operations]))

        const status = (
          ...operations: ReadonlyArray<(writer: EncoderSession) => Effect.Effect<void, XdrEncodeError>>
        ) => attempt(...operations).pipe(Effect.map((reply) => reply.status))

        const root = (writer: EncoderSession) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)

        const lookup = (name: string) => (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
            yield* writer.write(XdrCodec.string(), name)
          })

        const readlink = (writer: EncoderSession) => writer.write(XdrCodec.uint32, Operation.READLINK)

        const anonymous = new Uint8Array(16)
        const bypass = new Uint8Array(16).fill(0xff)

        const read = (stateid: Uint8Array) => (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.READ)
            yield* writer.write(XdrCodec.fixedOpaque(stateid.length), stateid)
            yield* writer.write(XdrCodec.uint64, 0n)
            yield* writer.write(XdrCodec.uint32, 2)
          })

        const openAs = (owner: string, deny: number) => (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.OPEN)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.uint32, 1)
            yield* writer.write(XdrCodec.uint32, deny)
            yield* writer.write(XdrCodec.uint64, client)
            yield* writer.write(XdrCodec.string(), owner)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.string(), "file")
          })

        const create = (name: string, claim = 0, access = 1) => (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.OPEN)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.uint32, access)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.uint64, client)
            yield* writer.write(XdrCodec.string(), "creator")
            yield* writer.write(XdrCodec.uint32, 1)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.array(XdrCodec.uint32), [])
            yield* writer.write(XdrCodec.opaque(), new Uint8Array())
            yield* writer.write(XdrCodec.uint32, claim)

            if (claim === 0) yield* writer.write(XdrCodec.string(), name)
          })

        // Section 9.1.2: the anonymous stateid respects a deny-read reservation; all ones bypasses it.
        assert.strictEqual(yield* status(root, lookup("file"), read(anonymous)), Status.OK)
        const holder = yield* attempt(root, openAs("holder", 1))
        assert.strictEqual(holder.status, Status.OK)
        assert.strictEqual(yield* status(root, lookup("file"), read(anonymous)), Status.LOCKED)
        assert.strictEqual(yield* status(root, lookup("file"), read(bypass)), Status.OK)
        // SAFETY: OPEN succeeded, so its body is the OPEN result shape.
        const holderStateid = (holder.operations[2]!.value as { readonly stateid: Uint8Array }).stateid

        const close = (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.CLOSE)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.fixedOpaque(holderStateid.length), holderStateid)
          })

        assert.strictEqual(yield* status(root, lookup("file"), close), Status.OK)
        assert.strictEqual(yield* status(root, lookup("file"), read(anonymous)), Status.OK, "reservation released")

        // A plain OPEN through a symbolic-link current filehandle is SYMLINK, like LOOKUP.
        assert.strictEqual(yield* status(root, lookup("link"), openAs("x", 0)), Status.SYMLINK)

        // Sections 15.1.2.8 and 18.24.4.
        assert.strictEqual(yield* status(root, lookup("link"), lookup("x")), Status.SYMLINK)
        assert.strictEqual(yield* status(root, lookup("file"), lookup("x")), Status.NOTDIR)
        assert.strictEqual(yield* status(root, lookup("file"), readlink), Status.WRONG_TYPE)
        assert.strictEqual(yield* status(root, readlink), Status.WRONG_TYPE)
        assert.strictEqual(yield* status(root, lookup("link"), readlink), Status.OK)

        // LOCKU lists no object-type errors, so a directory is still BAD_STATEID.
        const locku = (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.LOCKU)
            yield* writer.write(XdrCodec.uint32, 1)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.fixedOpaque(anonymous.length), anonymous)
            yield* writer.write(XdrCodec.uint64, 0n)
            yield* writer.write(XdrCodec.uint64, 1n)
          })

        assert.strictEqual(yield* status(root, locku), Status.BAD_STATEID)

        // OPEN4_CREATE keeps structural precedence over ROFS and needs CLAIM_NULL.
        assert.strictEqual(yield* status(create("new")), Status.NOFILEHANDLE)
        assert.strictEqual(yield* status(root, lookup("link"), create("new")), Status.SYMLINK)
        assert.strictEqual(yield* status(root, lookup("file"), create("new")), Status.NOTDIR)
        assert.strictEqual(yield* status(root, create("a/b")), Status.BADCHAR)
        assert.strictEqual(yield* status(root, create("..")), Status.BADNAME)
        assert.strictEqual(yield* status(root, create("new", 4)), Status.INVAL, "CLAIM_FH cannot create")
        assert.strictEqual(yield* status(root, create("new")), Status.ROFS)
        assert.strictEqual(yield* status(root, lookup("link"), create("new", 0, 3)), Status.SYMLINK, "write access too")
        assert.strictEqual(yield* status(root, create("..", 0, 2)), Status.BADNAME)
        assert.strictEqual(yield* status(root, create("new", 0, 2)), Status.ROFS)
        assert.strictEqual(yield* status(root, openAs("w", 0)), Status.OK)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should reject state protection it cannot honor and name forbidden bytes as BADCHAR when state protection or forbidden name bytes are requested", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
        const handler = yield* makeHandler(caller)

        const exchange = (protection: (writer: EncoderSession) => Effect.Effect<void, XdrEncodeError>) =>
          run(
            handler,
            call([(writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.EXCHANGE_ID)
                yield* writer.write(XdrCodec.fixedOpaque(new Uint8Array(8).length), new Uint8Array(8))
                yield* writer.write(XdrCodec.string(), "protected")
                yield* writer.write(XdrCodec.uint32, 0)
                yield* protection(writer)
                yield* writer.write(XdrCodec.array(XdrCodec.uint32), [])
              })])
          )

        const ops = (writer: EncoderSession, how: number) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, how)
            yield* writer.write(XdrCodec.array(XdrCodec.uint32), [])
            yield* writer.write(XdrCodec.array(XdrCodec.uint32), [])
          })

        // Section 18.35.3: SP4_MACH_CRED needs RPCSEC_GSS integrity, which AUTH_SYS cannot give.
        const machCred = yield* exchange((writer) => ops(writer, 1))
        assert.deepStrictEqual(machCred.operations, [{ code: Operation.EXCHANGE_ID, status: Status.INVAL }])

        const machCredWithOps = yield* exchange((writer) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, 1)
            yield* writer.write(XdrCodec.array(XdrCodec.uint32), [0x0800_0000, 0x0000_0002])
            yield* writer.write(XdrCodec.array(XdrCodec.uint32), [0x0000_0400])
          })
        )

        assert.deepStrictEqual(machCredWithOps.operations, [{ code: Operation.EXCHANGE_ID, status: Status.INVAL }])

        // SP4_SSV decodes fully and fails on the algorithm list rather than on the XDR.
        const ssv = yield* exchange((writer) =>
          Effect.gen(function*() {
            yield* ops(writer, 2)
            yield* writer.write(XdrCodec.array(XdrCodec.opaque()), [new Uint8Array([1, 2])])
            yield* writer.write(XdrCodec.array(XdrCodec.opaque()), [new Uint8Array([3])])
            yield* writer.write(XdrCodec.uint32, 8)
            yield* writer.write(XdrCodec.uint32, 1)
          })
        )

        assert.deepStrictEqual(ssv.operations, [{ code: Operation.EXCHANGE_ID, status: Status.ENCR_ALG_UNSUPP }])

        const undefinedHow = yield* exchange((writer) => writer.write(XdrCodec.uint32, 3))

        assert.deepStrictEqual(undefinedHow.operations, [{ code: Operation.EXCHANGE_ID, status: Status.BADXDR }])

        // Section 14.5: valid UTF-8 the file system cannot store is BADCHAR; invalid UTF-8 is INVAL.
        const { session } = yield* startSession(handler, "badchar")

        const lookup = (sequenceId: number, name: Uint8Array) =>
          run(
            handler,
            call([
              sequence(session, sequenceId),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                  yield* writer.write(XdrCodec.opaque(), name)
                })
            ])
          ).pipe(Effect.map((reply) => reply.status))

        assert.strictEqual(yield* lookup(1, new TextEncoder().encode("a/b")), Status.BADCHAR)
        assert.strictEqual(yield* lookup(2, new Uint8Array([0x61, 0x00])), Status.BADCHAR)
        assert.strictEqual(yield* lookup(3, new Uint8Array([0xff, 0x61])), Status.INVAL)
        assert.strictEqual(yield* lookup(4, new TextEncoder().encode("file")), Status.OK)
      }).pipe(Effect.provide(Testing.layer())))
  })
})

describe("ReadOnlyState", () => {
  it.layer(NodeCrypto.layer)("NFSv4.1 ReadOnlyState", (it) => {
    it.effect("should manage open stateids with OPEN_DOWNGRADE, TEST_STATEID, and FREE_STATEID when OPEN_DOWNGRADE, TEST_STATEID, or FREE_STATEID is sent", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
        const { handler, client, session } = yield* openSession(caller, "stateids")

        const opened = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(session, 1, true),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

              openReadOnly(client, "file"),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        const downgrade = yield* run(
          handler,
          call([
            sequence(session, 2),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                yield* writer.write(XdrCodec.opaque(), opened.filehandle)
              }),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.OPEN_DOWNGRADE)
                yield* writer.write(XdrCodec.fixedOpaque(opened.stateid.length), opened.stateid)
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.uint32, 1)
                yield* writer.write(XdrCodec.uint32, 0)
              })
          ])
        )

        assert.strictEqual(downgrade.status, Status.OK)
        // SAFETY: OPEN_DOWNGRADE succeeded, so its decoded body is the returned 16-byte stateid.
        const downgraded = downgrade.operations[2]!.value as Uint8Array
        assert.strictEqual(new DataView(downgraded.buffer).getUint32(0), 2)
        assert.deepStrictEqual(downgraded.subarray(4), opened.stateid.subarray(4))

        const widen = yield* run(
          handler,
          call([
            sequence(session, 3),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                yield* writer.write(XdrCodec.opaque(), opened.filehandle)
              }),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.OPEN_DOWNGRADE)
                yield* writer.write(XdrCodec.fixedOpaque(downgraded.length), downgraded)
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.uint32, 2)
                yield* writer.write(XdrCodec.uint32, 0)
              })
          ])
        )

        assert.strictEqual(widen.status, Status.INVAL)

        const unknownStateid = new Uint8Array(16).fill(0x42)

        const tested = yield* run(
          handler,
          call([
            sequence(session, 4),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.TEST_STATEID)
                yield* writer.write(
                  XdrCodec.array(XdrCodec.fixedOpaque(16)),
                  [downgraded, opened.stateid, unknownStateid, new Uint8Array(16)]
                )
              })
          ])
        )

        assert.strictEqual(tested.status, Status.OK)
        assert.deepStrictEqual(tested.operations[1]!.value, [
          Status.OK,
          Status.OLD_STATEID,
          Status.BAD_STATEID,
          Status.BAD_STATEID
        ])

        const held = yield* run(
          handler,
          call([sequence(session, 5), (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.FREE_STATEID)
              yield* writer.write(XdrCodec.fixedOpaque(downgraded.length), downgraded)
            })])
        )

        assert.strictEqual(held.status, Status.LOCKS_HELD)

        const freeUnknown = yield* run(
          handler,
          call([sequence(session, 6), (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.FREE_STATEID)
              yield* writer.write(XdrCodec.fixedOpaque(unknownStateid.length), unknownStateid)
            })])
        )

        assert.strictEqual(freeUnknown.status, Status.BAD_STATEID)

        const badDowngrade = yield* run(
          handler,
          call([
            sequence(session, 7),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                yield* writer.write(XdrCodec.opaque(), opened.filehandle)
              }),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.OPEN_DOWNGRADE)
                yield* writer.write(XdrCodec.fixedOpaque(unknownStateid.length), unknownStateid)
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.uint32, 1)
                yield* writer.write(XdrCodec.uint32, 0)
              })
          ])
        )

        assert.strictEqual(badDowngrade.status, Status.BAD_STATEID)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should validate lock stateids and reject write-lock tests on a read-only export when a lock stateid or write-lock test reaches a read-only export", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
        const { handler, client, session } = yield* openSession(caller, "locks")

        const onFile = (
          sequenceId: number,
          operation: (writer: EncoderSession) => Effect.Effect<void, XdrEncodeError>
        ) =>
          run(
            handler,
            call([
              sequence(session, sequenceId),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                  yield* writer.write(XdrCodec.string(), "file")
                }),
              operation
            ])
          ).pipe(Effect.map((reply) => reply.status))

        const lock = (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.LOCK)
            yield* writer.write(XdrCodec.uint32, 1)
            yield* writer.write(XdrCodec.boolean, false)
            yield* writer.write(XdrCodec.uint64, 0n)
            yield* writer.write(XdrCodec.uint64, 0xffff_ffff_ffff_ffffn)
            yield* writer.write(XdrCodec.boolean, true)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.fixedOpaque(new Uint8Array(16).length), new Uint8Array(16))
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.uint64, client)
            yield* writer.write(XdrCodec.string(), "lock-owner")
          })

        assert.strictEqual(yield* onFile(1, lock), Status.BAD_STATEID)

        // A write-lock test reports the read-only file system; a read-lock test finds no conflict.
        const lockt = (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.LOCKT)
            yield* writer.write(XdrCodec.uint32, 2)
            yield* writer.write(XdrCodec.uint64, 0n)
            yield* writer.write(XdrCodec.uint64, 1n)
            yield* writer.write(XdrCodec.uint64, client)
            yield* writer.write(XdrCodec.string(), "lock-owner")
          })

        assert.strictEqual(yield* onFile(2, lockt), Status.ROFS)

        const locku = (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.LOCKU)
            yield* writer.write(XdrCodec.uint32, 1)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.fixedOpaque(new Uint8Array(16).fill(9).length), new Uint8Array(16).fill(9))
            yield* writer.write(XdrCodec.uint64, 0n)
            yield* writer.write(XdrCodec.uint64, 1n)
          })

        assert.strictEqual(yield* onFile(3, locku), Status.BAD_STATEID)

        const setSsv = (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.SET_SSV)
            yield* writer.write(XdrCodec.opaque(), new Uint8Array(4))
            yield* writer.write(XdrCodec.opaque(), new Uint8Array(4))
          })

        assert.strictEqual(yield* onFile(4, setSsv), Status.INVAL)

        const truncatedLock = (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.LOCK)
            yield* writer.write(XdrCodec.uint32, 1)
            yield* writer.write(XdrCodec.boolean, false)
          })

        assert.strictEqual(yield* onFile(5, truncatedLock), Status.BADXDR)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should answer delegation wants in OPEN share_access with OPEN_DELEGATE_NONE_EXT when OPEN requests a delegation", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1, 2, 3]), { access: "write", create: "exclusive" })
        const { handler, session } = yield* openSession(caller, "wants")
        let sequenceId = 0

        // The macOS 26 client opens with CLAIM_FH and OPEN4_SHARE_ACCESS_WANT_READ_DELEG (0x0100).
        const open = (shareAccess: number) =>
          run(
            handler,
            callAs(sys(501, 20), [
              sequence(session, ++sequenceId),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                  yield* writer.write(XdrCodec.string(), "file")
                }),
              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.OPEN)
                  yield* writer.write(XdrCodec.uint32, 1)
                  yield* writer.write(XdrCodec.uint32, shareAccess)
                  yield* writer.write(XdrCodec.uint32, 0)
                  yield* writer.write(XdrCodec.uint64, 1n)
                  yield* writer.write(XdrCodec.string(), "mac")
                  yield* writer.write(XdrCodec.uint32, 0)
                  yield* writer.write(XdrCodec.uint32, 4)
                }),
              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.READ)
                  yield* writer.write(
                    XdrCodec.fixedOpaque(new Uint8Array([0, 0, 0, 1, ...new Uint8Array(12)]).length),
                    new Uint8Array([0, 0, 0, 1, ...new Uint8Array(12)])
                  )
                  yield* writer.write(XdrCodec.uint64, 0n)
                  yield* writer.write(XdrCodec.uint32, 16)
                })
            ])
          )

        const expectOpen = (reply: DecodedReply, delegation: number, why: number) => {
          assert.strictEqual(reply.status, Status.OK)
          // SAFETY: OPEN succeeded, so the body reader table produced the OPEN result shape.
          const result = reply.operations[3]!.value as { readonly delegation: number; readonly why: number }
          assert.deepStrictEqual({ delegation: result.delegation, why: result.why }, { delegation, why })
          // SAFETY: READ succeeded, so the body reader table produced the READ result shape.
          const read = reply.operations[4]!.value as { readonly data: Uint8Array }
          assert.deepStrictEqual(read.data, new Uint8Array([1, 2, 3]))
        }

        expectOpen(yield* open(0x0101), 3, 3)
        expectOpen(yield* open(0x0301), 3, 3)
        expectOpen(yield* open(0x0401), 3, 0)
        expectOpen(yield* open(0x0501), 3, 7)
        expectOpen(yield* open(0x0001_0101), 3, 3)
        expectOpen(yield* open(0x0001), 0, -1)
        assert.strictEqual((yield* open(0x0601)).status, Status.INVAL)
        assert.strictEqual((yield* open(0x0100)).status, Status.INVAL)
        assert.strictEqual((yield* open(0x0102)).status, Status.ROFS)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should substitute the current stateid in OPEN_DOWNGRADE and CLOSE within one compound when OPEN_DOWNGRADE and CLOSE use the current stateid", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
        const { handler, client, session } = yield* openSession(caller, "current-stateid")
        const current = new Uint8Array([0, 0, 0, 1, ...new Uint8Array(12)])

        const reply = yield* run(
          handler,
          call([
            sequence(session, 1),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

            openReadOnly(client, "file"),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.OPEN_DOWNGRADE)
                yield* writer.write(XdrCodec.fixedOpaque(current.length), current)
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.uint32, 1)
                yield* writer.write(XdrCodec.uint32, 0)
              }),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.READ)
                yield* writer.write(XdrCodec.fixedOpaque(current.length), current)
                yield* writer.write(XdrCodec.uint64, 0n)
                yield* writer.write(XdrCodec.uint32, 4)
              }),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.CLOSE)
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.fixedOpaque(current.length), current)
              })
          ])
        )

        assert.strictEqual(reply.status, Status.OK)
        // SAFETY: OPEN succeeded, so the body reader table produced the OPEN result shape.
        const opened = reply.operations[2]!.value as { readonly stateid: Uint8Array }
        // SAFETY: OPEN_DOWNGRADE succeeded, so its body is the returned stateid.
        const downgraded = reply.operations[3]!.value as Uint8Array
        assert.strictEqual(new DataView(opened.stateid.buffer).getUint32(0), 1)
        assert.strictEqual(new DataView(downgraded.buffer).getUint32(0), 2)
        assert.deepStrictEqual(downgraded.subarray(4), opened.stateid.subarray(4))
        assert.strictEqual(reply.operations[5]!.status, Status.OK)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should answer reclaim claims, share reservations, and masked downgrades per Sections 18.16 and 18.18 when reclaim claims, reservations, or downgrades reach OPEN", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
        const { handler, client, session } = yield* openSession(caller, "share-reservations")
        let sequenceId = 0

        const attempt = (
          ...operations: ReadonlyArray<(writer: EncoderSession) => Effect.Effect<void, XdrEncodeError>>
        ) => run(handler, call([sequence(session, ++sequenceId), ...operations]))

        const root = (writer: EncoderSession) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)

        const lookup = (name: string) => (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
            yield* writer.write(XdrCodec.string(), name)
          })

        const openAs = (owner: string, deny: number, claim = 0) => (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.OPEN)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.uint32, 1)
            yield* writer.write(XdrCodec.uint32, deny)
            yield* writer.write(XdrCodec.uint64, client)
            yield* writer.write(XdrCodec.string(), owner)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.uint32, claim)

            if (claim === 0) yield* writer.write(XdrCodec.string(), "file")
            else if (claim === 1) yield* writer.write(XdrCodec.uint32, 0)
            else if (claim === 3) yield* writer.write(XdrCodec.string(), "")
            else if (claim === 2) {
              yield* writer.write(XdrCodec.fixedOpaque(new Uint8Array(16).length), new Uint8Array(16))
              yield* writer.write(XdrCodec.string(), "file")
            } else if (claim === 5) {
              yield* writer.write(XdrCodec.fixedOpaque(new Uint8Array(16).length), new Uint8Array(16))
            }
          })

        const stateidOf = (reply: DecodedReply, index: number) =>
          // SAFETY: the caller asserted that OPEN at this index succeeded, so its body is the OPEN result shape.
          (reply.operations[index]!.value as { readonly stateid: Uint8Array }).stateid

        const close = (stateid: Uint8Array) => (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.CLOSE)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.fixedOpaque(stateid.length), stateid)
          })

        const downgrade = (stateid: Uint8Array, access: number, deny: number) => (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.OPEN_DOWNGRADE)
            yield* writer.write(XdrCodec.fixedOpaque(stateid.length), stateid)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.uint32, access)
            yield* writer.write(XdrCodec.uint32, deny)
          })

        // Without a grace period a reclaim is NO_GRACE; a delegation stateid can never be valid.
        assert.strictEqual((yield* attempt(root, lookup("file"), openAs("a", 0, 1))).status, Status.NO_GRACE)
        assert.strictEqual((yield* attempt(root, openAs("a", 0, 3))).status, Status.NO_GRACE, "CLAIM_DELEGATE_PREV")
        assert.strictEqual((yield* attempt(root, lookup("file"), openAs("a", 0, 6))).status, Status.NO_GRACE)
        assert.strictEqual((yield* attempt(root, openAs("a", 0, 2))).status, Status.BAD_STATEID)
        assert.strictEqual((yield* attempt(root, lookup("file"), openAs("a", 0, 5))).status, Status.BAD_STATEID)

        // Owner a denies reading; owner b is refused until a releases the reservation.
        const denyRead = yield* attempt(root, openAs("a", 1))
        assert.strictEqual(denyRead.status, Status.OK)
        assert.strictEqual((yield* attempt(root, openAs("b", 0))).status, Status.SHARE_DENIED)

        // A new read OPEN conflicts with a's own deny READ reservation too.
        const reopened = yield* attempt(root, openAs("a", 2))
        assert.strictEqual(reopened.status, Status.SHARE_DENIED)
        const first = stateidOf(denyRead, 2)
        assert.strictEqual((yield* attempt(root, openAs("b", 0))).status, Status.SHARE_DENIED, "deny READ retained")

        // Downgrading a's reservation to deny NONE is observable: b may now read.
        const released = yield* attempt(root, lookup("file"), downgrade(first, 1, 0))
        assert.strictEqual(released.status, Status.OK)
        const readerB0 = yield* attempt(root, openAs("b", 0))
        assert.strictEqual(readerB0.status, Status.OK, "deny READ released by OPEN_DOWNGRADE")
        assert.strictEqual((yield* attempt(root, lookup("file"), close(stateidOf(readerB0, 2)))).status, Status.OK)
        // SAFETY: OPEN_DOWNGRADE succeeded, so its body is the downgraded stateid.
        const downgraded = released.operations[3]!.value as Uint8Array
        assert.strictEqual((yield* attempt(root, lookup("file"), close(downgraded))).status, Status.OK)

        const readerB = yield* attempt(root, openAs("b", 0))
        assert.strictEqual(readerB.status, Status.OK)
        assert.strictEqual((yield* attempt(root, openAs("c", 1))).status, Status.SHARE_DENIED, "b already reads")
        const denyWrite = yield* attempt(root, openAs("c", 2))
        assert.strictEqual(denyWrite.status, Status.OK, "denying writes conflicts with nothing")

        // OPEN_DOWNGRADE masks want bits and requires subsets of the held modes.
        const masked = yield* attempt(root, lookup("file"), downgrade(stateidOf(readerB, 2), 0x401, 0))
        assert.strictEqual(masked.status, Status.OK)
        const widened = yield* attempt(root, lookup("file"), downgrade(stateidOf(denyWrite, 2), 1, 1))
        assert.strictEqual(widened.status, Status.INVAL, "deny READ is not a subset of deny WRITE")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should move the current stateid with the filehandle when the current filehandle changes", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/a", new Uint8Array([1]), { access: "write", create: "exclusive" })
        yield* caller.writeFile("/b", new Uint8Array([2]), { access: "write", create: "exclusive" })
        const { handler, client, session } = yield* openSession(caller, "current-stateid-set")
        const current = new Uint8Array([0, 0, 0, 1, ...new Uint8Array(12)])

        const root = (writer: EncoderSession) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)

        const lookup = (name: string) => (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
            yield* writer.write(XdrCodec.string(), name)
          })

        const read = (stateid: Uint8Array) => (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.READ)
            yield* writer.write(XdrCodec.fixedOpaque(stateid.length), stateid)
            yield* writer.write(XdrCodec.uint64, 0n)
            yield* writer.write(XdrCodec.uint32, 1)
          })

        const close = (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.CLOSE)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.fixedOpaque(current.length), current)
          })

        // Section 16.2.3.1.2: SAVEFH and RESTOREFH carry the stateid with the filehandle.
        const saved = yield* run(
          handler,
          call([
            sequence(session, 1),
            root,
            openReadOnly(client, "a"),
            (writer) => writer.write(XdrCodec.uint32, Operation.SAVEFH),

            root,
            openReadOnly(client, "b"),
            (writer) => writer.write(XdrCodec.uint32, Operation.RESTOREFH),

            close
          ])
        )

        assert.strictEqual(saved.status, Status.OK)
        // SAFETY: the first OPEN succeeded, so its body is the OPEN result shape.
        const openedA = (saved.operations[2]!.value as { readonly stateid: Uint8Array }).stateid
        // SAFETY: the second OPEN succeeded, so its body is the OPEN result shape.
        const openedB = (saved.operations[5]!.value as { readonly stateid: Uint8Array }).stateid
        // SAFETY: CLOSE succeeded, so its body is the closed stateid.
        const closed = saved.operations[7]!.value as Uint8Array
        assert.deepStrictEqual(closed.subarray(4), openedA.subarray(4), "RESTOREFH brought back a's stateid")

        const afterClose = yield* run(handler, call([sequence(session, 2), root, lookup("b"), read(openedB)]))
        assert.strictEqual(afterClose.status, Status.OK, "b stays open")
        const reuseA = yield* run(handler, call([sequence(session, 3), root, lookup("a"), read(openedA)]))
        assert.strictEqual(reuseA.status, Status.BAD_STATEID, "a is closed")

        // Setting a filehandle without a stateid resets the current stateid to all zeros, and
        // (1, 0) against a special current stateid is BAD_STATEID (Section 8.2.3).
        const reset = yield* run(
          handler,
          call([sequence(session, 4), root, openReadOnly(client, "b"), root, lookup("b"), read(current)])
        )

        assert.strictEqual(reset.status, Status.BAD_STATEID)
        assert.strictEqual(reset.operations.length, 6)

        // Stateid operations need a current filehandle before any stateid check.
        assert.strictEqual((yield* run(handler, call([sequence(session, 5), close]))).status, Status.NOFILEHANDLE)

        const downgrade = yield* run(
          handler,
          call([
            sequence(session, 6),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.OPEN_DOWNGRADE)
                yield* writer.write(XdrCodec.fixedOpaque(current.length), current)
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.uint32, 1)
                yield* writer.write(XdrCodec.uint32, 0)
              })
          ])
        )

        assert.strictEqual(downgrade.status, Status.NOFILEHANDLE)
      }).pipe(Effect.provide(Testing.layer())))
  })
})

describe("SessionReplay", () => {
  it.layer(NodeCrypto.layer)("NFSv4.1 SessionReplay", (it) => {
    it.effect("should create bounded sessions and return byte-identical cached slot replays when sessions and cached slot replays reach their limits", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const handler = yield* makeHandler(caller)

        const exchange = yield* make.openReader(yield* handler.compound(yield* call([exchangeId("client")])), limits)
        assert.strictEqual(yield* exchange.read(XdrCodec.uint32), Status.OK)
        yield* exchange.read(XdrCodec.string())
        yield* exchange.read(XdrCodec.uint32)
        yield* exchange.read(XdrCodec.uint32)
        yield* exchange.read(XdrCodec.uint32)
        const client = yield* exchange.read(XdrCodec.uint64)

        const create = yield* handler.compound(
          yield* call([(writer) =>
            Effect.gen(function*() {
              yield* Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.CREATE_SESSION)
                yield* writer.write(XdrCodec.uint64, client)
                yield* writer.write(XdrCodec.uint32, 1)
                yield* writer.write(XdrCodec.uint32, 0)
              })
              yield* channel(writer, 2)
              yield* channel(writer, 0)
              yield* Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.uint32, 0)
              })
            })])
        )

        const createReader = yield* make.openReader(create, limits)
        assert.strictEqual(yield* createReader.read(XdrCodec.uint32), Status.OK)
        yield* createReader.read(XdrCodec.string())
        yield* createReader.read(XdrCodec.uint32)
        yield* createReader.read(XdrCodec.uint32)
        yield* createReader.read(XdrCodec.uint32)
        const session = yield* createReader.read(XdrCodec.fixedOpaque(16))

        const sequenced = yield* call([
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.SEQUENCE)
              yield* writer.write(XdrCodec.fixedOpaque(session.length), session)
              yield* writer.write(XdrCodec.uint32, 1)
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.uint32, 1)
              yield* writer.write(XdrCodec.boolean, true)
            }),
          (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
          (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
        ], "replay")

        const first = yield* handler.compound(sequenced)
        const replay = yield* handler.compound(sequenced)
        assert.deepStrictEqual(replay, first)

        const highSlot = yield* call([(writer) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.SEQUENCE)
            yield* writer.write(XdrCodec.fixedOpaque(session.length), session)
            yield* writer.write(XdrCodec.uint32, 2)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.uint32, 2)
            yield* writer.write(XdrCodec.boolean, false)
          })])

        assert.strictEqual(
          yield* (yield* make.openReader(yield* handler.compound(highSlot), limits)).read(XdrCodec.uint32),
          Status.BAD_HIGH_SLOT
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should replay an identical CREATE_SESSION without allocating another session when CREATE_SESSION repeats with the same request", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxSessions: 1
        }

        const handler = yield* makeHandler(caller, { limits: constrained })

        const exchange = yield* make.openReader(
          yield* handler.compound(yield* call([exchangeId("create-replay")])),
          limits
        )

        yield* exchange.read(XdrCodec.uint32)
        yield* exchange.read(XdrCodec.string())
        yield* exchange.read(XdrCodec.uint32)
        yield* exchange.read(XdrCodec.uint32)
        yield* exchange.read(XdrCodec.uint32)
        const client = yield* exchange.read(XdrCodec.uint64)

        const request = yield* call([(writer) =>
          Effect.gen(function*() {
            yield* Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.CREATE_SESSION)
              yield* writer.write(XdrCodec.uint64, client)
              yield* writer.write(XdrCodec.uint32, 1)
              yield* writer.write(XdrCodec.uint32, 0)
            })
            yield* channel(writer, 2)
            yield* channel(writer, 0)
            yield* Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.uint32, 0)
            })
          })], "create-replay")

        const first = yield* handler.compound(request)
        const replay = yield* handler.compound(request)
        assert.deepStrictEqual(replay, first)
        assert.strictEqual(yield* (yield* make.openReader(replay, limits)).read(XdrCodec.uint32), Status.OK)

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
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should return SEQUENCE OK before RETRY_UNCACHED_REP for an uncached replay when an uncached slot request is replayed", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const { handler, session } = yield* openSession(caller, "uncached-replay")

        const request = yield* call([
          sequence(session, 1),
          (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)
        ])

        assert.strictEqual((yield* statuses(yield* handler.compound(request))).status, Status.OK)
        assert.deepStrictEqual((yield* statuses(yield* handler.compound(request))).operations, [[
          Operation.SEQUENCE,
          Status.OK
        ], [Operation.PUTROOTFH, Status.RETRY_UNCACHED_REP]])
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should execute OPEN once when its reply is lost", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const base = yield* exportFor(caller)

        let opens = 0

        const export_ = {
          ...base,
          open: (reference: Vfs.ObjectReference) => {
            opens++

            return base.open(reference)
          }
        }

        const handler = yield* handlerFor(export_)

        const {
          session,
          client
        } = yield* startSession(handler, "lost-open")

        const request = yield* call([
          sequence(session, 1, true),
          (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
          openReadOnly(client, "file"),
          (writer) => writer.write(XdrCodec.uint32, Operation.GETFH),
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
              yield* writer.write(XdrCodec.string(), "child")
            })
        ])

        const first = yield* handler.compound(request)
        assert.strictEqual(yield* (yield* make.openReader(first, limits)).read(XdrCodec.uint32), Status.NOTDIR)
        assert.deepStrictEqual(yield* handler.compound(request), first)
        assert.strictEqual(opens, 1)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should reject an OPEN before execution when its cached result cannot fit", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const base = yield* exportFor(caller)

        let opens = 0

        const handler = yield* handlerFor({
          ...base,
          open: (reference: Vfs.ObjectReference) => {
            opens++

            return base.open(reference)
          }
        })

        const {
          session,
          client
        } = yield* startSession(handler, "open-capacity", {
          maxCachedResponse: 80
        })

        const request = yield* call([sequence(session, 1, true), (writer) =>
          writer.write(XdrCodec.uint32, Operation.PUTROOTFH), openReadOnly(client, "file")])

        assert.strictEqual((yield* statuses(yield* handler.compound(request))).status, Status.REP_TOO_BIG_TO_CACHE)
        assert.strictEqual(opens, 0)
        assert.strictEqual((yield* statuses(yield* handler.compound(request))).status, Status.REP_TOO_BIG_TO_CACHE)
        assert.strictEqual(opens, 0)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should include every configured SECINFO flavor in pre-mutation reply admission when SECINFO flavors affect reply admission before mutation", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const base = yield* exportFor(caller)

        let opens = 0

        const handler = yield* handlerFor({
          ...base,
          open: (reference: Vfs.ObjectReference) => {
            opens++

            return base.open(reference)
          }
        }, { securityFlavors: [1, 0, 1, 0, 1, 0] })

        const {
          session,
          client
        } = yield* startSession(handler, "secinfo-capacity", {
          maxCachedResponse: 218
        })

        const request = yield* call([
          sequence(session, 1, true),
          (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
          openReadOnly(client, "file"),
          (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.SECINFO)
              yield* writer.write(XdrCodec.string(), "file")
            })
        ])

        assert.strictEqual(
          yield* (yield* make.openReader(yield* handler.compound(request), limits)).read(XdrCodec.uint32),
          Status.REP_TOO_BIG_TO_CACHE
        )
        assert.strictEqual(opens, 0)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should keep a consumed slot closed when an operation fails", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const base = yield* exportFor(caller)

        let opens = 0

        const handler = yield* handlerFor({
          ...base,
          open: (reference: Vfs.ObjectReference) =>
            base.open(reference).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  opens++
                })
              ),
              Effect.tap(() => Effect.die(new Error("storage outcome unknown")))
            )
        })

        const {
          session,
          client
        } = yield* startSession(handler, "failed-open")

        const request = yield* call([sequence(session, 1), (writer) =>
          writer.write(XdrCodec.uint32, Operation.PUTROOTFH), openReadOnly(client, "file")])

        assert.isTrue(Exit.isFailure(yield* Effect.exit(handler.compound(request))))
        assert.deepStrictEqual((yield* statuses(yield* handler.compound(request))).operations, [[
          Operation.SEQUENCE,
          Status.OK
        ], [Operation.PUTROOTFH, Status.RETRY_UNCACHED_REP]])
        assert.strictEqual(opens, 1)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should leave a slot unchanged when SEQUENCE rejects an oversized cached reply", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxReplayBytes: ByteSize.bytes(512)
        }

        const handler = yield* makeHandler(caller, { limits: constrained })

        const {
          session
        } = yield* startSession(handler, "replay-budget", {
          maxCachedResponse: 64
        })

        const rejected = yield* call([
          sequence(session, 1, true),
          (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.GETATTR)
              yield* writer.write(XdrCodec.uint32, 1)
              yield* writer.write(XdrCodec.uint32, 1)
            })
        ])

        assert.strictEqual(
          yield* (yield* make.openReader(yield* handler.compound(rejected), limits)).read(XdrCodec.uint32),
          Status.REP_TOO_BIG_TO_CACHE
        )
        const retry = yield* call([sequence(session, 1)])
        assert.strictEqual(
          yield* (yield* make.openReader(yield* handler.compound(retry), limits)).read(XdrCodec.uint32),
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should accept small actual replies within a negotiated response channel when the actual reply fits a negotiated response channel", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const handler = yield* makeHandler(caller)

        const {
          session
        } = yield* startSession(handler, "small-response", {
          maxResponse: 128
        })

        assert.strictEqual(
          yield* (yield* make.openReader(yield* handler.compound(yield* call([sequence(session, 1)])), limits)).read(
            XdrCodec.uint32
          ),
          Status.OK
        )

        const {
          session: readdirSession
        } = yield* startSession(handler, "small-readdir-response", {
          maxResponse: 512
        })

        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(
              yield* call([
                sequence(readdirSession, 1),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.READDIR)
                    yield* writer.write(XdrCodec.uint64, 0n)
                    yield* writer.write(XdrCodec.fixedOpaque(new Uint8Array(8).length), new Uint8Array(8))
                    yield* writer.write(XdrCodec.uint32, 0)
                    yield* writer.write(XdrCodec.uint32, 32_768)
                    yield* writer.write(XdrCodec.uint32, 0)
                  })
              ], "readdirplus ")
            ),
            limits
          )).read(XdrCodec.uint32),
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should count retained requests against the replay-memory budget when replay requests are retained under a byte budget", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxReplayBytes: ByteSize.bytes(560)
        }

        const { handler, session } = yield* openSession(caller, "request-budget", { limits: constrained })

        const first = yield* call([
          sequence(session, 1, false, 0),
          (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)
        ], "x".repeat(80))

        assert.strictEqual(
          yield* (yield* make.openReader(yield* handler.compound(first), limits)).read(XdrCodec.uint32),
          Status.OK
        )

        const second = yield* call([
          sequence(session, 1, false, 1),
          (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)
        ], "x".repeat(80))

        assert.strictEqual(
          yield* (yield* make.openReader(yield* handler.compound(second), limits)).read(XdrCodec.uint32),
          Status.DELAY
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should reuse the reserved replay budget for successive uncached requests when successive uncached requests use one reserved replay budget", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxReplayBytes: ByteSize.bytes(640)
        }

        const { handler, session } = yield* openSession(caller, "reused-request-budget", { limits: constrained })

        for (let sequenceId = 1; sequenceId <= 4; sequenceId++) {
          const request = yield* call([
            sequence(session, sequenceId),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)
          ], "x".repeat(80))

          assert.strictEqual(
            yield* (yield* make.openReader(yield* handler.compound(request), constrained)).read(XdrCodec.uint32),
            Status.OK
          )
        }
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should reject a different request that reuses a cached slot sequence when a different request reuses a cached slot sequence", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const { handler, session } = yield* openSession(caller, "false-retry")

        yield* handler.compound(
          yield* call([sequence(session, 1, true), (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)])
        )

        const changed = yield* call([sequence(session, 1, true), (writer) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.GETATTR)
            yield* writer.write(XdrCodec.uint32, 0)
          })])

        assert.strictEqual(
          yield* (yield* make.openReader(yield* handler.compound(changed), limits)).read(XdrCodec.uint32),
          Status.SEQ_FALSE_RETRY
        )

        const changedCredentials = {
          ...(yield* call([
            sequence(session, 1, true),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)
          ])),
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
          yield* (yield* make.openReader(yield* handler.compound(changedCredentials), limits)).read(XdrCodec.uint32),
          Status.SEQ_FALSE_RETRY
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should replace a slot's cached reply without double-counting its old bytes when a cached slot reply is replaced", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxReplayBytes: ByteSize.bytes(1_024)
        }

        const { handler, session } = yield* openSession(caller, "replace-replay", { limits: constrained })

        for (
          const sequenceId of Array.from({
            length: 10
          }, (_, index) => index + 1)
        ) {
          const request = yield* call([
            sequence(session, sequenceId, true),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)
          ])

          const response = yield* handler.compound(request)
          assert.strictEqual(yield* (yield* make.openReader(response, constrained)).read(XdrCodec.uint32), Status.OK)
          assert.deepStrictEqual(yield* handler.compound(request), response)
        }
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should revoke the prior client incarnation when its replacement creates a session", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxClients: 1,
          maxSessions: 1
        }

        const handler = yield* makeHandler(caller, { limits: constrained })

        const first = yield* startSession(handler, "restarted-client")

        const exchange = yield* make.openReader(
          yield* handler.compound(yield* call([exchangeId("restarted-client", new Uint8Array(8).fill(1))])),
          constrained
        )

        yield* exchange.read(XdrCodec.uint32)
        yield* exchange.read(XdrCodec.string())
        yield* exchange.read(XdrCodec.uint32)
        yield* exchange.read(XdrCodec.uint32)
        yield* exchange.read(XdrCodec.uint32)
        const replacement = yield* exchange.read(XdrCodec.uint64)

        const create = yield* call([(writer) =>
          Effect.gen(function*() {
            yield* Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.CREATE_SESSION)
              yield* writer.write(XdrCodec.uint64, replacement)
              yield* writer.write(XdrCodec.uint32, 1)
              yield* writer.write(XdrCodec.uint32, 0)
            })
            yield* channel(writer, 2)
            yield* channel(writer, 0)
            yield* Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.uint32, 0)
            })
          })])

        assert.strictEqual(
          yield* (yield* make.openReader(yield* handler.compound(create), constrained)).read(XdrCodec.uint32),
          Status.OK
        )
        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(yield* call([sequence(first.session, 1)])),
            constrained
          ))
            .read(XdrCodec.uint32),
          Status.BADSESSION
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should restore a confirmed predecessor after destroying an unconfirmed replacement when an unconfirmed replacement session is destroyed", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxClients: 1
        }

        const handler = yield* makeHandler(caller, { limits: constrained })

        const original = yield* startSession(handler, "abandoned-restart")

        const replacementResponse = yield* make.openReader(
          yield* handler.compound(yield* call([exchangeId("abandoned-restart", new Uint8Array(8).fill(1))])),
          constrained
        )

        yield* replacementResponse.read(XdrCodec.uint32)
        yield* replacementResponse.read(XdrCodec.string())
        yield* replacementResponse.read(XdrCodec.uint32)
        yield* replacementResponse.read(XdrCodec.uint32)
        yield* replacementResponse.read(XdrCodec.uint32)
        const replacement = yield* replacementResponse.read(XdrCodec.uint64)
        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(
              yield* call([(writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.DESTROY_CLIENTID)
                  yield* writer.write(XdrCodec.uint64, replacement)
                })])
            ),
            constrained
          )).read(XdrCodec.uint32),
          Status.OK
        )
        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(yield* call([exchangeId("abandoned-restart", new Uint8Array(8).fill(2))])),
            constrained
          )).read(XdrCodec.uint32),
          Status.OK
        )
        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(yield* call([sequence(original.session, 1)])),
            constrained
          )).read(XdrCodec.uint32),
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should bound pending client replacements separately from logical clients when pending client replacements reach their separate limit", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxClients: 2,
          maxPendingClientReplacements: 1
        }

        const handler = yield* makeHandler(caller, { limits: constrained })

        yield* startSession(handler, "pending-a")
        yield* startSession(handler, "pending-b")

        const replacementA = yield* make.openReader(
          yield* handler.compound(yield* call([exchangeId("pending-a", new Uint8Array(8).fill(1))])),
          constrained
        )

        yield* replacementA.read(XdrCodec.uint32)
        yield* replacementA.read(XdrCodec.string())
        yield* replacementA.read(XdrCodec.uint32)
        yield* replacementA.read(XdrCodec.uint32)
        yield* replacementA.read(XdrCodec.uint32)
        const replacementAId = yield* replacementA.read(XdrCodec.uint64)
        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(yield* call([exchangeId("pending-b", new Uint8Array(8).fill(1))])),
            constrained
          )).read(XdrCodec.uint32),
          Status.DELAY
        )
        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(
              yield* call([(writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.DESTROY_CLIENTID)
                  yield* writer.write(XdrCodec.uint64, replacementAId)
                })])
            ),
            constrained
          )).read(XdrCodec.uint32),
          Status.OK
        )
        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(yield* call([exchangeId("pending-b", new Uint8Array(8).fill(1))])),
            constrained
          )).read(XdrCodec.uint32),
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should require DESTROY_SESSION for the active session to be the final operation when DESTROY_SESSION targets its active session", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const { handler, session } = yield* openSession(caller, "destroy-order")

        const rejected = yield* statuses(
          yield* handler.compound(
            yield* call([sequence(session, 1, true), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.DESTROY_SESSION)
                yield* writer.write(XdrCodec.fixedOpaque(session.length), session)
              }), (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)])
          )
        )

        assert.strictEqual(rejected.status, Status.NOT_ONLY_OP)
        assert.deepStrictEqual(rejected.operations.at(-1), [Operation.DESTROY_SESSION, Status.NOT_ONLY_OP])
        assert.strictEqual(
          yield* (yield* make.openReader(yield* handler.compound(yield* call([sequence(session, 2)])), limits)).read(
            XdrCodec.uint32
          ),
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should reject an unsequenced non-final DESTROY_SESSION without removing the session when DESTROY_SESSION is unsequenced and non-final", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const { handler, session } = yield* openSession(caller, "unsequenced-destroy-order")

        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(
              yield* call([(writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.DESTROY_SESSION)
                  yield* writer.write(XdrCodec.fixedOpaque(session.length), session)
                }), (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)])
            ),
            limits
          )).read(XdrCodec.uint32),
          Status.NOT_ONLY_OP
        )
        assert.strictEqual(
          yield* (yield* make.openReader(yield* handler.compound(yield* call([sequence(session, 1)])), limits)).read(
            XdrCodec.uint32
          ),
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should release cached replay capacity when DESTROY_SESSION removes its session", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxClients: 8,
          maxSessions: 1,
          maxReplayBytes: ByteSize.bytes(1_024)
        }

        const handler = yield* makeHandler(caller, { limits: constrained })

        for (let index = 0; index < 4; index++) {
          const {
            session
          } = yield* startSession(handler, `destroy-cache-${index}`)

          assert.strictEqual(
            yield* (yield* make.openReader(
              yield* handler.compound(
                yield* call([
                  sequence(session, 1, true),
                  (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)
                ])
              ),
              constrained
            )).read(XdrCodec.uint32),
            Status.OK
          )
          assert.strictEqual(
            yield* (yield* make.openReader(
              yield* handler.compound(
                yield* call([(writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.DESTROY_SESSION)
                    yield* writer.write(XdrCodec.fixedOpaque(session.length), session)
                  })])
              ),
              constrained
            )).read(XdrCodec.uint32),
            Status.OK
          )
        }

        const {
          session
        } = yield* startSession(handler, "after-destroy-cache")

        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(
              yield* call([sequence(session, 1, true), (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)])
            ),
            constrained
          )).read(XdrCodec.uint32),
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should serialize concurrent slot duplicates so OPEN runs exactly once when duplicate slot requests arrive concurrently", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const base = yield* exportFor(caller)

        let opens = 0

        const export_ = {
          ...base,
          open: (reference: Vfs.ObjectReference) =>
            Effect.sync(() => opens++).pipe(Effect.andThen(Effect.yieldNow), Effect.andThen(base.open(reference)))
        }

        const handler = yield* handlerFor(export_)

        const {
          client,
          session
        } = yield* startSession(handler, "concurrent")

        const request = yield* call([
          sequence(session, 1, true),
          (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
          openReadOnly(client, "file"),
          (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
        ])

        const [first, duplicate] = yield* Effect.all([handler.compound(request), handler.compound(request)], {
          concurrency: "unbounded"
        })

        assert.deepStrictEqual(duplicate, first)
        assert.strictEqual(opens, 1)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should reject an oversized reply before any state-changing operation runs when a response would exceed its bound before mutation", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
        const handler = yield* makeHandler(caller)
        // Small enough for SEQUENCE + PUTROOTFH + OPEN, too small once a worst-case GETATTR follows.
        const { client, session } = yield* startSession(handler, "preflight", { maxResponse: 320 })
        const other = yield* startSession(handler, "preflight-other")
        const allAttributes = [0xffff_ffff, 0xffff_ffff, 0xffff]

        const tooBig = yield* run(
          handler,
          call([
            sequence(session, 1),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

            openReadOnly(client, "file"),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.GETATTR)
                yield* writer.write(XdrCodec.array(XdrCodec.uint32), allAttributes)
              })
          ])
        )

        assert.strictEqual(tooBig.status, Status.REP_TOO_BIG)
        assert.strictEqual(tooBig.operations.length, 1, "rejected at SEQUENCE, before OPEN executed")

        // The open never happened, so a fresh OPEN yields seqid 1 rather than a bumped seqid.
        const opened = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

              openReadOnly(client, "file"),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        assert.strictEqual(new DataView(opened.stateid.buffer).getUint32(0), 1)

        // DESTROY_SESSION of another session changes state too, so it is also gated by the preflight.
        const destroyTooBig = yield* run(
          handler,
          call([
            sequence(session, 2),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.DESTROY_SESSION)
                yield* writer.write(XdrCodec.fixedOpaque(other.session.length), other.session)
              }),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.READDIR)
                yield* writer.write(XdrCodec.uint64, 0n)
                yield* writer.write(XdrCodec.fixedOpaque(new Uint8Array(8).length), new Uint8Array(8))
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.uint32, 16_384)
                yield* writer.write(XdrCodec.uint32, 0)
              })
          ])
        )

        assert.strictEqual(destroyTooBig.status, Status.REP_TOO_BIG)
        assert.strictEqual((yield* run(handler, call([sequence(other.session, 1)]))).status, Status.OK)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should reject a READ that cannot fit the channel before it touches the file when a READ reply cannot fit the channel", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1, 2, 3]), { access: "write", create: "exclusive" })
        const before = (yield* caller.stat("/file")).atimeNs
        const handler = yield* makeHandler(caller)
        const { session } = yield* startSession(handler, "read-preflight", { maxResponse: 512 })

        // The file was never read after it changed, so READ refreshes its access time; the worst-case reply
        // must fit before READ runs.
        const reply = yield* run(
          handler,
          call([
            sequence(session, 1),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                yield* writer.write(XdrCodec.string(), "file")
              }),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.READ)
                yield* writer.write(XdrCodec.fixedOpaque(new Uint8Array(16).length), new Uint8Array(16))
                yield* writer.write(XdrCodec.uint64, 0n)
                yield* writer.write(XdrCodec.uint32, 4_096)
              })
          ])
        )

        assert.deepStrictEqual(reply.operations, [{ code: Operation.SEQUENCE, status: Status.REP_TOO_BIG }])
        assert.strictEqual((yield* caller.stat("/file")).atimeNs, before)

        const fitting = yield* run(
          handler,
          call([
            sequence(session, 1),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),

            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                yield* writer.write(XdrCodec.string(), "file")
              }),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.READ)
                yield* writer.write(XdrCodec.fixedOpaque(new Uint8Array(16).length), new Uint8Array(16))
                yield* writer.write(XdrCodec.uint64, 0n)
                yield* writer.write(XdrCodec.uint32, 64)
              })
          ])
        )

        assert.strictEqual(fitting.status, Status.OK)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should follow the EXCHANGE_ID client record cases of RFC 8881 Section 18.35.4 when EXCHANGE_ID encounters client record variants", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        const handler = yield* makeHandler(caller)
        const owner = "record-cases"

        type Exchanged = { readonly clientid: bigint; readonly sequence: number; readonly flags: number }

        const exchange = (credentials: CompoundCall["credentials"], verifier: Uint8Array, flags = 0) =>
          run(
            handler,
            callAs(credentials, [(writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.EXCHANGE_ID)
                yield* writer.write(XdrCodec.fixedOpaque(verifier.length), verifier)
                yield* writer.write(XdrCodec.string(), owner)
                yield* writer.write(XdrCodec.uint32, flags)
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.uint32, 0)
              })])
          ).pipe(Effect.map((reply) => {
            // SAFETY: EXCHANGE_ID succeeded, so the body reader table produced the EXCHANGE_ID result shape.
            const value = reply.operations[0]!.value as Exchanged

            return { status: reply.status, value }
          }))

        const createSession = (credentials: CompoundCall["credentials"], clientid: bigint, sequenceId: number) =>
          run(
            handler,
            callAs(credentials, [(writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.CREATE_SESSION)
                yield* writer.write(XdrCodec.uint64, clientid)
                yield* writer.write(XdrCodec.uint32, sequenceId)
                yield* writer.write(XdrCodec.uint32, 0)

                for (let channel = 0; channel < 2; channel++) {
                  yield* writer.write(XdrCodec.uint32, 0)
                  yield* writer.write(XdrCodec.uint32, 8192)
                  yield* writer.write(XdrCodec.uint32, 8192)
                  yield* writer.write(XdrCodec.uint32, 8192)
                  yield* writer.write(XdrCodec.uint32, 32)
                  yield* writer.write(XdrCodec.uint32, 2)
                  yield* writer.write(XdrCodec.uint32, 0)
                }

                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.uint32, 0)
              })])
          )

        const v1 = new Uint8Array(8).fill(1)
        const v2 = new Uint8Array(8).fill(2)
        const CONFIRMED_R = 0x8000_0000
        const UPDATE = 0x4000_0000

        // Case 1 then case 4: a repeated EXCHANGE_ID on an unconfirmed record issues a new client ID.
        const first = yield* exchange(sys(501, 20), v1)
        const second = yield* exchange(sys(501, 20), v1)
        assert.notStrictEqual(second.value.clientid, first.value.clientid)
        assert.strictEqual(second.value.flags & CONFIRMED_R, 0)

        const confirmed = yield* createSession(sys(501, 20), second.value.clientid, second.value.sequence)
        assert.strictEqual(confirmed.status, Status.OK)

        // Case 2: the confirmed record is returned unchanged to the same principal.
        const retry = yield* exchange(sys(501, 20), v1)
        assert.strictEqual(retry.value.clientid, second.value.clientid)
        assert.notStrictEqual(retry.value.flags & CONFIRMED_R, 0)

        // Case 3 with live state: another principal must pick a different owner.
        const collision = yield* exchange(sys(1111, 37), v1)
        assert.strictEqual(collision.status, Status.CLID_INUSE)

        // Case 3 without state: the confirmed record is replaced and its client ID becomes stale.
        // SAFETY: CREATE_SESSION succeeded, so the body reader table produced the CREATE_SESSION result shape.
        const { session } = confirmed.operations[0]!.value as { readonly session: Uint8Array }

        const destroyed = yield* run(
          handler,
          call([(writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.DESTROY_SESSION)
              yield* writer.write(XdrCodec.fixedOpaque(session.length), session)
            })])
        )

        assert.strictEqual(destroyed.status, Status.OK)
        const replaced = yield* exchange(sys(1111, 37), v1)
        assert.strictEqual(replaced.status, Status.OK)
        assert.notStrictEqual(replaced.value.clientid, second.value.clientid)
        const stale = yield* createSession(sys(501, 20), second.value.clientid, second.value.sequence + 1)
        assert.strictEqual(stale.status, Status.STALE_CLIENTID)

        // Cases 7 to 9: updates need a confirmed record, the same verifier, and the same principal.
        assert.strictEqual((yield* exchange(sys(1111, 37), v1, UPDATE)).status, Status.NOENT)
        const confirmedAgain = yield* createSession(sys(1111, 37), replaced.value.clientid, replaced.value.sequence)
        assert.strictEqual(confirmedAgain.status, Status.OK)
        assert.strictEqual((yield* exchange(sys(1111, 37), v2, UPDATE)).status, Status.NOT_SAME)
        assert.strictEqual((yield* exchange(sys(501, 20), v1, UPDATE)).status, Status.PERM)
        assert.strictEqual((yield* exchange(sys(1111, 37), v1, UPDATE)).status, Status.OK)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should guard CREATE_SESSION by principal, channel size, and operation-level replay when CREATE_SESSION varies principal, channel size, or replay", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        const handler = yield* makeHandler(caller)

        const exchanged = yield* run(
          handler,
          callAs(sys(501, 20), [
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.EXCHANGE_ID)
                yield* writer.write(XdrCodec.fixedOpaque(new Uint8Array(8).length), new Uint8Array(8))
                yield* writer.write(XdrCodec.string(), "session-guards")
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.uint32, 0)
              })
          ])
        )

        // SAFETY: EXCHANGE_ID succeeded, so the body reader table produced the EXCHANGE_ID result shape.
        const { clientid, sequence: firstSequence } = exchanged.operations[0]!.value as {
          readonly clientid: bigint
          readonly sequence: number
        }

        const createSession =
          (sequenceId: number, maxRequest = 8192, maxResponse = 8192, flags = 0) => (writer: EncoderSession) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.CREATE_SESSION)
              yield* writer.write(XdrCodec.uint64, clientid)
              yield* writer.write(XdrCodec.uint32, sequenceId)
              yield* writer.write(XdrCodec.uint32, flags)
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.uint32, maxRequest)
              yield* writer.write(XdrCodec.uint32, maxResponse)
              yield* writer.write(XdrCodec.uint32, 8192)
              yield* writer.write(XdrCodec.uint32, 32)
              yield* writer.write(XdrCodec.uint32, 2)
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.uint32, 8192)
              yield* writer.write(XdrCodec.uint32, 8192)
              yield* writer.write(XdrCodec.uint32, 8192)
              yield* writer.write(XdrCodec.uint32, 32)
              yield* writer.write(XdrCodec.uint32, 2)
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.uint32, 0)
            })

        // An unconfirmed record rejects another principal without consuming the owner's slot.
        const inUse = yield* run(handler, callAs(sys(1111, 37), [createSession(firstSequence)]))
        assert.strictEqual(inUse.status, Status.CLID_INUSE)

        // Section 18.36.4 phase 2: a request with the expected csa_sequence consumes the slot even
        // when it fails, so the same sequence replays TOOSMALL and the corrected retry uses the next.
        const tooSmallRequest = yield* run(handler, callAs(sys(501, 20), [createSession(firstSequence, 20)]))
        assert.strictEqual(tooSmallRequest.status, Status.TOOSMALL)
        const replayedTooSmall = yield* run(handler, callAs(sys(501, 20), [createSession(firstSequence)]))
        assert.strictEqual(replayedTooSmall.status, Status.TOOSMALL, "the failed result is cached in the slot")
        const misordered = yield* run(handler, callAs(sys(501, 20), [createSession(firstSequence + 2)]))
        assert.strictEqual(misordered.status, Status.SEQ_MISORDERED)
        const tooSmallResponse = yield* run(handler, callAs(sys(501, 20), [createSession(firstSequence + 1, 8192, 0)]))
        assert.strictEqual(tooSmallResponse.status, Status.TOOSMALL)

        // Undefined csa_flags are INVAL and consume the slot too.
        const badFlags = yield* run(handler, callAs(sys(501, 20), [createSession(firstSequence + 2, 8192, 8192, 0x10)]))
        assert.strictEqual(badFlags.status, Status.INVAL)
        const replayedBadFlags = yield* run(handler, callAs(sys(501, 20), [createSession(firstSequence + 2)]))
        assert.strictEqual(replayedBadFlags.status, Status.INVAL, "the INVAL result is cached in the slot")

        const created = yield* run(handler, callAs(sys(501, 20), [createSession(firstSequence + 3)]))
        assert.strictEqual(created.status, Status.OK)
        // SAFETY: CREATE_SESSION succeeded, so the body reader table produced the CREATE_SESSION result shape.
        const { session } = created.operations[0]!.value as { readonly session: Uint8Array }

        // Once confirmed, any principal may create sessions.
        const other = yield* run(handler, callAs(sys(1111, 37), [createSession(firstSequence + 4)]))
        assert.strictEqual(other.status, Status.OK)

        // A retry inside a SEQUENCE compound replays the cached CREATE_SESSION result.
        const replayed = yield* run(
          handler,
          callAs(sys(1111, 37), [sequence(session, 1), createSession(firstSequence + 4)])
        )

        assert.strictEqual(replayed.status, Status.OK)
        assert.deepStrictEqual(replayed.operations[1]!.value, other.operations[0]!.value)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should replay CREATE_SESSION before validating flags when a minimum response channel is negotiated", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        const handler = yield* makeHandler(caller)

        const exchanged = yield* run(
          handler,
          call([
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.EXCHANGE_ID)
                yield* writer.write(XdrCodec.fixedOpaque(new Uint8Array(8).length), new Uint8Array(8))
                yield* writer.write(XdrCodec.string(), "precedence")
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.uint32, 0)
              })
          ])
        )

        // SAFETY: EXCHANGE_ID succeeded, so the body reader table produced the EXCHANGE_ID result shape.
        const { clientid, sequence: firstSequence } = exchanged.operations[0]!.value as {
          readonly clientid: bigint
          readonly sequence: number
        }

        const createSession = (sequenceId: number, flags: number, maxResponse: number) => (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.CREATE_SESSION)
            yield* writer.write(XdrCodec.uint64, clientid)
            yield* writer.write(XdrCodec.uint32, sequenceId)
            yield* writer.write(XdrCodec.uint32, flags)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.uint32, 8192)
            yield* writer.write(XdrCodec.uint32, maxResponse)
            yield* writer.write(XdrCodec.uint32, 8192)
            yield* writer.write(XdrCodec.uint32, 32)
            yield* writer.write(XdrCodec.uint32, 2)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.uint32, 8192)
            yield* writer.write(XdrCodec.uint32, 8192)
            yield* writer.write(XdrCodec.uint32, 8192)
            yield* writer.write(XdrCodec.uint32, 32)
            yield* writer.write(XdrCodec.uint32, 2)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.uint32, 0)
          })

        // The smallest usable response channel is an RPC reply carrying a SEQUENCE-only compound.
        // The failed attempt consumes the slot, so the corrected request uses the next sequence.
        assert.strictEqual((yield* run(handler, call([createSession(firstSequence, 0, 79)]))).status, Status.TOOSMALL)
        const created = yield* run(handler, call([createSession(firstSequence + 1, 0, 80)]))
        assert.strictEqual(created.status, Status.OK)
        // An equal csa_sequence replays the cached result before any argument validation.
        const replayed = yield* run(handler, call([createSession(firstSequence + 1, 0xf, 80)]))
        assert.deepStrictEqual(replayed.operations[0]!.value, created.operations[0]!.value)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should renew the lease on CREATE_SESSION and reject channels without room for two operations when CREATE_SESSION renews a lease or receives a minimal channel", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        let now = 0

        const handler = yield* makeHandler(caller, { now: () => now })

        const exchanged = yield* run(
          handler,
          call([
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.EXCHANGE_ID)
                yield* writer.write(XdrCodec.fixedOpaque(new Uint8Array(8).length), new Uint8Array(8))
                yield* writer.write(XdrCodec.string(), "lease")
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.uint32, 0)
              })
          ])
        )

        // SAFETY: EXCHANGE_ID succeeded, so the body reader table produced the EXCHANGE_ID result shape.
        const { clientid, sequence: firstSequence } = exchanged.operations[0]!.value as {
          readonly clientid: bigint
          readonly sequence: number
        }

        const createSession = (maxOperations: number, sequenceId: number) => (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.CREATE_SESSION)
            yield* writer.write(XdrCodec.uint64, clientid)
            yield* writer.write(XdrCodec.uint32, sequenceId)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.uint32, 8192)
            yield* writer.write(XdrCodec.uint32, 8192)
            yield* writer.write(XdrCodec.uint32, 8192)
            yield* writer.write(XdrCodec.uint32, maxOperations)
            yield* writer.write(XdrCodec.uint32, 2)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.uint32, 8192)
            yield* writer.write(XdrCodec.uint32, 8192)
            yield* writer.write(XdrCodec.uint32, 8192)
            yield* writer.write(XdrCodec.uint32, 32)
            yield* writer.write(XdrCodec.uint32, 2)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.uint32, 0)
          })

        assert.strictEqual((yield* run(handler, call([createSession(1, firstSequence)]))).status, Status.TOOSMALL)

        // The failed attempt consumed the slot (Section 18.36.4 phase 2).
        now = 25_000
        const created = yield* run(handler, call([createSession(32, firstSequence + 1)]))
        assert.strictEqual(created.status, Status.OK)
        // SAFETY: CREATE_SESSION succeeded, so the body reader table produced the CREATE_SESSION result shape.
        const { session } = created.operations[0]!.value as { readonly session: Uint8Array }

        // Without renewal the record created at t=0 would have expired at t=30s.
        now = 50_000
        assert.strictEqual((yield* run(handler, call([sequence(session, 1)]))).status, Status.OK)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should bound the back channel and the client-record table when backchannel or client-record capacity is exhausted", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        const constrained = { ...limits, maxClients: 2 }

        const handler = yield* makeHandler(caller, { limits: constrained })

        const exchange = (owner: string) =>
          run(
            handler,
            call([(writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.EXCHANGE_ID)
                yield* writer.write(XdrCodec.fixedOpaque(new Uint8Array(8).length), new Uint8Array(8))
                yield* writer.write(XdrCodec.string(), owner)
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.uint32, 0)
                yield* writer.write(XdrCodec.uint32, 0)
              })])
          )

        assert.strictEqual((yield* exchange("bounded-a")).status, Status.OK)
        assert.strictEqual((yield* exchange("bounded-b")).status, Status.OK)
        assert.strictEqual((yield* exchange("bounded-c")).status, Status.DELAY, "third owner exceeds maxClients")
        // Case 4 replaces the unconfirmed record with a new client ID without consuming another slot.
        const replaced = yield* exchange("bounded-a")
        assert.strictEqual(replaced.status, Status.OK, "an existing owner is not a new record")

        // SAFETY: EXCHANGE_ID succeeded, so the body reader table produced the EXCHANGE_ID result shape.
        const { clientid, sequence: firstSequence } = replaced.operations[0]!.value as {
          readonly clientid: bigint
          readonly sequence: number
        }

        const backTooSmall = yield* run(
          handler,
          call([(writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.CREATE_SESSION)
              yield* writer.write(XdrCodec.uint64, clientid)
              yield* writer.write(XdrCodec.uint32, firstSequence)
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.uint32, 8192)
              yield* writer.write(XdrCodec.uint32, 8192)
              yield* writer.write(XdrCodec.uint32, 8192)
              yield* writer.write(XdrCodec.uint32, 32)
              yield* writer.write(XdrCodec.uint32, 2)
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.uint32, 10)
              yield* writer.write(XdrCodec.uint32, 8192)
              yield* writer.write(XdrCodec.uint32, 8192)
              yield* writer.write(XdrCodec.uint32, 32)
              yield* writer.write(XdrCodec.uint32, 1)
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.uint32, 0)
              yield* writer.write(XdrCodec.uint32, 0)
            })])
        )

        assert.strictEqual(backTooSmall.status, Status.TOOSMALL)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should bind connections, accept backchannel parameters, and judge a misplaced SEQUENCE in place when connections bind or SEQUENCE appears in the wrong position", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        const { handler, session } = yield* openSession(caller, "bind")

        const bind = (id: Uint8Array) => (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.BIND_CONN_TO_SESSION)
            yield* writer.write(XdrCodec.fixedOpaque(id.length), id)
            yield* writer.write(XdrCodec.uint32, 3)
            yield* writer.write(XdrCodec.boolean, false)
          })

        const bindDirection = (direction: number) => (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.BIND_CONN_TO_SESSION)
            yield* writer.write(XdrCodec.fixedOpaque(session.length), session)
            yield* writer.write(XdrCodec.uint32, direction)
            yield* writer.write(XdrCodec.boolean, false)
          })

        // Section 18.34.3: the sole operation of its compound, with or without a session; the
        // connection is already the fore channel, so fore-channel requests succeed as CDFS4_FORE.
        const unknown = yield* run(handler, call([bind(new Uint8Array(16).fill(1))]))
        assert.deepStrictEqual(unknown.operations, [{
          code: Operation.BIND_CONN_TO_SESSION,
          status: Status.BADSESSION
        }])
        const bound = yield* run(handler, call([bind(session)]))
        assert.strictEqual(bound.status, Status.OK)
        assert.deepStrictEqual(bound.operations[0]!.value, { session, direction: 1, rdma: false })
        const foreOnly = yield* run(handler, call([bindDirection(1)]))
        assert.deepStrictEqual(foreOnly.operations[0]!.value, { session, direction: 1, rdma: false })
        const combined = yield* run(handler, call([sequence(session, 1), bind(session)]))
        assert.deepStrictEqual(combined.operations[1], {
          code: Operation.BIND_CONN_TO_SESSION,
          status: Status.NOT_ONLY_OP
        })

        const followed = yield* run(
          handler,
          call([bind(session), (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)])
        )

        assert.deepStrictEqual(followed.operations, [{
          code: Operation.BIND_CONN_TO_SESSION,
          status: Status.NOT_ONLY_OP
        }])

        // A back-channel binding is a change this server cannot make (INVAL); 4 is not a direction.
        for (const direction of [2, 7]) {
          const back = yield* run(handler, call([bindDirection(direction)]))
          assert.deepStrictEqual(back.operations, [{ code: Operation.BIND_CONN_TO_SESSION, status: Status.INVAL }])
        }

        const badDirection = yield* run(handler, call([bindDirection(4)]))
        assert.deepStrictEqual(badDirection.operations, [{
          code: Operation.BIND_CONN_TO_SESSION,
          status: Status.BADXDR
        }])

        const backchannelCtl =
          (flavors: (writer: EncoderSession) => Effect.Effect<void, XdrEncodeError>) => (writer: EncoderSession) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.BACKCHANNEL_CTL)
              yield* writer.write(XdrCodec.uint32, 0x4000_0001)
              yield* flavors(writer)
            })

        const authSys = (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, 1)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.string(), "probe")
            yield* writer.write(XdrCodec.uint32, 501)
            yield* writer.write(XdrCodec.uint32, 20)
            yield* writer.write(XdrCodec.array(XdrCodec.uint32), [])
          })

        const gss = (writer: EncoderSession) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, 6)
            yield* writer.write(XdrCodec.uint32, 0)
            yield* writer.write(XdrCodec.opaque(), new Uint8Array([1]))
            yield* writer.write(XdrCodec.opaque(), new Uint8Array([2]))
          })

        const backchannel = yield* run(
          handler,
          call([
            sequence(session, 2),
            backchannelCtl((writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, 2)
                yield* writer.write(XdrCodec.uint32, 0)
                yield* authSys(writer)
              })
            )
          ])
        )

        // This session negotiated no backchannel, so there is no callback program to replace.
        // NFS4ERR_INVAL is listed for BACKCHANNEL_CTL in the Section 15.2 table.
        assert.deepStrictEqual(backchannel.operations[1], { code: Operation.BACKCHANNEL_CTL, status: Status.INVAL })
        assert.strictEqual(backchannel.operations.length, 2)

        // Section 18.33.3: an RPCSEC_GSS handle this server never issued is NOENT.
        const gssHandle = yield* run(
          handler,
          call([
            sequence(session, 3),
            backchannelCtl((writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, 1)
                yield* gss(writer)
              })
            )
          ])
        )

        assert.deepStrictEqual(gssHandle.operations[1], { code: Operation.BACKCHANNEL_CTL, status: Status.NOENT })

        const withoutSession = yield* run(
          handler,
          call([backchannelCtl((writer) => writer.write(XdrCodec.array(XdrCodec.uint32), []))])
        )

        assert.deepStrictEqual(withoutSession.operations, [{
          code: Operation.BACKCHANNEL_CTL,
          status: Status.OP_NOT_IN_SESSION
        }])

        const badFlavor = yield* run(
          handler,
          call([
            sequence(session, 4),
            backchannelCtl((writer) => writer.write(XdrCodec.array(XdrCodec.uint32), [9]))
          ])
        )

        assert.deepStrictEqual(badFlavor.operations[1], { code: Operation.BACKCHANNEL_CTL, status: Status.BADXDR })

        // A SEQUENCE after other operations answers SEQUENCE_POS in place; the earlier ones ran.
        const misplaced = yield* run(
          handler,
          call([
            sequence(session, 5),
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
            sequence(session, 6)
          ])
        )

        assert.strictEqual(misplaced.status, Status.SEQUENCE_POS)
        assert.strictEqual(misplaced.operations.length, 3)
        assert.strictEqual(misplaced.operations[1]!.status, Status.OK)
        assert.strictEqual((yield* run(handler, call([sequence(session, 6)]))).status, Status.OK, "slot 5 was consumed")

        const bootstrapPair = yield* run(
          handler,
          call([(writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.DESTROY_SESSION)
              yield* writer.write(XdrCodec.fixedOpaque(session.length), session)
            }), sequence(session, 7)])
        )

        assert.deepStrictEqual(bootstrapPair.operations, [{
          code: Operation.DESTROY_SESSION,
          status: Status.NOT_ONLY_OP
        }])
      }).pipe(Effect.provide(Testing.layer())))
  })
})

describe("Setattr", () => {
  type Attribute = readonly [number, WriteOperation]

  const bitmap = (writer: EncoderSession, attributes: ReadonlyArray<number>) =>
    Effect.gen(function*() {
      const words = Array.from({
        length: attributes.length === 0 ? 0 : Math.floor(Math.max(...attributes) / 32) + 1
      }, () => 0)

      for (const attribute of attributes) words[Math.floor(attribute / 32)]! |= 1 << attribute % 32
      yield* writer.write(XdrCodec.uint32, words.length)

      for (const xdrValue of words) {
        yield* ((item, word) => item.write(XdrCodec.uint32, word >>> 0))(writer, xdrValue)
      }
    })

  const readBitmap = (reader: DecoderSession) =>
    Effect.gen(function*() {
      return (yield* reader.read(XdrCodec.array(XdrCodec.uint32))).flatMap((word, index) =>
        Array.from({
          length: 32
        }, (_, bit) => index * 32 + bit).filter((attribute) => (word & 1 << attribute % 32) !== 0)
      )
    })

  const setattr =
    (attributes: ReadonlyArray<Attribute>, stateid: Uint8Array = new Uint8Array(16)) => (writer: EncoderSession) =>
      Effect.gen(function*() {
        yield* writer.write(XdrCodec.uint32, Operation.SETATTR)
        yield* writer.write(XdrCodec.fixedOpaque(stateid.length), stateid)
        yield* bitmap(writer, attributes.map(([attribute]) => attribute))
        const values = yield* make.openWriter(limits, 4294967295)

        for (const [, write] of attributes) yield* write(values)
        yield* writer.write(XdrCodec.opaque(), yield* values.bytes)
      })

  const setup = Effect.fnUntraced(function*(mapped = false, writable = true, mappedUid = 1000) {
    const caller = yield* Vfs.Caller
    yield* caller.writeFile("/file", new Uint8Array([1, 2]), {
      access: "write",
      create: "exclusive"
    })

    const guest = mapped ?
      yield* Testing.callerAs({
        uid: mappedUid,
        gid: 1000,
        groups: [1001],
        privileged: false
      }) :
      undefined

    if (guest !== undefined) {
      const reference = yield* caller.lookup(Vfs.Entry(yield* caller.root, new TextEncoder().encode("file")))
      yield* caller.chown(reference, {
        uid: 1000,
        gid: 1000
      })
    }

    const overrides: HandlerOverrides = { writable }

    const { client, handler, session } = yield* openSession(
      caller,
      "setattr-client",
      guest === undefined ? overrides : { ...overrides, callerFor: () => Effect.succeed(guest) }
    )

    return {
      caller,
      client,
      handler,
      session
    }
  })

  const run = (
    handler: Nfs4Handler,
    session: Uint8Array,
    seq: number,
    attributes: ReadonlyArray<Attribute>,
    stateid?: Uint8Array
  ) =>
    Effect.gen(function*() {
      return yield* handler.compound(
        yield* call([sequence(session, seq), (writer) =>
          writer.write(XdrCodec.uint32, Operation.PUTROOTFH), (writer) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
            yield* writer.write(XdrCodec.string(), "file")
          }), setattr(attributes, stateid)])
      )
    })

  const result = (bytes: Uint8Array) =>
    Effect.gen(function*() {
      const reader = yield* make.openReader(bytes, limits)
      const status = yield* reader.read(XdrCodec.uint32)
      yield* reader.read(XdrCodec.string())
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), 4)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.SEQUENCE)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
      yield* reader.read(XdrCodec.fixedOpaque(16))

      for (let field = 0; field < 5; field++) yield* reader.read(XdrCodec.uint32)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.PUTROOTFH)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.LOOKUP)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.SETATTR)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), status)
      const attrsset = yield* readBitmap(reader)
      yield* reader.finish

      return {
        status,
        attrsset
      }
    })

  const readOwners = (bytes: Uint8Array) =>
    Effect.gen(function*() {
      const reader = yield* make.openReader(bytes, limits)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
      yield* reader.read(XdrCodec.string())
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), 4)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.SEQUENCE)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
      yield* reader.read(XdrCodec.fixedOpaque(16))

      for (let field = 0; field < 5; field++) yield* reader.read(XdrCodec.uint32)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.PUTROOTFH)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.LOOKUP)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.GETATTR)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
      assert.deepStrictEqual(yield* readBitmap(reader), [36, 37])
      const values = yield* make.openReader(yield* reader.read(XdrCodec.opaque()), limits)
      const owners = [yield* values.read(XdrCodec.string()), yield* values.read(XdrCodec.string())]
      yield* values.finish
      yield* reader.finish

      return owners
    })

  // A client whose every stat of the file lets another client chown it first, `races` times, so the chown lands
  // between the metadata SETATTR observes and the change it makes. Each racing chown moves the owner to a new uid.
  const racingSetup = Effect.fnUntraced(function*(races: number) {
    const caller = yield* Vfs.Caller
    yield* caller.writeFile("/file", new Uint8Array([1, 2]), { access: "write", create: "exclusive" })
    yield* caller.chown("/file", { uid: 1000, gid: 1000 })
    yield* caller.chmod("/file", 0o755)
    let raced = 0

    const racing: Vfs.Caller = {
      ...caller,
      stat: (target) =>
        Effect.tap(caller.stat(target), (metadata) =>
          metadata.kind === "file" && raced < races
            ? caller.chown("/file", { uid: 2000 + raced++ })
            : Effect.void)
    }

    const { handler, session } = yield* openSession(caller, "setattr-client", {
      writable: true,
      callerFor: () => Effect.succeed(racing)
    })

    return { caller, handler, session, raced: () => raced }
  })

  it.layer(NodeCrypto.layer)("NFS SETATTR", (it) => {
    it.effect("should distinguish read-only attributes from unsupported attributes when SETATTR requests read-only or unsupported fields", () =>
      Effect.gen(function*() {
        const {
          handler,
          session
        } = yield* setup()

        assert.deepStrictEqual(
          yield* result(yield* run(handler, session, 1, [[1, (writer) => writer.write(XdrCodec.uint32, 1)]])),
          {
            status: Status.INVAL,
            attrsset: []
          }
        )
        assert.deepStrictEqual(
          yield* result(yield* run(handler, session, 2, [[63, (writer) => writer.write(XdrCodec.uint32, 1)]])),
          {
            status: Status.ATTRNOTSUPP,
            attrsset: []
          }
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should report mode and owner attributes applied through the mapped caller when a mapped caller sets mode and owner", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup()

        const changed = yield* result(
          yield* run(handler, session, 1, [[33, (writer) => writer.write(XdrCodec.uint32, 0o640)], [
            36,
            (writer) => writer.write(XdrCodec.string(), "4294967295")
          ], [37, (writer) => writer.write(XdrCodec.string(), "0")]])
        )

        assert.deepStrictEqual(changed, {
          status: Status.OK,
          attrsset: [33, 36, 37]
        })
        assert.deepInclude(yield* caller.stat("/file"), {
          mode: 0o640,
          uid: 4294967295,
          gid: 0
        })
        assert.deepStrictEqual(
          yield* readOwners(
            yield* handler.compound(
              yield* call([
                sequence(session, 2),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                    yield* writer.write(XdrCodec.string(), "file")
                  }),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.GETATTR)
                    yield* writer.write(XdrCodec.uint32, [0, 1 << 4 | 1 << 5].length)

                    for (const xdrValue of [0, 1 << 4 | 1 << 5]) {
                      yield* ((item, word) => item.write(XdrCodec.uint32, word))(writer, xdrValue)
                    }
                  })
              ])
            )
          ),
          ["4294967295", "0"]
        )
        assert.deepStrictEqual(
          yield* result(
            yield* run(handler, session, 3, [[36, (writer) => writer.write(XdrCodec.string(), "0")], [
              37,
              (writer) => writer.write(XdrCodec.string(), "4294967295")
            ]])
          ),
          {
            status: Status.OK,
            attrsset: [36, 37]
          }
        )
        assert.deepInclude(yield* caller.stat("/file"), {
          uid: 0,
          gid: 4294967295
        })
        assert.deepStrictEqual(
          yield* readOwners(
            yield* handler.compound(
              yield* call([
                sequence(session, 4),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                    yield* writer.write(XdrCodec.string(), "file")
                  }),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.GETATTR)
                    yield* writer.write(XdrCodec.uint32, [0, 1 << 4 | 1 << 5].length)

                    for (const xdrValue of [0, 1 << 4 | 1 << 5]) {
                      yield* ((item, word) => item.write(XdrCodec.uint32, word))(writer, xdrValue)
                    }
                  })
              ])
            )
          ),
          ["0", "4294967295"]
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should reject noncanonical owner strings without changing ownership when an owner string is noncanonical", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup()

        const original = yield* caller.stat("/file")

        const invalid = [
          "",
          "00",
          "+1",
          "-1",
          " 1",
          "1 ",
          "1.0",
          "1e2",
          "alice",
          "alice@example.com",
          "4294967296",
          "999999999999999999999999999999999999"
        ]

        let seq = 1

        for (const value of invalid) {
          for (const attribute of [36, 37]) {
            const changed = yield* result(
              yield* run(handler, session, seq++, [[attribute, (writer) => writer.write(XdrCodec.string(), value)]])
            )

            assert.deepStrictEqual(changed, {
              status: Status.BADOWNER,
              attrsset: []
            })
          }
        }

        assert.strictEqual((yield* caller.stat("/file")).uid, original.uid)
        assert.strictEqual((yield* caller.stat("/file")).gid, original.gid)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should reject malformed timestamp selectors and nanoseconds before mutation when a timestamp selector or nanosecond value is malformed", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup()

        const original = yield* caller.stat("/file")

        for (const attribute of [48, 54]) {
          for (
            const [index, write] of [
              (writer: EncoderSession) => writer.write(XdrCodec.uint32, 2),
              (writer: EncoderSession) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, 1)
                  yield* writer.write(XdrCodec.uint64, 1n)
                  yield* writer.write(XdrCodec.uint32, 1_000_000_000)
                })
            ].entries()
          ) {
            const response = yield* run(handler, session, (attribute === 48 ? 0 : 2) + index + 1, [[attribute, write]])
            assert.strictEqual(yield* (yield* make.openReader(response, limits)).read(XdrCodec.uint32), Status.BADXDR)
          }
        }

        assert.deepInclude(yield* caller.stat("/file"), {
          atimeNs: original.atimeNs,
          mtimeNs: original.mtimeNs
        })
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should map explicit and server-time timestamp setters to the correct metadata fields when explicit or server-time timestamps are requested", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup()

        assert.deepStrictEqual(
          yield* result(
            yield* run(handler, session, 1, [[48, (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, 1)
                yield* writer.write(XdrCodec.uint64, 12n)
                yield* writer.write(XdrCodec.uint32, 345)
              })], [54, (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, 1)
                yield* writer.write(XdrCodec.uint64, 34n)
                yield* writer.write(XdrCodec.uint32, 567)
              })]])
          ),
          {
            status: Status.OK,
            attrsset: [48, 54]
          }
        )
        assert.deepInclude(yield* caller.stat("/file"), {
          atimeNs: 12_000_000_345n,
          mtimeNs: 34_000_000_567n
        })
        assert.deepStrictEqual(
          yield* result(yield* run(handler, session, 2, [[48, (writer) => writer.write(XdrCodec.uint32, 0)]])),
          {
            status: Status.OK,
            attrsset: [48]
          }
        )
        const after = yield* caller.stat("/file")
        assert.notStrictEqual(after.atimeNs, 12_000_000_345n)
        assert.strictEqual(after.mtimeNs, 34_000_000_567n)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should let a mapped non-owner writer set both timestamps to server time when a mapped non-owner writer requests server time", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup(true)

        const reference = yield* caller.lookup(Vfs.Entry(yield* caller.root, new TextEncoder().encode("file")))
        yield* caller.chown(reference, {
          uid: 2000,
          gid: 2000
        })
        yield* caller.chmod(reference, 0o666)
        assert.deepStrictEqual(
          yield* result(
            yield* run(handler, session, 1, [[48, (writer) => writer.write(XdrCodec.uint32, 0)], [
              54,
              (writer) => writer.write(XdrCodec.uint32, 0)
            ]])
          ),
          {
            status: Status.OK,
            attrsset: [48, 54]
          }
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should require a writable open stateid for size and refuse conflicting share denial when size changes lack a writable stateid or conflict with share denial", () =>
      Effect.gen(function*() {
        const {
          caller,
          client,
          handler,
          session
        } = yield* setup()

        const size = [[4, (writer: EncoderSession) => writer.write(XdrCodec.uint64, 5n)]] as const
        assert.deepStrictEqual(yield* result(yield* run(handler, session, 1, size)), {
          status: Status.BAD_STATEID,
          attrsset: []
        })

        const opened = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(session, 2),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openByName(client, "file", 2),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        assert.deepStrictEqual(yield* result(yield* run(handler, session, 3, size, opened.stateid)), {
          status: Status.OK,
          attrsset: [4]
        })
        assert.strictEqual((yield* caller.stat("/file")).size, 5n)
        const invalid = new Uint8Array(opened.stateid)
        invalid[15] = invalid[15]! ^ 1
        assert.deepStrictEqual(
          yield* result(yield* run(handler, session, 4, [[4, (writer) => writer.write(XdrCodec.uint64, 6n)]], invalid)),
          {
            status: Status.BAD_STATEID,
            attrsset: []
          }
        )
        assert.strictEqual((yield* caller.stat("/file")).size, 5n)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should refuse size changes while a write-denying open exists when another OPEN denies writes", () =>
      Effect.gen(function*() {
        const {
          caller,
          client,
          handler,
          session
        } = yield* setup()

        const opened = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openByName(client, "file", 2, 2),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        assert.deepStrictEqual(
          yield* result(
            yield* run(handler, session, 2, [[4, (writer) => writer.write(XdrCodec.uint64, 5n)]], opened.stateid)
          ),
          {
            status: Status.SHARE_DENIED,
            attrsset: []
          }
        )
        assert.strictEqual((yield* caller.stat("/file")).size, 2n)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should apply no attribute and report none when a later ownership change is denied", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup(true)

        const before = yield* caller.stat("/file")

        const changed = yield* result(
          yield* run(handler, session, 1, [[33, (writer) => writer.write(XdrCodec.uint32, 0o640)], [
            36,
            (writer) => writer.write(XdrCodec.string(), "2000")
          ]])
        )

        assert.deepStrictEqual(changed, {
          status: Status.PERM,
          attrsset: []
        })
        assert.deepInclude(yield* caller.stat("/file"), {
          mode: before.mode,
          uid: 1000
        })
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should clear setuid from a mode sent with an owner change, as knfsd does, under one change when mode and owner change together on a file", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup()

        const volume = yield* Vfs.Volume
        const changes = yield* Testing.collectChanges(yield* volume.watch(), 2)
        const before = yield* caller.stat("/file")

        const changed = yield* result(
          yield* run(handler, session, 1, [[33, (writer) => writer.write(XdrCodec.uint32, 0o6745)], [
            36,
            (writer) => writer.write(XdrCodec.string(), "7")
          ], [37, (writer) => writer.write(XdrCodec.string(), "7")]])
        )

        yield* caller.mkdir("/done")

        assert.deepStrictEqual(changed, {
          status: Status.OK,
          attrsset: [33, 36, 37]
        })
        // Without group execute, setgid marks mandatory locking rather than privilege, and knfsd keeps it.
        assert.deepInclude(yield* caller.stat("/file"), {
          mode: 0o2745,
          uid: 7,
          gid: 7,
          revision: before.revision + 1n
        })
        assert.deepStrictEqual((yield* changes).map((change) => change._tag), ["Update", "Create"])
      }).pipe(Effect.scoped, Effect.provide(Testing.layer())))
    it.effect("should clear setgid too from a group-executable mode sent with a group change when group changes with a group-executable mode", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup()

        const changed = yield* result(
          yield* run(handler, session, 1, [[33, (writer) => writer.write(XdrCodec.uint32, 0o6755)], [
            37,
            (writer) => writer.write(XdrCodec.string(), "7")
          ]])
        )

        assert.deepStrictEqual(changed, {
          status: Status.OK,
          attrsset: [33, 37]
        })
        assert.deepInclude(yield* caller.stat("/file"), { mode: 0o755, gid: 7 })
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should keep a set-ID mode sent with an owner change on a directory, as knfsd does when owner changes with set-ID mode on a directory", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup()

        yield* caller.unlink("/file")
        yield* caller.mkdir("/file")

        const changed = yield* result(
          yield* run(handler, session, 1, [[33, (writer) => writer.write(XdrCodec.uint32, 0o2755)], [
            36,
            (writer) => writer.write(XdrCodec.string(), "7")
          ]])
        )

        assert.deepStrictEqual(changed, {
          status: Status.OK,
          attrsset: [33, 36]
        })
        assert.deepInclude(yield* caller.stat("/file"), { mode: 0o2755, uid: 7 })
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should accept an owner re-sending a group it is not a member of when the group is unchanged, as knfsd does", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup(true)

        yield* caller.chown("/file", { gid: 2000 })
        const before = yield* caller.stat("/file")

        assert.deepStrictEqual(
          yield* result(yield* run(handler, session, 1, [[37, (writer) => writer.write(XdrCodec.string(), "2000")]])),
          {
            status: Status.OK,
            attrsset: [37]
          }
        )
        assert.deepInclude(yield* caller.stat("/file"), { gid: 2000, revision: before.revision })
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should refuse an unchanged owner or group when the caller does not own the file", () =>
      Effect.gen(function*() {
        const {
          handler,
          session
        } = yield* setup(true, true, 1002)

        assert.deepStrictEqual(
          yield* result(yield* run(handler, session, 1, [[36, (writer) => writer.write(XdrCodec.string(), "1000")]])),
          {
            status: Status.PERM,
            attrsset: []
          }
        )
        assert.deepStrictEqual(
          yield* result(yield* run(handler, session, 2, [[37, (writer) => writer.write(XdrCodec.string(), "1000")]])),
          {
            status: Status.PERM,
            attrsset: []
          }
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should keep a set-ID mode sent with the owner the file already has, as knfsd does when the owner is resent unchanged with set-ID mode", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup(true)

        const changed = yield* result(
          yield* run(handler, session, 1, [[33, (writer) => writer.write(XdrCodec.uint32, 0o4755)], [
            36,
            (writer) => writer.write(XdrCodec.string(), "1000")
          ]])
        )

        assert.deepStrictEqual(changed, {
          status: Status.OK,
          attrsset: [33, 36]
        })
        assert.deepInclude(yield* caller.stat("/file"), { mode: 0o4755, uid: 1000 })
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should clear set-ID bits when the group changes even though the owner sent is unchanged", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup(true)

        const changed = yield* result(
          yield* run(handler, session, 1, [
            [33, (writer) => writer.write(XdrCodec.uint32, 0o6755)],
            [36, (writer) => writer.write(XdrCodec.string(), "1000")],
            [37, (writer) => writer.write(XdrCodec.string(), "1001")]
          ])
        )

        assert.deepStrictEqual(changed, {
          status: Status.OK,
          attrsset: [33, 36, 37]
        })
        assert.deepInclude(yield* caller.stat("/file"), { mode: 0o755, uid: 1000, gid: 1001 })
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should let an owner select a supplementary group but reject another group when an owner selects a supplementary or foreign group", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup(true)

        assert.deepStrictEqual(
          yield* result(yield* run(handler, session, 1, [[37, (writer) => writer.write(XdrCodec.string(), "1000")]])),
          {
            status: Status.OK,
            attrsset: [37]
          }
        )
        assert.deepStrictEqual(
          yield* result(yield* run(handler, session, 2, [[37, (writer) => writer.write(XdrCodec.string(), "1001")]])),
          {
            status: Status.OK,
            attrsset: [37]
          }
        )
        assert.strictEqual((yield* caller.stat("/file")).gid, 1001)
        assert.deepStrictEqual(
          yield* result(yield* run(handler, session, 3, [[37, (writer) => writer.write(XdrCodec.string(), "1002")]])),
          {
            status: Status.PERM,
            attrsset: []
          }
        )
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should refuse a mode change by a caller that does not own the file as not permitted when a non-owner requests a mode change", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup(true, true, 1002)

        const before = (yield* caller.stat("/file")).mode

        assert.deepStrictEqual(
          yield* result(yield* run(handler, session, 1, [[33, (writer) => writer.write(XdrCodec.uint32, 0o600)]])),
          {
            status: Status.PERM,
            attrsset: []
          }
        )
        assert.strictEqual((yield* caller.stat("/file")).mode, before)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should refuse explicit timestamps from a caller that does not own the file as not permitted when a non-owner requests explicit timestamps", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup(true, true, 1002)

        const before = (yield* caller.stat("/file")).mtimeNs

        assert.deepStrictEqual(
          yield* result(
            yield* run(handler, session, 1, [[54, (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, 1)
                yield* writer.write(XdrCodec.uint64, 34n)
                yield* writer.write(XdrCodec.uint32, 567)
              })]])
          ),
          {
            status: Status.PERM,
            attrsset: []
          }
        )
        assert.strictEqual((yield* caller.stat("/file")).mtimeNs, before)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should not treat an unprivileged mapped UID zero as the file owner when UID zero is mapped without privilege", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup(true, true, 0)

        assert.deepStrictEqual(
          yield* result(yield* run(handler, session, 1, [[36, (writer) => writer.write(XdrCodec.string(), "0")]])),
          {
            status: Status.PERM,
            attrsset: []
          }
        )
        assert.strictEqual((yield* caller.stat("/file")).uid, 1000)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should keep a read-only export immutable when SETATTR reaches a read-only export", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup(false, false)

        const response = yield* result(
          yield* run(handler, session, 1, [[33, (writer) => writer.write(XdrCodec.uint32, 0o600)]])
        )

        assert.deepStrictEqual(response, {
          status: Status.ROFS,
          attrsset: []
        })
        assert.notStrictEqual((yield* caller.stat("/file")).mode, 0o600)
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should clear setuid when another client changes the owner mid-SETATTR", () =>
      Effect.gen(function*() {
        const { caller, handler, session } = yield* racingSetup(1)

        const changed = yield* result(
          yield* run(handler, session, 1, [[33, (writer) => writer.write(XdrCodec.uint32, 0o4755)], [
            36,
            (writer) => writer.write(XdrCodec.string(), "1000")
          ]])
        )

        assert.deepStrictEqual(changed, { status: Status.OK, attrsset: [33, 36] })
        // The owner moved to 2000 after the first observation, so 1000 is a real change and knfsd clears setuid.
        assert.deepInclude(yield* caller.stat("/file"), { uid: 1000, mode: 0o755 })
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should answer DELAY and apply nothing when the owner keeps moving under SETATTR", () =>
      Effect.gen(function*() {
        const { caller, handler, session, raced } = yield* racingSetup(Number.POSITIVE_INFINITY)

        const changed = yield* result(
          yield* run(handler, session, 1, [[33, (writer) => writer.write(XdrCodec.uint32, 0o4755)], [
            36,
            (writer) => writer.write(XdrCodec.string(), "1000")
          ]])
        )

        assert.deepStrictEqual(changed, { status: Status.DELAY, attrsset: [] })
        // One observation and three re-observations, each overtaken by a chown.
        assert.strictEqual(raced(), 4)
        assert.deepInclude(yield* caller.stat("/file"), { uid: 2003, mode: 0o755 })
      }).pipe(Effect.provide(Testing.layer())))
  })
})

describe("Write", () => {
  const write = (stateid: Uint8Array, bytes: Uint8Array, offset = 0n, stable = 2) => (writer: EncoderSession) =>
    Effect.gen(function*() {
      yield* writer.write(XdrCodec.uint32, Operation.WRITE)
      yield* writer.write(XdrCodec.fixedOpaque(stateid.length), stateid)
      yield* writer.write(XdrCodec.uint64, offset)
      yield* writer.write(XdrCodec.uint32, stable)
      yield* writer.write(XdrCodec.opaque(), bytes)
    })

  const readWriteResult = (bytes: Uint8Array) =>
    Effect.gen(function*() {
      const reader = yield* make.openReader(bytes, limits)
      const status = yield* reader.read(XdrCodec.uint32)
      yield* reader.read(XdrCodec.string())
      yield* reader.read(XdrCodec.uint32)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.SEQUENCE)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
      yield* reader.read(XdrCodec.fixedOpaque(16))

      for (let field = 0; field < 5; field++) yield* reader.read(XdrCodec.uint32)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.PUTFH)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.WRITE)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), status)

      if (status !== Status.OK) {
        return {
          status
        }
      }

      const count = yield* reader.read(XdrCodec.uint32)
      const committed = yield* reader.read(XdrCodec.uint32)
      const verifier = yield* reader.read(XdrCodec.fixedOpaque(8))
      yield* reader.finish

      return {
        status,
        count,
        committed,
        verifier
      }
    })

  const readCommitResult = (bytes: Uint8Array) =>
    Effect.gen(function*() {
      const reader = yield* make.openReader(bytes, limits)
      const status = yield* reader.read(XdrCodec.uint32)
      yield* reader.read(XdrCodec.string())
      yield* reader.read(XdrCodec.uint32)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.SEQUENCE)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
      yield* reader.read(XdrCodec.fixedOpaque(16))

      for (let field = 0; field < 5; field++) yield* reader.read(XdrCodec.uint32)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.PUTFH)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.COMMIT)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), status)

      if (status !== Status.OK) {
        return {
          status
        }
      }

      const verifier = yield* reader.read(XdrCodec.fixedOpaque(8))
      yield* reader.finish

      return {
        status,
        verifier
      }
    })

  it.layer(NodeCrypto.layer)("NFS durable write preparation", (it) => {
    it.effect("should report the committed prefix and replay a lost WRITE reply without writing twice when a WRITE reply is lost after a committed prefix", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume

        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1, 2]), {
          access: "write",
          create: "exclusive"
        })
        const storageGeneration = new Uint8Array(16).fill(9)

        const { handler, client, session } = yield* openSession(caller, "write-prefix", {
          storageGeneration,
          writable: true
        }).pipe(Effect.provideService(Vfs.Volume, volume))

        const opened = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openByName(client, "file", 2),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        const request = yield* call([sequence(session, 2, true), (writer) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
            yield* writer.write(XdrCodec.opaque(), opened.filehandle)
          }), write(opened.stateid, new Uint8Array([3, 4, 5, 6]), 2n, 0)])

        const first = yield* handler.compound(request)
        const result = yield* readWriteResult(first)
        assert.strictEqual(result.status, Status.OK)
        assert.strictEqual(result.count, 2)
        assert.strictEqual(result.committed, 2)
        assert.strictEqual(result.verifier?.length, 8)
        assert.deepStrictEqual(yield* handler.compound(request), first)
        assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([1, 2, 3, 4]))

        const zero = yield* readWriteResult(
          yield* handler.compound(
            yield* call([sequence(session, 3), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                yield* writer.write(XdrCodec.opaque(), opened.filehandle)
              }), write(opened.stateid, new Uint8Array(0), 0n)])
          )
        )

        assert.strictEqual(zero.count, 0)

        const committed = yield* readCommitResult(
          yield* handler.compound(
            yield* call([sequence(session, 4), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                yield* writer.write(XdrCodec.opaque(), opened.filehandle)
              }), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.COMMIT)
                yield* writer.write(XdrCodec.uint64, 0n)
                yield* writer.write(XdrCodec.uint32, 0)
              })])
          )
        )

        assert.deepStrictEqual(committed.verifier, result.verifier)

        const invalid = yield* readWriteResult(
          yield* handler.compound(
            yield* call([sequence(session, 5), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                yield* writer.write(XdrCodec.opaque(), opened.filehandle)
              }), write(new Uint8Array(16), new Uint8Array([8]), 0n)])
          )
        )

        assert.strictEqual(invalid.status, Status.BAD_STATEID)

        const badStability = yield* readWriteResult(
          yield* handler.compound(
            yield* call([sequence(session, 6), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                yield* writer.write(XdrCodec.opaque(), opened.filehandle)
              }), write(opened.stateid, new Uint8Array([8]), 0n, 3)])
          )
        )

        assert.strictEqual(badStability.status, Status.INVAL)
      }).pipe(
        Effect.provide(Testing.layer({ volume: { maxBytes: ByteSize.bytes(4), maxFileBytes: ByteSize.bytes(4) } }))
      ))
    it.effect("should write through the held write handle after either OPEN upgrade order when OPEN upgrades occur in either order", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/read-first", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        yield* caller.writeFile("/write-first", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const { handler, client, session } = yield* openSession(caller, "write-upgrade", {
          writable: true
        }).pipe(Effect.provideService(Vfs.Volume, volume))

        let sequenceId = 1

        for (const [name, firstAccess, secondAccess] of [["read-first", 1, 2], ["write-first", 2, 1]] as const) {
          yield* handler.compound(
            yield* call([
              sequence(session, sequenceId++),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openByName(client, name, firstAccess),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )

          const upgraded = yield* parseOpen(
            yield* handler.compound(
              yield* call([
                sequence(session, sequenceId++),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                openByName(client, name, secondAccess),
                (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
              ])
            )
          )

          const result = yield* readWriteResult(
            yield* handler.compound(
              yield* call([sequence(session, sequenceId++), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                  yield* writer.write(XdrCodec.opaque(), upgraded.filehandle)
                }), write(upgraded.stateid, new Uint8Array([2]), 0n)])
            )
          )

          assert.strictEqual(result.status, Status.OK)
          assert.strictEqual(result.count, 1)
          assert.deepStrictEqual(yield* caller.readFile(`/${name}`), new Uint8Array([2]))
        }
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should reuse the held write handle across downgrade and upgrade cycles when an OPEN downgrades and upgrades repeatedly", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const export_ = yield* exportFor(caller)

        let openedHandles = 0

        const handler = yield* handlerFor({
          ...export_,
          open: (reference, access) => {
            openedHandles++

            return export_.open(reference, access)
          }
        }, { writable: true })

        const {
          client,
          session
        } = yield* startSession(handler, "write-handle-reuse")

        let sequenceId = 1

        let opened = yield* parseOpen(
          yield* handler.compound(
            yield* call([
              sequence(session, sequenceId++),
              (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openByName(client, "file", 3),
              (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
            ])
          )
        )

        for (let cycle = 0; cycle < 3; cycle++) {
          const downgraded = yield* make.openReader(
            yield* handler.compound(
              yield* call([sequence(session, sequenceId++), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                  yield* writer.write(XdrCodec.opaque(), opened.filehandle)
                }), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.OPEN_DOWNGRADE)
                  yield* writer.write(XdrCodec.fixedOpaque(opened.stateid.length), opened.stateid)
                  yield* writer.write(XdrCodec.uint32, 0)
                  yield* writer.write(XdrCodec.uint32, 1)
                  yield* writer.write(XdrCodec.uint32, 0)
                })])
            ),
            limits
          )

          assert.strictEqual(yield* downgraded.read(XdrCodec.uint32), Status.OK)
          opened = yield* parseOpen(
            yield* handler.compound(
              yield* call([
                sequence(session, sequenceId++),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                openByName(client, "file", 2),
                (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
              ])
            )
          )

          const result = yield* readWriteResult(
            yield* handler.compound(
              yield* call([sequence(session, sequenceId++), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                  yield* writer.write(XdrCodec.opaque(), opened.filehandle)
                }), write(opened.stateid, new Uint8Array([cycle + 2]), 0n)])
            )
          )

          assert.strictEqual(result.status, Status.OK)
        }

        assert.strictEqual(openedHandles, 1)
        assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([4]))
      }).pipe(Effect.provide(Testing.layer())))
    it.effect("should return IO without publishing bytes when storage rejects the write", () =>
      Effect.gen(function*() {
        let reject = false

        const store = Layer.succeed(
          LiveVolume.LiveImageStore,
          LiveVolume.LiveImageStore.of({
            loadOrCreate: (initial) => Effect.succeed(initial),
            commit: () => Effect.succeed(reject ? "rejected" as const : "committed" as const)
          })
        )

        return yield* Effect.gen(function*() {
          const volume = yield* LiveVolume.open({
            maxImageBytes: ByteSize.kilobytes(64),
            volume: {
              maxEntries: 16,
              maxBytes: ByteSize.bytes(32),
              maxFileBytes: ByteSize.bytes(32),
              maxPathBytes: ByteSize.bytes(255)
            }
          })

          const caller = yield* volume.caller()
          yield* caller.writeFile("/file", new Uint8Array([1]), {
            access: "write",
            create: "exclusive"
          })

          const { handler, client, session } = yield* openSession(caller, "write-reject", {
            writable: true
          }).pipe(Effect.provideService(Vfs.Volume, volume))

          const opened = yield* parseOpen(
            yield* handler.compound(
              yield* call([
                sequence(session, 1),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                openByName(client, "file", 2),
                (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
              ])
            )
          )

          reject = true

          const result = yield* readWriteResult(
            yield* handler.compound(
              yield* call([sequence(session, 2), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                  yield* writer.write(XdrCodec.opaque(), opened.filehandle)
                }), write(opened.stateid, new Uint8Array([2]), 0n)])
            )
          )

          assert.strictEqual(result.status, Status.IO)
          reject = false
          assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([1]))
        }).pipe(Effect.provide(store))
      }))
    it.effect("should hold the WRITE reply until the store confirms the commit when the store has not confirmed the WRITE commit", () =>
      Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let hold = false

        const store = Layer.succeed(
          LiveVolume.LiveImageStore,
          LiveVolume.LiveImageStore.of({
            loadOrCreate: (initial) => Effect.succeed(initial),
            commit: () =>
              hold ?
                Effect.gen(function*() {
                  yield* Deferred.succeed(started, undefined)
                  yield* Deferred.await(release)

                  return "committed" as const
                }) :
                Effect.succeed("committed" as const)
          })
        )

        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open({
            maxImageBytes: ByteSize.kilobytes(64),
            volume: {
              maxEntries: 16,
              maxBytes: ByteSize.bytes(32),
              maxFileBytes: ByteSize.bytes(32),
              maxPathBytes: ByteSize.bytes(255)
            }
          })

          const caller = yield* volume.caller()
          yield* caller.writeFile("/file", new Uint8Array([1]), {
            access: "write",
            create: "exclusive"
          })

          const { handler, client, session } = yield* openSession(caller, "write-commit-order", {
            writable: true
          }).pipe(Effect.provideService(Vfs.Volume, volume))

          const opened = yield* parseOpen(
            yield* handler.compound(
              yield* call([
                sequence(session, 1),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                openByName(client, "file", 2),
                (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
              ])
            )
          )

          hold = true

          const reply = yield* handler.compound(
            yield* call([sequence(session, 2), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                yield* writer.write(XdrCodec.opaque(), opened.filehandle)
              }), write(opened.stateid, new Uint8Array([2]), 0n)])
          ).pipe(Effect.forkChild({
            startImmediately: true
          }))

          yield* Deferred.await(started)
          assert.strictEqual(reply.pollUnsafe(), undefined)
          yield* Deferred.succeed(release, undefined)
          const result = yield* readWriteResult(yield* Fiber.join(reply))
          assert.strictEqual(result.status, Status.OK)
          assert.strictEqual(result.committed, 2)
          assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([2]))
        })).pipe(Effect.provide(store))
      }))
    it.effect("should return no success after an unknown storage outcome and stop COMMIT when the store reports an unknown outcome", () =>
      Effect.gen(function*() {
        let unknown = false

        const store = Layer.succeed(
          LiveVolume.LiveImageStore,
          LiveVolume.LiveImageStore.of({
            loadOrCreate: (initial) => Effect.succeed(initial),
            commit: () => Effect.succeed(unknown ? "unknown" as const : "committed" as const)
          })
        )

        return yield* Effect.gen(function*() {
          const volume = yield* LiveVolume.open({
            maxImageBytes: ByteSize.kilobytes(64),
            volume: {
              maxEntries: 16,
              maxBytes: ByteSize.bytes(32),
              maxFileBytes: ByteSize.bytes(32),
              maxPathBytes: ByteSize.bytes(255)
            }
          })

          const caller = yield* volume.caller()
          yield* caller.writeFile("/file", new Uint8Array([1]), {
            access: "write",
            create: "exclusive"
          })

          const { handler, client, session } = yield* openSession(caller, "write-unknown", {
            writable: true
          }).pipe(Effect.provideService(Vfs.Volume, volume))

          const opened = yield* parseOpen(
            yield* handler.compound(
              yield* call([
                sequence(session, 1),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                openByName(client, "file", 2),
                (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
              ])
            )
          )

          unknown = true

          const result = yield* readWriteResult(
            yield* handler.compound(
              yield* call([sequence(session, 2), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                  yield* writer.write(XdrCodec.opaque(), opened.filehandle)
                }), write(opened.stateid, new Uint8Array([2]), 0n)])
            )
          )

          assert.strictEqual(result.status, Status.IO)

          const next = yield* make.openReader(
            yield* handler.compound(
              yield* call([sequence(session, 3), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                  yield* writer.write(XdrCodec.opaque(), opened.filehandle)
                }), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, Operation.COMMIT)
                  yield* writer.write(XdrCodec.uint64, 0n)
                  yield* writer.write(XdrCodec.uint32, 0)
                })])
            ),
            limits
          )

          assert.strictEqual(yield* next.read(XdrCodec.uint32), Status.SERVERFAULT)
          yield* next.read(XdrCodec.string())
          assert.strictEqual(yield* next.read(XdrCodec.uint32), 2)
          assert.strictEqual(yield* next.read(XdrCodec.uint32), Operation.SEQUENCE)
          assert.strictEqual(yield* next.read(XdrCodec.uint32), Status.OK)
          yield* next.read(XdrCodec.fixedOpaque(16))

          for (let field = 0; field < 5; field++) yield* next.read(XdrCodec.uint32)
          assert.strictEqual(yield* next.read(XdrCodec.uint32), Operation.PUTFH)
          assert.strictEqual(yield* next.read(XdrCodec.uint32), Status.SERVERFAULT)
          assert.strictEqual((yield* Effect.flip(volume.usage)).code, "VolumeUnavailable")
        }).pipe(Effect.provide(store))
      }))
  })
})

describe("Error mapping", () => {
  const expected = {
    NotFound: Status.NOENT,
    AlreadyExists: Status.EXIST,
    NotEmpty: Status.NOTEMPTY,
    NotDirectory: Status.NOTDIR,
    AccessDenied: Status.ACCESS,
    NotPermitted: Status.PERM,
    InvalidHandle: Status.SERVERFAULT,
    ForeignHandle: Status.SERVERFAULT,
    InvalidReference: Status.SERVERFAULT,
    ForeignReference: Status.SERVERFAULT,
    StaleReference: Status.STALE,
    ClosedCaller: Status.SERVERFAULT,
    InvalidArgument: Status.INVAL,
    InvalidPathEncoding: Status.INVAL,
    PathTooLong: Status.NAMETOOLONG,
    NoSpace: Status.NOSPC,
    IsDirectory: Status.ISDIR,
    FileTooLarge: Status.FBIG,
    NoData: Status.SERVERFAULT,
    StorageRejected: Status.IO,
    OutcomeUnknown: Status.IO,
    VolumeUnavailable: Status.IO,
    VolumeBusy: Status.DELAY,
    SymlinkLoop: Status.INVAL,
    UnrepresentableName: Status.INVAL,
    InvalidEncoding: Status.SERVERFAULT,
    UnsupportedVersion: Status.SERVERFAULT,
    InvalidStructure: Status.SERVERFAULT,
    LimitExceeded: Status.SERVERFAULT,
    BaseMismatch: Status.SERVERFAULT,
    Storage: Status.IO,
    Ownership: Status.IO,
    IncompatibleStore: Status.IO,
    CorruptStore: Status.IO
  } satisfies Readonly<Record<Vfs.VfsCode, number>>

  it("should translate every core filesystem failure to an NFSv4.1 status when a core filesystem error reaches the NFS boundary", () => {
    for (const [code, status] of Object.entries(expected)) {
      // SAFETY: expected has exactly the FsCode keys by its Record type.
      const fsCode = code as Vfs.VfsCode

      assert.strictEqual(
        failureForFs(new Vfs.VfsError({ code: fsCode, operation: "test" }), Operation.SETATTR),
        status,
        code
      )
    }
  })

  it("should return SERVERFAULT for an unexpected runtime error code when a runtime error code is unknown", () => {
    for (const code of ["FutureCode", "toString"]) {
      // The constructor validates its code, so an unknown runtime code is forced onto a valid error afterwards.
      const error = Object.assign(new Vfs.VfsError({ code: "NotFound", operation: "test" }), { code })

      assert.strictEqual(failureForFs(error, Operation.SETATTR), Status.SERVERFAULT, code)
    }
  })

  it("should answer NotPermitted as PERM only for the operations whose RFC 8881 Section 15.2 list has it when NotPermitted reaches an operation whose RFC error list differs", () => {
    const error = new Vfs.VfsError({ code: "NotPermitted", operation: "test" })

    const statuses = Object.fromEntries(
      (["CREATE", "OPEN", "SETATTR", "REMOVE", "RENAME", "LINK", "WRITE"] as const).map((name) => [
        name,
        failureForFs(error, Operation[name])
      ])
    )

    assert.deepStrictEqual(statuses, {
      CREATE: Status.PERM,
      OPEN: Status.PERM,
      SETATTR: Status.PERM,
      REMOVE: Status.ACCESS,
      RENAME: Status.ACCESS,
      LINK: Status.ACCESS,
      WRITE: Status.ACCESS
    })
  })
})
