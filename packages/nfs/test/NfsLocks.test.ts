import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import * as ByteSize from "effect/ByteSize"
import { makeExport } from "../src/internal/export.js"
import { makeNfs4Handler, Operation, Status } from "../src/internal/nfs4.js"
import { type EncoderSession, make, XdrCodec } from "../src/internal/xdr.js"
import {
  call,
  generation,
  limits,
  openByName,
  openReadOnly,
  parseOpen,
  sequence,
  startSession,
  statuses,
  type WriteOperation
} from "./support/harness.js"

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
  it.effect("shares one owner's range across separate open stateids", () =>
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
    }))
  it.effect("reports two-client read/write conflicts and permits disjoint ranges", () =>
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
      yield* resultStateid(yield* onFile(b, 4, lock(openedB.stateid, b.client, "owner-b", 200n, 5n, 2)), Operation.LOCK)
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
    }))
  it.effect("holds read locks through stateids and releases them before CLOSE", () =>
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

      const {
        client,
        session
      } = yield* startSession(handler, "lock-holder")

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
    }))
  it.effect("bounds lock records without consuming owner capacity on a rejected request", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const constrained = {
        ...limits,
        maxLockOwners: 1,
        maxLocks: 1
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
      } = yield* startSession(handler, "lock-limits")

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
    }))
  it.effect("keeps a split within the range limit and replays a lock only once", () =>
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
          limits: {
            ...limits,
            maxLocks: 1
          }
        }
      )

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
    }))
  it.effect("does not let another client unlock an owner's byte range", () =>
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
    }))
  it.effect("releases lock-owner capacity when a client's lease expires", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
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
    }))
})
