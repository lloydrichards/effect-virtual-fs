import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, it, live as liveTest } from "@effect/vitest"
import { type Crypto, Deferred, Effect, Exit, Fiber, Option, Scope } from "effect"
import * as ByteSize from "effect/ByteSize"
import type * as Duration from "effect/Duration"
import * as Predicate from "effect/Predicate"
import * as TestClock from "effect/testing/TestClock"
import { makeExport } from "../src/internal/export.js"
import { makeNfs4Handler, nextSequenceId, Operation, Status } from "../src/internal/nfs4.js"
import type { Credentials } from "../src/internal/rpc.js"
import { type EncoderSession, make, XdrCodec, type XdrEncodeError } from "../src/internal/xdr.js"

const live = <E>(name: string, body: () => Effect.Effect<void, E, Crypto.Crypto | Scope.Scope>, timeout?: number) =>
  liveTest(name, () => body().pipe(Effect.provide(NodeCrypto.layer)), timeout)

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
  statuses,
  type WriteOperation
} from "./support/harness.js"

it.layer(NodeCrypto.layer)("NFSv4.1 COMPOUND", (it) => {
  it.effect("reports writable directory access for an authorized mapped caller", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits,
          writable: true,
          callerFor: () => Effect.succeed(caller)
        }
      )

      const { session } = yield* startSession(handler, "writable-access")

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
    }))

  it.effect("uses the mapped caller for ACCESS and OPEN", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()

      const admin = yield* volume.caller({
        umask: 0
      })

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

      const owner = yield* volume.caller({
        identity: {
          uid: 1000,
          gid: 1000,
          groups: [],
          privileged: false
        }
      })

      const guest = yield* volume.caller({
        identity: {
          uid: 2000,
          gid: 2000,
          groups: [],
          privileged: false
        }
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

      const handler = yield* makeNfs4Handler(
        makeExport(admin, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits,
          securityFlavors: [1],
          callerFor: (request) =>
            Effect.succeed(
              Predicate.isTagged(request.credentials, "Sys") && request.credentials.uid === 1000 && !downgradeOwner
                ? owner
                : guest
            )
        }
      )

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
              [sequence(session, 1, true), (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH), (writer) =>
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
    }))
  it.effect("uses both storage incarnation and server generation for COMMIT", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })
      const verifiers: Array<Uint8Array> = []

      for (const [serverByte, storageByte] of [[7, 9], [8, 9], [6, 8]] as const) {
        const serverGeneration = generation.map(() => serverByte)
        const storageGeneration = generation.map(() => storageByte)

        const handler = yield* makeNfs4Handler(
          makeExport(caller, storageGeneration, {
            maxFilehandles: 16,
            maxNameBytes: ByteSize.bytes(255)
          }),
          {
            leaseDurationSeconds: 30,
            callbackTimeout: "1 second",
            generation: serverGeneration,
            storageGeneration,
            now: () => 0,
            limits
          }
        )

        const {
          session
        } = yield* startSession(handler, "commit-storage-generation")

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
    }))
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

      const export_ = makeExport(caller, generation, {
        maxFilehandles: 16,
        maxNameBytes: ByteSize.bytes(255)
      })

      const handler = yield* makeNfs4Handler(export_, {
        leaseDurationSeconds: 30,
        callbackTimeout: "1 second",
        generation,
        now: () => 0,
        limits
      })

      const {
        session
      } = yield* startSession(handler, "missing-client")

      const response = yield* handler.compound(
        yield* call([sequence(session, 1), (writer) =>
          writer.write(XdrCodec.uint32, Operation.PUTROOTFH), (writer) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
            yield* writer.write(XdrCodec.string(), "missing")
          }), (writer) =>
          writer.write(XdrCodec.uint32, Operation.GETFH)], "missing-probe")
      )

      assert.deepStrictEqual(yield* statuses(response), {
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
        entries: [{
          kind: "file",
          path: "/child",
          bytes: new Uint8Array([1])
        }]
      })

      const caller = yield* volume.caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      )

      const {
        session
      } = yield* startSession(handler, "saved-filehandle")

      const response = yield* handler.compound(
        yield* call([sequence(session, 1), (writer) =>
          writer.write(XdrCodec.uint32, Operation.PUTROOTFH), (writer) =>
          writer.write(XdrCodec.uint32, Operation.SAVEFH), (writer) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
            yield* writer.write(XdrCodec.string(), "child")
          }), (writer) =>
          writer.write(XdrCodec.uint32, Operation.RESTOREFH), (writer) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
            yield* writer.write(XdrCodec.string(), "child")
          })])
      )

      assert.strictEqual((yield* statuses(response)).status, Status.OK)
    }))
  it.effect("advertises the client ID as a non-pNFS implementation", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      )

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
    }))
  it.effect("marks a repeated EXCHANGE_ID after CREATE_SESSION as confirmed", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      )

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
    }))
  it.effect("applies confirmed-record EXCHANGE_ID update rules", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      )

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
    }))
  it.effect("rejects EXCHANGE_ID argument flags that are not valid for clients", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const constrained = {
        ...limits,
        maxClients: 1
      }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits: constrained
        }
      )

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
    }))
  it.effect("accepts the AUTH_SYS callback credential sent by macOS", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      )

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
    }))
  it.effect("negotiates and enforces full RPC record bounds", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const constrained = {
        ...limits,
        maxRecordBytes: ByteSize.bytes(2_048)
      }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits: constrained
        }
      )

      const exchange = yield* make.openReader(yield* handler.compound(yield* call([exchangeId("rpc-bounds")])), limits)
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
    }))
  it.effect("returns BADXDR before a malformed read-only mutation can report ROFS", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      )

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

      const write = yield* call([sequence(session, 1), (writer) =>
        writer.write(XdrCodec.uint32, Operation.PUTROOTFH), (writer) =>
        Effect.gen(function*() {
          yield* writer.write(XdrCodec.uint32, Operation.WRITE)
          yield* writer.write(XdrCodec.fixedOpaque(new Uint8Array(16).length), new Uint8Array(16))
          yield* writer.write(XdrCodec.uint64, 0n)
          yield* writer.write(XdrCodec.uint32, 0)
          yield* writer.write(XdrCodec.opaque(), new Uint8Array([1]))
        })])

      assert.strictEqual((yield* statuses(yield* handler.compound(write))).status, Status.ROFS)
    }))
  it.effect("rejects trailing compound bytes and unsupported minor versions", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      )

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
    }))
  it.effect("creates bounded sessions and returns byte-identical cached slot replays", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      )

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

      const sequenced = yield* call([(writer) =>
        Effect.gen(function*() {
          yield* writer.write(XdrCodec.uint32, Operation.SEQUENCE)
          yield* writer.write(XdrCodec.fixedOpaque(session.length), session)
          yield* writer.write(XdrCodec.uint32, 1)
          yield* writer.write(XdrCodec.uint32, 0)
          yield* writer.write(XdrCodec.uint32, 1)
          yield* writer.write(XdrCodec.boolean, true)
        }), (writer) =>
        writer.write(XdrCodec.uint32, Operation.PUTROOTFH), (writer) =>
        writer.write(XdrCodec.uint32, Operation.GETFH)], "replay")

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
    }))
  it.effect("replays an identical CREATE_SESSION without allocating another session", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const constrained = {
        ...limits,
        maxSessions: 1
      }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits: constrained
        }
      )

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
    }))
  it.effect("returns SEQUENCE OK before RETRY_UNCACHED_REP for an uncached replay", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      )

      const {
        session
      } = yield* startSession(handler, "uncached-replay")

      const request = yield* call([
        sequence(session, 1),
        (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)
      ])

      assert.strictEqual((yield* statuses(yield* handler.compound(request))).status, Status.OK)
      assert.deepStrictEqual((yield* statuses(yield* handler.compound(request))).operations, [[
        Operation.SEQUENCE,
        Status.OK
      ], [Operation.PUTROOTFH, Status.RETRY_UNCACHED_REP]])
    }))
  it.effect("never repeats an OPEN when its reply is lost", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const base = makeExport(caller, generation, {
        maxFilehandles: 16,
        maxNameBytes: ByteSize.bytes(255)
      })

      let opens = 0

      const export_ = {
        ...base,
        open: (reference: Vfs.ObjectReference) => {
          opens++

          return base.open(reference)
        }
      }

      const handler = yield* makeNfs4Handler(export_, {
        leaseDurationSeconds: 30,
        callbackTimeout: "1 second",
        generation,
        now: () => 0,
        limits
      })

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
    }))
  it.effect("rejects an OPEN before execution when its cached result cannot fit", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const base = makeExport(caller, generation, {
        maxFilehandles: 16,
        maxNameBytes: ByteSize.bytes(255)
      })

      let opens = 0

      const handler = yield* makeNfs4Handler({
        ...base,
        open: (reference: Vfs.ObjectReference) => {
          opens++

          return base.open(reference)
        }
      }, {
        leaseDurationSeconds: 30,
        callbackTimeout: "1 second",
        generation,
        now: () => 0,
        limits
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
    }))
  it.effect("includes every configured SECINFO flavor in pre-mutation reply admission", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const base = makeExport(caller, generation, {
        maxFilehandles: 16,
        maxNameBytes: ByteSize.bytes(255)
      })

      let opens = 0

      const handler = yield* makeNfs4Handler({
        ...base,
        open: (reference: Vfs.ObjectReference) => {
          opens++

          return base.open(reference)
        }
      }, {
        leaseDurationSeconds: 30,
        callbackTimeout: "1 second",
        generation,
        now: () => 0,
        limits,
        securityFlavors: [1, 0, 1, 0, 1, 0]
      })

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
    }))
  it.effect("does not reopen a consumed slot after an operation fails", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const base = makeExport(caller, generation, {
        maxFilehandles: 16,
        maxNameBytes: ByteSize.bytes(255)
      })

      let opens = 0

      const handler = yield* makeNfs4Handler({
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
      }, {
        leaseDurationSeconds: 30,
        callbackTimeout: "1 second",
        generation,
        now: () => 0,
        limits
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
    }))
  it.effect("leaves a slot unchanged when SEQUENCE rejects an oversized cached reply", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const constrained = {
        ...limits,
        maxReplayBytes: ByteSize.bytes(512)
      }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits: constrained
        }
      )

      const {
        session
      } = yield* startSession(handler, "replay-budget", {
        maxCachedResponse: 64
      })

      const rejected = yield* call([sequence(session, 1, true), (writer) =>
        writer.write(XdrCodec.uint32, Operation.PUTROOTFH), (writer) =>
        Effect.gen(function*() {
          yield* writer.write(XdrCodec.uint32, Operation.GETATTR)
          yield* writer.write(XdrCodec.uint32, 1)
          yield* writer.write(XdrCodec.uint32, 1)
        })])

      assert.strictEqual(
        yield* (yield* make.openReader(yield* handler.compound(rejected), limits)).read(XdrCodec.uint32),
        Status.REP_TOO_BIG_TO_CACHE
      )
      const retry = yield* call([sequence(session, 1)])
      assert.strictEqual(
        yield* (yield* make.openReader(yield* handler.compound(retry), limits)).read(XdrCodec.uint32),
        Status.OK
      )
    }))
  it.effect("accepts small actual replies within a negotiated response channel", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      )

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
    }))
  it.effect("counts retained requests against the replay-memory budget", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const constrained = {
        ...limits,
        maxReplayBytes: ByteSize.bytes(560)
      }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits: constrained
        }
      )

      const {
        session
      } = yield* startSession(handler, "request-budget")

      const first = yield* call([sequence(session, 1, false, 0), (writer) =>
        writer.write(XdrCodec.uint32, Operation.PUTROOTFH)], "x".repeat(80))

      assert.strictEqual(
        yield* (yield* make.openReader(yield* handler.compound(first), limits)).read(XdrCodec.uint32),
        Status.OK
      )

      const second = yield* call([sequence(session, 1, false, 1), (writer) =>
        writer.write(XdrCodec.uint32, Operation.PUTROOTFH)], "x".repeat(80))

      assert.strictEqual(
        yield* (yield* make.openReader(yield* handler.compound(second), limits)).read(XdrCodec.uint32),
        Status.DELAY
      )
    }))
  it.effect("reuses the reserved replay budget for successive uncached requests", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const constrained = {
        ...limits,
        maxReplayBytes: ByteSize.bytes(640)
      }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits: constrained
        }
      )

      const {
        session
      } = yield* startSession(handler, "reused-request-budget")

      for (let sequenceId = 1; sequenceId <= 4; sequenceId++) {
        const request = yield* call([sequence(session, sequenceId), (writer) =>
          writer.write(XdrCodec.uint32, Operation.PUTROOTFH)], "x".repeat(80))

        assert.strictEqual(
          yield* (yield* make.openReader(yield* handler.compound(request), constrained)).read(XdrCodec.uint32),
          Status.OK
        )
      }
    }))
  it.effect("rejects a different request that reuses a cached slot sequence", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      )

      const {
        session
      } = yield* startSession(handler, "false-retry")

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
        ...(yield* call([sequence(session, 1, true), (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)])),
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
    }))
  it.effect("replaces a slot's cached reply without double-counting its old bytes", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const constrained = {
        ...limits,
        maxReplayBytes: ByteSize.bytes(1_024)
      }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits: constrained
        }
      )

      const {
        session
      } = yield* startSession(handler, "replace-replay")

      for (
        const sequenceId of Array.from({
          length: 10
        }, (_, index) => index + 1)
      ) {
        const request = yield* call([sequence(session, sequenceId, true), (writer) =>
          writer.write(XdrCodec.uint32, Operation.PUTROOTFH)])

        const response = yield* handler.compound(request)
        assert.strictEqual(yield* (yield* make.openReader(response, constrained)).read(XdrCodec.uint32), Status.OK)
        assert.deepStrictEqual(yield* handler.compound(request), response)
      }
    }))
  it.effect("revokes the prior client incarnation when its replacement creates a session", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const constrained = {
        ...limits,
        maxClients: 1,
        maxSessions: 1
      }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits: constrained
        }
      )

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
        yield* (yield* make.openReader(yield* handler.compound(yield* call([sequence(first.session, 1)])), constrained))
          .read(XdrCodec.uint32),
        Status.BADSESSION
      )
    }))
  it.effect("restores a confirmed predecessor after destroying an unconfirmed replacement", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const constrained = {
        ...limits,
        maxClients: 1
      }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits: constrained
        }
      )

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
    }))
  it.effect("bounds pending client replacements separately from logical clients", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const constrained = {
        ...limits,
        maxClients: 2,
        maxPendingClientReplacements: 1
      }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits: constrained
        }
      )

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
    }))
  it.effect("requires DESTROY_SESSION for the active session to be the final operation", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      )

      const {
        session
      } = yield* startSession(handler, "destroy-order")

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
    }))
  it.effect("rejects an unsequenced non-final DESTROY_SESSION without removing the session", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      )

      const {
        session
      } = yield* startSession(handler, "unsequenced-destroy-order")

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
    }))
  it.effect("releases cached replay capacity when DESTROY_SESSION removes its session", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const constrained = {
        ...limits,
        maxClients: 8,
        maxSessions: 1,
        maxReplayBytes: ByteSize.bytes(1_024)
      }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits: constrained
        }
      )

      for (let index = 0; index < 4; index++) {
        const {
          session
        } = yield* startSession(handler, `destroy-cache-${index}`)

        assert.strictEqual(
          yield* (yield* make.openReader(
            yield* handler.compound(
              yield* call([sequence(session, 1, true), (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)])
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
    }))
  it.effect("serializes concurrent slot duplicates so OPEN runs exactly once", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const base = makeExport(caller, generation, {
        maxFilehandles: 16,
        maxNameBytes: ByteSize.bytes(255)
      })

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
    }))
  it.effect("reports read-only access and non-atomic name resolution for OPEN", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })
      yield* caller.writeFile("/other", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      )

      const client = yield* startSession(handler, "open-contract")

      const writeAccess = yield* call([sequence(client.session, 1), (writer) =>
        writer.write(XdrCodec.uint32, Operation.PUTROOTFH), openByName(client.client, "file", 2)])

      assert.strictEqual(
        yield* (yield* make.openReader(yield* handler.compound(writeAccess), limits)).read(XdrCodec.uint32),
        Status.ROFS
      )

      // Deny modes are share reservations, not an error on a read-only export; only undefined
      // values are rejected (RFC 8881 Section 18.16.3).
      const denyRead = yield* call([sequence(client.session, 2), (writer) =>
        writer.write(XdrCodec.uint32, Operation.PUTROOTFH), openByName(client.client, "file", 1, 1)])

      assert.strictEqual(
        yield* (yield* make.openReader(yield* handler.compound(denyRead), limits)).read(XdrCodec.uint32),
        Status.OK
      )

      const undefinedDeny = yield* call([sequence(client.session, 3), (writer) =>
        writer.write(XdrCodec.uint32, Operation.PUTROOTFH), openByName(client.client, "file", 1, 4)])

      assert.strictEqual(
        yield* (yield* make.openReader(yield* handler.compound(undefinedDeny), limits)).read(XdrCodec.uint32),
        Status.INVAL
      )

      const opened = yield* parseOpen(
        yield* handler.compound(
          yield* call([
            sequence(client.session, 4),
            (writer) =>
              writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
            openReadOnly(client.client, "other"),
            (writer) =>
              writer.write(XdrCodec.uint32, Operation.GETFH)
          ])
        )
      )

      assert.isFalse(opened.atomic)
    }))
  it.effect("requires a first SEQUENCE and keeps another client from using an open stateid", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1, 2]), {
        access: "write",
        create: "exclusive"
      })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      )

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
    }))
  it.effect("reports EOF on an exact-boundary read and lets the owning session close", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1, 2]), {
        access: "write",
        create: "exclusive"
      })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      )

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
    }))
  it.effect("opens the current filehandle with the macOS CLAIM_FH sequence", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const export_ = makeExport(caller, generation, {
        maxFilehandles: 16,
        maxNameBytes: ByteSize.bytes(255)
      })

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
    }))
  it.effect("serves metadata, access, directory entries, and symbolic-link targets", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })
      yield* caller.symlink("file", "/link")

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      )

      const client = yield* startSession(handler, "browser")
      const root = yield* caller.rootReference
      const directoryObservation = yield* caller.observeDirectory(root)

      const browse = yield* call([sequence(client.session, 1), (writer) =>
        writer.write(XdrCodec.uint32, Operation.PUTROOTFH), (writer) =>
        Effect.gen(function*() {
          yield* writer.write(XdrCodec.uint32, Operation.GETATTR)
          yield* writer.write(XdrCodec.uint32, 1)
          yield* writer.write(XdrCodec.uint32, 1 << 0 | 1 << 1 | 1 << 2)
        }), (writer) =>
        Effect.gen(function*() {
          yield* writer.write(XdrCodec.uint32, Operation.ACCESS)
          yield* writer.write(XdrCodec.uint32, 3)
        }), (writer) =>
        Effect.gen(function*() {
          yield* writer.write(XdrCodec.uint32, Operation.READDIR)
          yield* writer.write(XdrCodec.uint64, 0n)
          yield* writer.write(XdrCodec.fixedOpaque(new Uint8Array(8).length), new Uint8Array(8))
          yield* writer.write(XdrCodec.uint32, 4_096)
          yield* writer.write(XdrCodec.uint32, 4_096)
          yield* writer.write(XdrCodec.uint32, 1)
          yield* writer.write(XdrCodec.uint32, 1 << 1)
        })])

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
      assert.deepStrictEqual(yield* attributeValues.read(XdrCodec.array(XdrCodec.uint32)), [3826978815, 12099646, 6144])
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
            (writer) =>
              writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
                yield* writer.write(XdrCodec.string(), "link")
              }),
            (writer) =>
              writer.write(XdrCodec.uint32, Operation.READLINK)
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
    }))
  it.effect("rejects stale filehandles during PUTFH", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })
      const root = yield* caller.rootReference
      const reference = yield* caller.lookupReference(root, new TextEncoder().encode("file"))

      const export_ = makeExport(caller, generation, {
        maxFilehandles: 16,
        maxNameBytes: ByteSize.bytes(255)
      })

      const filehandle = yield* export_.handleFor(reference)

      const handler = yield* makeNfs4Handler(export_, {
        leaseDurationSeconds: 30,
        callbackTimeout: "1 second",
        generation,
        now: () => 0,
        limits
      })

      const {
        session
      } = yield* startSession(handler, "stale-filehandle")

      yield* caller.unlink("/file")

      const response = yield* handler.compound(
        yield* call([sequence(session, 1), (writer) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
            yield* writer.write(XdrCodec.opaque(), filehandle)
          })])
      )

      assert.strictEqual(yield* (yield* make.openReader(response, limits)).read(XdrCodec.uint32), Status.STALE)
    }))
  it.effect("bounds READLINK results before advancing beyond the negotiated reply budget", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.symlink("12345678901234567", "/link")

      const constrained = {
        ...limits,
        maxStringBytes: ByteSize.bytes(16)
      }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits: constrained
        }
      )

      const {
        session
      } = yield* startSession(handler, "link-bound")

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
    }))
  it.effect("lists entries without allocating filehandles when no attributes are requested", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/a", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })
      yield* caller.writeFile("/b", new Uint8Array([2]), {
        access: "write",
        create: "exclusive"
      })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 1,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      )

      const {
        session
      } = yield* startSession(handler, "attribute-free-readdir")

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

      const constrained = {
        ...limits,
        maxReaddirEntries: 1
      }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits: constrained
        }
      )

      const {
        session
      } = yield* startSession(handler, "pagination")

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
        yield* (yield* make.openReader(yield* readPage(4, 1n, third.pageVerifier), constrained)).read(XdrCodec.uint32),
        Status.BAD_COOKIE
      )
      yield* caller.writeFile("/d", new Uint8Array([4]), {
        access: "write",
        create: "exclusive"
      })
      const stale = yield* readPage(5, third.nextCookie, third.pageVerifier)
      assert.strictEqual(yield* (yield* make.openReader(stale, constrained)).read(XdrCodec.uint32), Status.NOT_SAME)
    }))
  it.effect("pages READDIR within the record ceiling", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.fromFixture({
        entries: Array.from({
          length: 100
        }, (_, index) => ({
          kind: "file" as const,
          path: `/entry-${String(index).padStart(4, "0")}`,
          bytes: new Uint8Array([index])
        }))
      })

      const caller = yield* volume.caller()

      const constrained = {
        ...limits,
        maxRecordBytes: ByteSize.bytes(2_048),
        maxReaddirEntries: 100
      }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 128,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits: constrained
        }
      )

      const {
        session
      } = yield* startSession(handler, "record-page")

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
    }))
  it.effect("does not consume client capacity when EXCHANGE_ID reply encoding fails", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const constrained = {
        ...limits,
        maxClients: 1,
        maxRecordBytes: ByteSize.bytes(64)
      }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits: constrained
        }
      )

      const first = yield* handler.compound(yield* call([exchangeId("first-owner")]))
      const second = yield* handler.compound(yield* call([exchangeId("second-owner")]))
      assert.strictEqual(yield* (yield* make.openReader(first, constrained)).read(XdrCodec.uint32), Status.REP_TOO_BIG)
      assert.strictEqual(yield* (yield* make.openReader(second, constrained)).read(XdrCodec.uint32), Status.REP_TOO_BIG)
    }))
  it.effect("uses maxcount alone when READDIR dircount is zero", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      )

      const {
        session
      } = yield* startSession(handler, "zero-dircount")

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
    }))
  it.effect("rejects OPEN without read access without consuming open capacity", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const constrained = {
        ...limits,
        maxOpens: 1
      }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits: constrained
        }
      )

      const {
        client,
        session
      } = yield* startSession(handler, "invalid-open-access")

      const invalid = yield* handler.compound(
        yield* call([sequence(session, 1), (writer) =>
          writer.write(XdrCodec.uint32, Operation.PUTROOTFH), (writer) =>
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
          })])
      )

      assert.strictEqual(yield* (yield* make.openReader(invalid, constrained)).read(XdrCodec.uint32), Status.INVAL)
      yield* parseOpen(
        yield* handler.compound(
          yield* call([
            sequence(session, 2),
            (writer) =>
              writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
            openReadOnly(client, "file"),
            (writer) =>
              writer.write(XdrCodec.uint32, Operation.GETFH)
          ])
        )
      )
    }))
  it.effect("coalesces repeated OPEN state and validates stateid sequences", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const constrained = {
        ...limits,
        maxOpens: 1
      }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits: constrained
        }
      )

      const {
        client,
        session
      } = yield* startSession(handler, "repeated-open")

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
    }))
  it.effect("checks an open-owner's own deny mode on a repeated OPEN", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      )

      const {
        client,
        session
      } = yield* startSession(handler, "self-deny")

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
    }))
  it.effect("coordinates write opens across clients and releases a denial on downgrade", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits,
          writable: true
        }
      )

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
    }))
  it.effect("rejects reads through a write-only stateid", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits,
          writable: true
        }
      )

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
    }))
  it.effect("upgrades one open-owner from read to read-write and keeps one open record", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const constrained = {
        ...limits,
        maxOpens: 1
      }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits: constrained,
          writable: true
        }
      )

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
    }))
  it.effect("keeps earlier read access when upgrading after read permission is removed", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()

      const admin = yield* volume.caller({
        umask: 0
      })

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

      const owner = yield* volume.caller({
        identity: {
          uid: 1000,
          gid: 1000,
          groups: [],
          privileged: false
        }
      })

      const handler = yield* makeNfs4Handler(
        makeExport(admin, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits,
          writable: true,
          callerFor: () => Effect.succeed(owner)
        }
      )

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
    }))
  live("interrupts a stalled write-open upgrade without closing the original handle", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const base = makeExport(caller, generation, {
        maxFilehandles: 16,
        maxNameBytes: ByteSize.bytes(255)
      })

      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      const export_ = {
        ...base,
        open: (reference: Vfs.ObjectReference, access?: Vfs.OpenReferenceSettings["access"]) =>
          access === "write"
            ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(base.open(reference, access))
            )
            : base.open(reference, access)
      }

      const handler = yield* makeNfs4Handler(export_, {
        leaseDurationSeconds: 30,
        callbackTimeout: "1 second",
        generation,
        now: () => 0,
        limits,
        writable: true
      })

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
    }))
  it.effect("supports anonymous and current-stateid READ forms", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      )

      const {
        client,
        session
      } = yield* startSession(handler, "special-stateids")

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
    }))
  it.effect("enforces negotiated channel operation and cached-reply limits before advancing a slot", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const constrained = {
        ...limits,
        maxReplayBytes: ByteSize.bytes(580)
      }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits: constrained
        }
      )

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
    }))
  it.effect("encodes every advertised GETATTR value from one file observation", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
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

      const export_ = makeExport(caller, generation, {
        maxFilehandles: 16,
        maxNameBytes: ByteSize.bytes(255)
      })

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

      const {
        session
      } = yield* startSession(handler, "all-attributes")

      const requested = [3_826_978_815, 12_099_646, 6_144]

      const response = yield* make.openReader(
        yield* handler.compound(
          yield* call([sequence(session, 1), (writer) =>
            writer.write(XdrCodec.uint32, Operation.PUTROOTFH), (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
              yield* writer.write(XdrCodec.string(), "file")
            }), (writer) =>
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
            })])
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
      assert.deepStrictEqual(yield* values.read(XdrCodec.array(XdrCodec.uint32)), requested)
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
      assert.strictEqual(yield* values.read(XdrCodec.uint64), observation.value.ino)
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

      yield* expectTime(observation.value.atimeNs)
      assert.deepStrictEqual(yield* readTime(), {
        seconds: 0n,
        nanoseconds: 1
      }, "time_delta")
      yield* expectTime(observation.value.ctimeNs)
      yield* expectTime(observation.value.mtimeNs)
      assert.strictEqual(yield* values.read(XdrCodec.uint64), observation.value.ino)
      assert.deepStrictEqual(yield* values.read(XdrCodec.array(XdrCodec.uint32)), [])
      assert.strictEqual(yield* values.read(XdrCodec.uint32), 0x2, "fs_charset_cap: FSCHARSET_CAP4_ALLOWS_ONLY_UTF8")
      yield* values.finish
      yield* response.finish
    }))
  it.effect("reports bounded volume capacity and omits unbounded totals", () =>
    Effect.gen(function*() {
      const bounded = yield* Vfs.make({
        maxBytes: ByteSize.bytes(10),
        maxEntries: 3
      })

      const caller = yield* bounded.caller()
      yield* caller.mkdir("/dir")
      yield* caller.writeFile("/file", new Uint8Array([1, 2, 3]), {
        access: "write",
        create: "exclusive"
      })

      const export_ = makeExport(
        caller,
        generation,
        {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        },
        generation,
        bounded
      )

      const handler = yield* makeNfs4Handler(export_, {
        leaseDurationSeconds: 30,
        callbackTimeout: "1 second",
        generation,
        now: () => 0,
        limits
      })

      const {
        session
      } = yield* startSession(handler, "bounded-capacity")

      const requested = [1 | 1 << 21 | 1 << 22 | 1 << 23 | 1 << 27, 1 << 10 | 1 << 11 | 1 << 12]

      const response = yield* make.openReader(
        yield* handler.compound(
          yield* call([sequence(session, 1), (writer) =>
            writer.write(XdrCodec.uint32, Operation.PUTROOTFH), (writer) =>
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
            })])
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

      const unlimitedHandler = yield* makeNfs4Handler(
        makeExport(
          unlimitedCaller,
          generation,
          {
            maxFilehandles: 16,
            maxNameBytes: ByteSize.bytes(255)
          },
          generation,
          unlimited
        ),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () =>
            0,
          limits
        }
      )

      const unlimitedSession = yield* startSession(unlimitedHandler, "unbounded-capacity")

      const unboundedResponse = yield* make.openReader(
        yield* unlimitedHandler.compound(
          yield* call([
            sequence(unlimitedSession.session, 1),
            (writer) =>
              writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
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

      for (let field = 0; field < 5; field++) yield* unboundedResponse.read(XdrCodec.uint32)
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
        yield* call([sequence(unlimitedSession.session, 2), (writer) =>
          writer.write(XdrCodec.uint32, Operation.PUTROOTFH), (writer) =>
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
          })])
      )

      assert.strictEqual(
        yield* (yield* make.openReader(unsupportedVerify, limits)).read(XdrCodec.uint32),
        Status.ATTRNOTSUPP
      )
    }))
  it.effect("normalizes negative timestamps and rejects seconds outside the NFS int64 range", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
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

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      )

      const {
        session
      } = yield* startSession(handler, "timestamp-bounds")

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
    }))
  it.effect("reads successive offsets and reports EOF only at the file boundary", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6])
      yield* caller.writeFile("/file", bytes, {
        access: "write",
        create: "exclusive"
      })

      const constrained = {
        ...limits,
        maxReadBytes: ByteSize.bytes(3)
      }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits: constrained
        }
      )

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
    }))
  it.effect("rejects every decoded mutation as read-only without changing the volume", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const original = new Uint8Array([1, 2, 3])
      yield* caller.writeFile("/file", original, {
        access: "write",
        create: "exclusive"
      })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      )

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
    }))
  it.effect("sweeps expired clients before applying capacity limits and closes their opens", () =>
    Effect.gen(function*() {
      let now = 0
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })
      const root = yield* caller.rootReference
      const reference = yield* caller.lookupReference(root, new TextEncoder().encode("file"))

      const constrained = {
        ...limits,
        maxClients: 1,
        maxSessions: 1,
        maxOpens: 1
      }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 1,
          callbackTimeout: "1 second",
          generation,
          now: () => now,
          limits: constrained
        }
      )

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
      assert.strictEqual((yield* caller.observeMetadata(reference)).value.nlink, 0)
      now = 1_001
      yield* startSession(handler, "replacement")
      assert.strictEqual((yield* Effect.flip(caller.observeMetadata(reference))).code, "StaleReference")
    }))
  it.effect("reclaims an expired lease without waiting for another client's traffic", () =>
    Effect.gen(function*() {
      let now = 0
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })
      const root = yield* caller.rootReference
      const reference = yield* caller.lookupReference(root, new TextEncoder().encode("file"))

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 1,
          callbackTimeout: "1 second",
          generation,
          now: () => now,
          limits
        }
      )

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
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })
      const root = yield* caller.rootReference
      const reference = yield* caller.lookupReference(root, new TextEncoder().encode("file"))
      const scope = yield* Scope.make()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      ).pipe(Effect.provideService(Scope.Scope, scope))

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
      assert.strictEqual((yield* caller.observeMetadata(reference)).value.nlink, 0)
      yield* Scope.close(scope, Exit.void)
      assert.strictEqual((yield* Effect.flip(caller.observeMetadata(reference))).code, "StaleReference")
    }))
  live("does not let a connection finalizer wait out an in-flight compound", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const base = makeExport(caller, generation, {
        maxFilehandles: 16,
        maxNameBytes: ByteSize.bytes(255)
      })

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
    }))

  // A real bound needs the live clock: it.effect runs on the test clock, which never advances.
  live("interrupts a stalled compound without reopening its consumed slot", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const base = makeExport(caller, generation, {
        maxFilehandles: 16,
        maxNameBytes: ByteSize.bytes(255)
      })

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

      const handler = yield* makeNfs4Handler(export_, {
        leaseDurationSeconds: 30,
        callbackTimeout: "1 second",
        generation,
        now: () => 0,
        limits
      })

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
    }))
  live("interrupts an observation before a later OPEN without dispatching it", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const base = makeExport(caller, generation, {
        maxFilehandles: 16,
        maxNameBytes: ByteSize.bytes(255)
      })

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

      const handler = yield* makeNfs4Handler(export_, {
        leaseDurationSeconds: 30,
        callbackTimeout: "1 second",
        generation,
        now: () => 0,
        limits
      })

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
    }))

  // A real bound needs the live clock: it.effect runs on the test clock, which never advances.
  live("closes an open exactly once when CLOSE is interrupted", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const base = makeExport(caller, generation, {
        maxFilehandles: 16,
        maxNameBytes: ByteSize.bytes(255)
      })

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
        const handler = yield* makeNfs4Handler(export_, {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        })

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
    }))

  // A real bound needs the live clock: it.effect runs on the test clock, which never advances.
  live("closes a revoked client's open exactly once when revocation is interrupted", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const base = makeExport(caller, generation, {
        maxFilehandles: 16,
        maxNameBytes: ByteSize.bytes(255)
      })

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
        const handler = yield* makeNfs4Handler(export_, {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        })

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
    }))
  it.effect("reuses session and open capacity after explicit teardown", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const constrained = {
        ...limits,
        maxSessions: 1,
        maxOpens: 1
      }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits: constrained
        }
      )

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

      const full = yield* call([sequence(secondSession, 2), (writer) =>
        writer.write(XdrCodec.uint32, Operation.PUTROOTFH), (writer) =>
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
        })])

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
              (writer) =>
                writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
              openReadOnly(secondClient, "file")
            ])
          ),
          constrained
        )).read(XdrCodec.uint32),
        Status.OK
      )
    }))
  it.effect("keeps a client busy until its open and session are destroyed", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })
      const root = yield* caller.rootReference
      const reference = yield* caller.lookupReference(root, new TextEncoder().encode("file"))

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      )

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
      assert.strictEqual((yield* caller.observeMetadata(reference)).value.nlink, 0)
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
      assert.strictEqual(yield* (yield* make.openReader(firstBusy, limits)).read(XdrCodec.uint32), Status.CLIENTID_BUSY)
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
      assert.strictEqual((yield* Effect.flip(caller.observeMetadata(reference))).code, "StaleReference")
      assert.strictEqual(
        yield* (yield* make.openReader(yield* handler.compound(yield* call([sequence(client.session, 6)])), limits))
          .read(XdrCodec.uint32),
        Status.BADSESSION
      )
    }))
  it.effect("preserves prior results before an unknown operation and structurally validates mutation attrs", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits
        }
      )

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
    }))

  const connectionHandler = Effect.gen(function*() {
    const caller = yield* (yield* Vfs.make()).caller()

    return yield* makeNfs4Handler(
      makeExport(caller, generation, {
        maxFilehandles: 16,
        maxNameBytes: ByteSize.bytes(255)
      }),
      {
        leaseDurationSeconds: 30,
        callbackTimeout: "1 second",
        generation,
        now: () => 0,
        limits
      }
    )
  })

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

  it.effect("refuses DESTROY_SESSION from a connection the session was never carried on", () =>
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
    }))
  it.effect("associates a connection that only ever carried a SEQUENCE", () =>
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
    }))
  it.effect("lets a connection associated only by BIND_CONN_TO_SESSION destroy the session", () =>
    Effect.gen(function*() {
      const handler = yield* connectionHandler
      const owner = connection(1)
      const byBind = connection(3)

      const {
        session
      } = yield* startSession(handler, "bind-assoc", {}, new Uint8Array(8), owner)

      // Before binding, the connection is a stranger.
      assert.deepStrictEqual(
        (yield* statuses(yield* handler.compound(yield* call([destroySession(session)], "probe", byBind)))).operations,
        [[Operation.DESTROY_SESSION, Status.CONN_NOT_BOUND_TO_SESSION]]
      )
      assert.strictEqual(
        (yield* statuses(yield* handler.compound(yield* call([bindToSession(session)], "probe", byBind)))).status,
        Status.OK
      )

      // Section 18.34.3 binding is what makes the connection eligible.
      assert.deepStrictEqual(
        (yield* statuses(yield* handler.compound(yield* call([destroySession(session)], "probe", byBind)))).operations,
        [[Operation.DESTROY_SESSION, Status.OK]]
      )
    }))
  it.effect("associates a reconnecting client that retransmits a cached SEQUENCE", () =>
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
    }))
  it.effect("drops a connection's association when it disconnects, without ending the session", () =>
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
        (yield* statuses(yield* handler.compound(yield* call([destroySession(session)], "probe", second)))).operations,
        [[Operation.DESTROY_SESSION, Status.CONN_NOT_BOUND_TO_SESSION]]
      )
    }))

  const backChannelHandler = (callbackTimeout: Duration.Input) =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()

      return yield* makeNfs4Handler(
        makeExport(caller, generation, {
          maxFilehandles: 16,
          maxNameBytes: ByteSize.bytes(255)
        }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout,
          generation,
          now: () => 0,
          limits
        }
      )
    })

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

  it.effect("sends a CB_COMPOUND whose CB_SEQUENCE and RPC version match the errata", () =>
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
    }))

  // A real timeout needs the live clock: it.effect runs on the test clock, which never advances.
  live("reports the callback path down when the client never answers", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("10 millis")
      const client = connection(1)

      const {
        session
      } = yield* startSession(handler, "silent", {}, new Uint8Array(8), client, 2)

      assert.isFalse(yield* handler.probeBackChannel(session))
    }))
  it.effect("reports the callback path down when the connection cannot be written to", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("2 seconds")
      const client = connection(1, () => false)

      const {
        session
      } = yield* startSession(handler, "broken", {}, new Uint8Array(8), client, 2)

      assert.isFalse(yield* handler.probeBackChannel(session))
    }))
  it.effect("has no backchannel to probe when the client never asked for one", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("2 seconds")

      const client = connection(1, () => {
        throw new Error("a session without a backchannel must not send callbacks")
      })

      const {
        session
      } = yield* startSession(handler, "none", {}, new Uint8Array(8), client)

      assert.isFalse(yield* handler.probeBackChannel(session))
    }))
  it.effect("gives one client id to several connections and serves a session on each", () =>
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
      const {
        session
      } = yield* startSession(handler, "authsys", {}, new Uint8Array(8), client, 2, (writer) =>
        Effect.gen(function*() {
          yield* writer.write(XdrCodec.uint32, 1)
          yield* authSysCallback(writer)
        }))

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
    }))
  it.effect("sends no callback when the client authorized no credential it can encode", () =>
    Effect.gen(function*() {
      const handler = yield* backChannelHandler("2 seconds")

      const client = connection(1, () => {
        throw new Error("no credential was authorized, so no callback may be sent")
      })

      // An empty csa_sec_parms authorizes nothing; the backchannel is bound but unusable.
      const {
        session
      } = yield* startSession(handler, "unauthorized", {}, new Uint8Array(8), client, 2, (writer) =>
        writer.write(XdrCodec.uint32, 0))

      assert.isFalse(yield* handler.probeBackChannel(session))
    }))

  // Live clock: the probe must actually time out after the impostor reply is discarded.
  live("ignores a callback reply that arrives on another connection", () =>
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
    }))
  live("reports a down callback path in sr_status_flags", () =>
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
    }))
  live("probes the callback path again after BACKCHANNEL_CTL re-advertises a program", () =>
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
    }))
  live("treats an RPC-level rejection as a callback path that is down", () =>
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
    }))
  live("does not advance the backchannel slot sequence when a callback goes unanswered", () =>
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
    }))

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

  it.effect("prefers an offered AUTH_NONE over an offered AUTH_SYS callback credential", () =>
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
    }))
  it.effect("refuses an AUTH_SYS callback credential that cannot fit an RPC opaque_auth body", () =>
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
    }))
  live("probes again when a new connection binds the backchannel", () =>
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
    }))
  live("marks the path down when its last backchannel connection goes away", () =>
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
    }))
  live("lets a healthy carrier answer while another stays silent", () =>
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
    }))
  live("does not let a rejecting carrier end the attempt", () =>
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
    }))
  it.effect("rejects a requested backchannel that offers no slots", () =>
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
    }))
  live("rejects a callback reply whose RPC verifier exceeds an opaque_auth body", () =>
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
    }))
  it.effect("does not send a callback whose full RPC call exceeds the client's ca_maxrequestsize", () =>
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
    }))
  live("does not let a stale probe overwrite the verdict of a re-armed path", () =>
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
    }))
  live("re-arms the probe when every backchannel slot is already in flight", () =>
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
    }))
  it.effect("bounds a compound carrying BACKCHANNEL_CTL by its worst case before it mutates", () =>
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
    }))
  live("rejects a callback reply that is not exactly one complete CB_SEQUENCE result", () =>
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
    }))
})
