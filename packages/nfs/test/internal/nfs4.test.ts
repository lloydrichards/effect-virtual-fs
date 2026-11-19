import { LiveVolume, Testing, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, it, live as liveTest } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Layer, Option, Result, type Scope } from "effect"
import * as ByteSize from "effect/ByteSize"
import type * as Digest from "effect/crypto/Digest"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import type * as Duration from "effect/Duration"
import * as Predicate from "effect/Predicate"
import { describe } from "vitest"
import { failureForFs, nextSequenceId, Operation, Status } from "../../src/internal/nfs4.js"
import type { Credentials } from "../../src/internal/rpc.js"
import {
  type DecoderSession,
  type EncoderSession,
  make,
  XdrCodec,
  type XdrEncodeError
} from "../../src/internal/xdr.js"
import {
  call,
  callbackProgram,
  channel,
  connection,
  exchangeId,
  exportFor,
  handlerFor,
  limits,
  makeHandler,
  openByName,
  openReadOnly,
  openSession,
  parseOpen,
  sequence,
  startSession,
  statuses,
  type WriteOperation
} from "../support/harness.js"

describe("Backchannel", () => {
  const live = <E>(
    name: string,
    body: () => Effect.Effect<void, E, Digest.Digest | SecureRandom.SecureRandom | Scope.Scope>,
    timeout?: number
  ) => liveTest(name, () => body().pipe(Effect.provide(NodeCrypto.layer)), timeout)

  it.layer(NodeCrypto.layer)("NFSv4.1 Backchannel", (it) => {
    const backChannelHandler = (callbackTimeout: Duration.Input) =>
      Effect.flatMap(Vfs.Caller, (caller) => makeHandler(caller, { callbackTimeout }))

    /**
     * An RPC accepted-reply carrying an all-OK CB_SEQUENCE result, echoing the session, sequence and
     * slot it was sent, exactly as a working client answers.
     */
    const callbackReplyFor = Effect.fnUntraced(function*(request: Uint8Array, session: Uint8Array) {
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
            send: Effect.fnUntraced(function*(message: Uint8Array) {
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
            }, Effect.orDie)
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
    const oversizedAuthSys = Effect.fnUntraced(function*(writer: EncoderSession) {
      yield* writer.write(XdrCodec.uint32, 1)
      yield* writer.write(XdrCodec.uint32, 0)
      yield* writer.write(XdrCodec.string(), "m".repeat(500))
      yield* writer.write(XdrCodec.uint32, 0)
      yield* writer.write(XdrCodec.uint32, 0)
      yield* writer.write(XdrCodec.uint32, 0)
    })

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
          send: Effect.fnUntraced(function*(message: Uint8Array) {
            const reader = yield* make.openReader(message, limits)

            for (let field = 0; field < 3; field++) yield* reader.read(XdrCodec.uint32)
            program = yield* reader.read(XdrCodec.uint32)

            return true
          }, Effect.orDie)
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
          const malformed = Effect.fnUntraced(
            function*(request: Uint8Array, results: number, defect: "truncated" | "complete" | "trailing") {
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
            }
          )

          const probeWith = Effect.fnUntraced(
            function*(build: (request: Uint8Array) => Effect.Effect<Uint8Array, XdrEncodeError>) {
              sent = undefined
              const probe = yield* Effect.forkChild(handler.probeBackChannel(session))
              yield* Effect.yieldNow
              assert.isDefined(sent)
              yield* handler.callbackReply(client, yield* build(sent))

              return yield* Fiber.join(probe)
            }
          )

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

        const check = Effect.fnUntraced(function*(session: Uint8Array, on: typeof ownerConnection, uid: number) {
          return yield* handler.compound(
            yield* call(
              [
                sequence(session, 1, true),
                (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                    yield* writer.write(XdrCodec.string(), "secret")
                  }),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(XdrCodec.uint32, Operation.ACCESS)
                    yield* writer.write(XdrCodec.uint32, 1)
                  })
              ],
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
    it("should wrap client sequence IDs at the uint32 boundary when a client sequence ID reaches the uint32 boundary", () => {
      assert.strictEqual(nextSequenceId(1), 2)
      assert.strictEqual(nextSequenceId(0xffff_ffff), 0)
    })
    it("should use the RFC wire numbers for negotiated channel errors when a negotiated channel violates its limits", () => {
      assert.strictEqual(Status.REQ_TOO_BIG, 10065)
      assert.strictEqual(Status.REP_TOO_BIG, 10066)
      assert.strictEqual(Status.REP_TOO_BIG_TO_CACHE, 10067)
    })
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
  })
})

describe("Create", () => {
  type Attributes = ReadonlyArray<readonly [number, WriteOperation]>

  const writeBitmap = Effect.fnUntraced(function*(writer: EncoderSession, attributes: ReadonlyArray<number>) {
    const words = Array.from({
      length: attributes.length === 0 ? 0 : Math.floor(Math.max(...attributes) / 32) + 1
    }, () => 0)

    for (const attribute of attributes) words[Math.floor(attribute / 32)]! |= 1 << attribute % 32
    yield* writer.write(XdrCodec.uint32, words.length)

    for (const xdrValue of words) {
      yield* ((item, word) => item.write(XdrCodec.uint32, word >>> 0))(writer, xdrValue)
    }
  })

  const readBitmap = Effect.fnUntraced(function*(reader: DecoderSession) {
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

  const responseStatus = Effect.fnUntraced(function*(bytes: Uint8Array) {
    return yield* (yield* make.openReader(bytes, limits)).read(XdrCodec.uint32)
  })

  const afterRoot = Effect.fnUntraced(function*(bytes: Uint8Array) {
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

  const readCreate = Effect.fnUntraced(function*(bytes: Uint8Array) {
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
    it.effect("should close the acquired handle when creation is interrupted during commit", () =>
      Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()

        const store = Layer.succeed(
          LiveVolume.LiveImageStore,
          LiveVolume.LiveImageStore.of({
            loadOrCreate: (initial) => Effect.succeed(initial),
            commit: Effect.fnUntraced(function*() {
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

describe("Lifecycle", () => {
  const live = <E>(
    name: string,
    body: () => Effect.Effect<void, E, Digest.Digest | SecureRandom.SecureRandom | Scope.Scope>,
    timeout?: number
  ) => liveTest(name, () => body().pipe(Effect.provide(NodeCrypto.layer)), timeout)

  it.layer(NodeCrypto.layer)("NFSv4.1 Lifecycle", (_it) => {
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

        const readTime = Effect.fnUntraced(function*() {
          const seconds = yield* values.read(XdrCodec.uint64)
          const nanoseconds = yield* values.read(XdrCodec.uint32)

          return {
            seconds,
            nanoseconds
          }
        })

        const expectTime = Effect.fnUntraced(function*(timestamp: bigint) {
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
  })
})

describe("OpenRead", () => {
  const live = <E>(
    name: string,
    body: () => Effect.Effect<void, E, Digest.Digest | SecureRandom.SecureRandom | Scope.Scope>,
    timeout?: number
  ) => liveTest(name, () => body().pipe(Effect.provide(NodeCrypto.layer)), timeout)

  it.layer(NodeCrypto.layer)("NFSv4.1 OpenRead", (it) => {
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
  })
})

describe("SessionReplay", () => {
  it.layer(NodeCrypto.layer)("NFSv4.1 SessionReplay", (it) => {
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

  const readWriteResult = Effect.fnUntraced(function*(bytes: Uint8Array) {
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

  it.layer(NodeCrypto.layer)("NFS durable write preparation", (it) => {
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
