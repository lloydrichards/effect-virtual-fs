import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import * as ByteSize from "effect/ByteSize"
import { makeExport } from "../src/internal/export.js"
import { makeNfs4Handler, Operation, Status } from "../src/internal/nfs4.js"
import { Reader, type Writer } from "../src/internal/xdr.js"
import {
  call,
  generation,
  limits,
  openByName,
  openReadOnly,
  parseOpen,
  sequence,
  startSession,
  statuses
} from "./support/harness.js"

const lock =
  (stateid: Uint8Array, client: bigint, owner: string, offset: bigint, length: bigint, type = 1) => (writer: Writer) =>
    writer.uint32(Operation.LOCK).uint32(type).boolean(false).uint64(offset).uint64(length)
      .boolean(true).uint32(0).fixedOpaque(stateid).uint32(0).uint64(client).string(owner)

const lockExisting = (stateid: Uint8Array, offset: bigint, length: bigint, type = 1) => (writer: Writer) =>
  writer.uint32(Operation.LOCK).uint32(type).boolean(false).uint64(offset).uint64(length)
    .boolean(false).fixedOpaque(stateid).uint32(0)

const unlock = (stateid: Uint8Array, offset: bigint, length: bigint) => (writer: Writer) =>
  writer.uint32(Operation.LOCKU).uint32(1).uint32(0).fixedOpaque(stateid).uint64(offset).uint64(length)

const lockTest = (client: bigint, owner: string, offset: bigint, length: bigint, type = 1) => (writer: Writer) =>
  writer.uint32(Operation.LOCKT).uint32(type).uint64(offset).uint64(length).uint64(client).string(owner)

const denied = (bytes: Uint8Array, operation: number) => {
  const reader = new Reader(bytes, limits)
  assert.strictEqual(reader.uint32(), Status.DENIED)
  reader.string()
  reader.uint32()
  assert.strictEqual(reader.uint32(), Operation.SEQUENCE)
  assert.strictEqual(reader.uint32(), Status.OK)
  reader.fixedOpaque(16)

  for (let field = 0; field < 5; field++) reader.uint32()
  assert.strictEqual(reader.uint32(), Operation.PUTFH)
  assert.strictEqual(reader.uint32(), Status.OK)
  assert.strictEqual(reader.uint32(), operation)
  assert.strictEqual(reader.uint32(), Status.DENIED)

  return {
    offset: reader.uint64(),
    length: reader.uint64(),
    type: reader.uint32(),
    client: reader.uint64(),
    owner: reader.string()
  }
}

const resultStateid = (bytes: Uint8Array, operation: number): Uint8Array => {
  const reader = new Reader(bytes, limits)
  assert.strictEqual(reader.uint32(), Status.OK)
  reader.string()
  reader.uint32()
  assert.strictEqual(reader.uint32(), Operation.SEQUENCE)
  assert.strictEqual(reader.uint32(), Status.OK)
  reader.fixedOpaque(16)

  for (let field = 0; field < 5; field++) reader.uint32()
  assert.strictEqual(reader.uint32(), Operation.PUTFH)
  assert.strictEqual(reader.uint32(), Status.OK)
  assert.strictEqual(reader.uint32(), operation)
  assert.strictEqual(reader.uint32(), Status.OK)

  return reader.fixedOpaque(16)
}

it.layer(NodeCrypto.layer)("NFSv4.1 byte-range locks", (it) => {
  it.effect("shares one owner's range across separate open stateids", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits, writable: true }
      )

      const first = yield* startSession(handler, "shared-lock-owner")
      const second = yield* startSession(handler, "other-lock-owner")

      const open = (number: number, owner: string) =>
        handler.compound(call([
          sequence(first.session, number),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          (writer) =>
            writer.uint32(Operation.OPEN).uint32(0).uint32(3).uint32(0)
              .uint64(first.client).string(owner).uint32(0).uint32(0).string("file"),
          (writer) => writer.uint32(Operation.GETFH)
        ]))

      const openedA = parseOpen(yield* open(1, "open-a"))
      const openedB = parseOpen(yield* open(2, "open-b"))

      const onFile = (number: number, operation: (writer: Writer) => void) =>
        handler.compound(call([
          sequence(first.session, number),
          (writer) => writer.uint32(Operation.PUTFH).opaque(openedA.filehandle),
          operation
        ]))

      const heldA = resultStateid(
        yield* onFile(3, lock(openedA.stateid, first.client, "shared", 0n, 100n, 2)),
        Operation.LOCK
      )

      const heldB = resultStateid(
        yield* onFile(4, lock(openedB.stateid, first.client, "shared", 0n, 100n, 2)),
        Operation.LOCK
      )

      assert.strictEqual(
        statuses(yield* onFile(5, (writer) => writer.uint32(Operation.FREE_STATEID).fixedOpaque(heldA))).status,
        Status.OK
      )
      assert.strictEqual(
        statuses(yield* onFile(6, (writer) => writer.uint32(Operation.CLOSE).uint32(0).fixedOpaque(openedA.stateid)))
          .status,
        Status.OK
      )
      resultStateid(yield* onFile(7, unlock(heldB, 0n, 100n)), Operation.LOCKU)

      const openedOther = parseOpen(
        yield* handler.compound(call([
          sequence(second.session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openByName(second.client, "file", 3),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      resultStateid(
        yield* handler.compound(call([
          sequence(second.session, 2),
          (writer) => writer.uint32(Operation.PUTFH).opaque(openedOther.filehandle),
          lock(openedOther.stateid, second.client, "other", 0n, 100n, 2)
        ])),
        Operation.LOCK
      )
    }))

  it.effect("reports two-client read/write conflicts and permits disjoint ranges", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits, writable: true }
      )

      const a = yield* startSession(handler, "writer-a")
      const b = yield* startSession(handler, "writer-b")

      const open = (client: typeof a) =>
        handler.compound(call([
          sequence(client.session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openByName(client.client, "file", 3),
          (writer) => writer.uint32(Operation.GETFH)
        ]))

      const openedA = parseOpen(yield* open(a))
      const openedB = parseOpen(yield* open(b))

      const onFile = (client: typeof a, number: number, operation: (writer: Writer) => void) =>
        handler.compound(call([
          sequence(client.session, number),
          (writer) => writer.uint32(Operation.PUTFH).opaque(openedA.filehandle),
          operation
        ]))

      const held = resultStateid(
        yield* onFile(a, 2, lock(openedA.stateid, a.client, "owner-a", 100n, 100n, 2)),
        Operation.LOCK
      )

      assert.deepStrictEqual(denied(yield* onFile(b, 2, lockTest(b.client, "owner-b", 150n, 5n)), Operation.LOCKT), {
        offset: 100n,
        length: 100n,
        type: 2,
        client: a.client,
        owner: "owner-a"
      })
      assert.deepStrictEqual(
        denied(yield* onFile(b, 3, lock(openedB.stateid, b.client, "owner-b", 150n, 5n, 4)), Operation.LOCK),
        {
          offset: 100n,
          length: 100n,
          type: 2,
          client: a.client,
          owner: "owner-a"
        }
      )
      resultStateid(yield* onFile(b, 4, lock(openedB.stateid, b.client, "owner-b", 200n, 5n, 2)), Operation.LOCK)
      const changed = resultStateid(yield* onFile(a, 3, lockExisting(held, 125n, 25n, 1)), Operation.LOCK)
      assert.strictEqual(statuses(yield* onFile(b, 5, lockTest(b.client, "owner-b", 125n, 25n))).status, Status.OK)
      const released = resultStateid(yield* onFile(a, 4, unlock(changed, 150n, 50n)), Operation.LOCKU)
      resultStateid(yield* onFile(b, 6, lock(openedB.stateid, b.client, "owner-b", 150n, 50n, 2)), Operation.LOCK)
      assert.strictEqual(statuses(yield* onFile(a, 5, unlock(released, 100n, 50n))).status, Status.OK)
    }))

  it.effect("holds read locks through stateids and releases them before CLOSE", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1, 2]), { access: "write", create: "exclusive" })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
      )

      const { client, session } = yield* startSession(handler, "lock-holder")

      const opened = parseOpen(
        yield* handler.compound(call([
          sequence(session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openReadOnly(client, "file"),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      const onFile = (number: number, operation: (writer: Writer) => void) =>
        handler.compound(call([
          sequence(session, number),
          (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
          operation
        ]))

      const granted = resultStateid(yield* onFile(2, lock(opened.stateid, client, "owner", 0n, 2n)), Operation.LOCK)
      assert.strictEqual(new DataView(granted.buffer, granted.byteOffset, 4).getUint32(0), 1)
      const extended = resultStateid(yield* onFile(3, lockExisting(granted, 4n, 2n)), Operation.LOCK)
      assert.strictEqual(new DataView(extended.buffer, extended.byteOffset, 4).getUint32(0), 2)

      const testStateids = (response: Uint8Array) => {
        const reader = new Reader(response, limits)
        assert.strictEqual(reader.uint32(), Status.OK)
        reader.string()
        reader.uint32()
        assert.strictEqual(reader.uint32(), Operation.SEQUENCE)
        assert.strictEqual(reader.uint32(), Status.OK)
        reader.fixedOpaque(16)

        for (let field = 0; field < 5; field++) reader.uint32()
        const next = reader.uint32()

        if (next === Operation.PUTFH) {
          assert.strictEqual(reader.uint32(), Status.OK)
          assert.strictEqual(reader.uint32(), Operation.TEST_STATEID)
        } else {
          assert.strictEqual(next, Operation.TEST_STATEID)
        }

        assert.strictEqual(reader.uint32(), Status.OK)

        return reader.array((item) => item.uint32())
      }

      const test = (stateids: ReadonlyArray<Uint8Array>) => (writer: Writer) =>
        writer.uint32(Operation.TEST_STATEID).array(stateids, (item, stateid) => item.fixedOpaque(stateid))

      assert.deepStrictEqual(testStateids(yield* onFile(4, test([extended, granted]))), [
        Status.OK,
        Status.OLD_STATEID
      ])
      const foreign = yield* startSession(handler, "foreign-lock-client")
      assert.deepStrictEqual(
        testStateids(
          yield* handler.compound(call([
            sequence(foreign.session, 1),
            test([extended])
          ]))
        ),
        [Status.BAD_STATEID]
      )
      const replaced = resultStateid(yield* onFile(5, lock(opened.stateid, client, "owner", 1n, 2n)), Operation.LOCK)
      assert.strictEqual(
        statuses(yield* onFile(6, (writer) => writer.uint32(Operation.CLOSE).uint32(0).fixedOpaque(opened.stateid)))
          .status,
        Status.LOCKS_HELD
      )
      assert.strictEqual(
        statuses(yield* onFile(7, (writer) => writer.uint32(Operation.READ).fixedOpaque(replaced).uint64(0n).uint32(2)))
          .status,
        Status.OK
      )
      assert.strictEqual(statuses(yield* onFile(8, unlock(granted, 0n, 2n))).status, Status.OLD_STATEID)
      const partial = resultStateid(yield* onFile(9, unlock(replaced, 1n, 1n)), Operation.LOCKU)
      const narrowed = resultStateid(yield* onFile(10, unlock(partial, 0n, 3n)), Operation.LOCKU)
      assert.strictEqual(statuses(yield* onFile(11, unlock(narrowed, 4n, 2n))).status, Status.OK)
      assert.strictEqual(
        statuses(yield* onFile(12, (writer) => writer.uint32(Operation.CLOSE).uint32(0).fixedOpaque(opened.stateid)))
          .status,
        Status.OK
      )
      assert.strictEqual(statuses(yield* onFile(13, unlock(narrowed, 4n, 2n))).status, Status.BAD_STATEID)
    }))

  it.effect("bounds lock records without consuming owner capacity on a rejected request", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })

      const constrained = { ...limits, maxLockOwners: 1, maxLocks: 1 }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits: constrained }
      )

      const { client, session } = yield* startSession(handler, "lock-limits")

      const opened = parseOpen(
        yield* handler.compound(call([
          sequence(session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openReadOnly(client, "file"),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      const onFile = (number: number, operation: (writer: Writer) => void) =>
        handler.compound(call([
          sequence(session, number),
          (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
          operation
        ]))

      assert.strictEqual(statuses(yield* onFile(2, lock(opened.stateid, client, "a", 0n, 0n))).status, Status.INVAL)
      const first = resultStateid(yield* onFile(3, lock(opened.stateid, client, "a", 0n, 1n)), Operation.LOCK)
      assert.strictEqual(statuses(yield* onFile(4, lock(opened.stateid, client, "a", 2n, 1n))).status, Status.DELAY)
      assert.strictEqual(statuses(yield* onFile(5, lock(opened.stateid, client, "b", 2n, 1n))).status, Status.DELAY)
      const released = resultStateid(yield* onFile(6, unlock(first, 0n, 1n)), Operation.LOCKU)
      assert.strictEqual(
        statuses(yield* onFile(7, (writer) => writer.uint32(Operation.FREE_STATEID).fixedOpaque(released))).status,
        Status.OK
      )
      assert.strictEqual(
        statuses(yield* onFile(8, lock(opened.stateid, client, "b", 2n, 0xffff_ffff_ffff_ffffn))).status,
        Status.OK
      )
      assert.strictEqual(
        statuses(yield* onFile(9, lock(opened.stateid, client, "b", 0xffff_ffff_ffff_fffen, 2n))).status,
        Status.INVAL
      )
    }))

  it.effect("keeps a split within the range limit and replays a lock only once", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits: { ...limits, maxLocks: 1 }
        }
      )

      const client = yield* startSession(handler, "split-limit")

      const opened = parseOpen(
        yield* handler.compound(call([
          sequence(client.session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openReadOnly(client.client, "file"),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      const request = call([
        sequence(client.session, 2, true),
        (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
        lock(opened.stateid, client.client, "owner", 0n, 10n)
      ])

      const first = yield* handler.compound(request)
      const held = resultStateid(first, Operation.LOCK)
      assert.deepStrictEqual(yield* handler.compound(request), first)

      const onFile = (number: number, operation: (writer: Writer) => void) =>
        handler.compound(call([
          sequence(client.session, number),
          (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
          operation
        ]))

      assert.strictEqual(statuses(yield* onFile(3, unlock(held, 4n, 2n))).status, Status.DELAY)
      const released = resultStateid(yield* onFile(4, unlock(held, 0n, 5n)), Operation.LOCKU)
      assert.strictEqual(statuses(yield* onFile(5, unlock(released, 5n, 5n))).status, Status.OK)
    }))

  it.effect("does not let another client unlock an owner's byte range", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
      )

      const first = yield* startSession(handler, "first-lock-client")

      const opened = parseOpen(
        yield* handler.compound(call([
          sequence(first.session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openReadOnly(first.client, "file"),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      const granted = resultStateid(
        yield* handler.compound(call([
          sequence(first.session, 2),
          (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
          lock(opened.stateid, first.client, "owner", 0n, 1n)
        ])),
        Operation.LOCK
      )

      const second = yield* startSession(handler, "second-lock-client")

      assert.strictEqual(
        statuses(
          yield* handler.compound(call([
            sequence(second.session, 1),
            (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
            unlock(granted, 0n, 1n)
          ]))
        ).status,
        Status.BAD_STATEID
      )
      assert.strictEqual(
        statuses(
          yield* handler.compound(call([
            sequence(first.session, 3),
            (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
            (writer) => writer.uint32(Operation.CLOSE).uint32(0).fixedOpaque(opened.stateid)
          ]))
        ).status,
        Status.LOCKS_HELD
      )
    }))

  it.effect("releases lock-owner capacity when a client's lease expires", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const constrained = { ...limits, maxLockOwners: 1, maxLocks: 1 }
      let now = 0

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 1, callbackTimeout: "1 second", generation, now: () => now, limits: constrained }
      )

      const first = yield* startSession(handler, "expired-lock-client")

      const opened = parseOpen(
        yield* handler.compound(call([
          sequence(first.session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openReadOnly(first.client, "file"),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      resultStateid(
        yield* handler.compound(call([
          sequence(first.session, 2),
          (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
          lock(opened.stateid, first.client, "owner", 0n, 1n)
        ])),
        Operation.LOCK
      )
      now = 2_000
      assert.strictEqual(
        statuses(yield* handler.compound(call([sequence(first.session, 3)]))).status,
        Status.BADSESSION
      )

      const second = yield* startSession(handler, "new-lock-client")

      const reopened = parseOpen(
        yield* handler.compound(call([
          sequence(second.session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openReadOnly(second.client, "file"),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      assert.strictEqual(
        statuses(
          yield* handler.compound(call([
            sequence(second.session, 2),
            (writer) => writer.uint32(Operation.PUTFH).opaque(reopened.filehandle),
            lock(reopened.stateid, second.client, "owner", 0n, 1n)
          ]))
        ).status,
        Status.OK
      )
    }))
})
