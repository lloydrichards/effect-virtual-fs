import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import * as ByteSize from "effect/ByteSize"
import { makeExport } from "../src/internal/export.js"
import { makeNfs4Handler, type Nfs4Handler, Operation, Status } from "../src/internal/nfs4.js"
import type { CompoundCall } from "../src/internal/rpc.js"
import { Reader, Writer } from "../src/internal/xdr.js"
import { call, generation, limits, openReadOnly, parseOpen, sequence, startSession } from "./support/harness.js"

const ACCESS_ALL = 0x3f

const sys = (uid: number, gid: number, groups: ReadonlyArray<number> = []): CompoundCall["credentials"] => ({
  _tag: "Sys",
  stamp: 0,
  machineName: "probe",
  uid,
  gid,
  supplementaryGroups: groups
})

const callAs = (credentials: CompoundCall["credentials"], operations: ReadonlyArray<(writer: Writer) => void>) => ({
  ...call(operations),
  credentials
})

type DecodedBody =
  | undefined
  | Uint8Array
  | ReadonlyArray<number>
  | { readonly supported: number; readonly access: number }
  | { readonly eof: boolean; readonly data: Uint8Array }
  | { readonly clientid: bigint; readonly sequence: number; readonly flags: number }
  | { readonly session: Uint8Array; readonly sequence: number }
  | { readonly stateid: Uint8Array; readonly delegation: number; readonly why: number }
  | { readonly session: Uint8Array; readonly direction: number; readonly rdma: boolean }

type BodyReader = (reader: Reader) => DecodedBody

const bodyReaders = {
  [Operation.SEQUENCE]: (reader) => {
    reader.fixedOpaque(16)

    for (let field = 0; field < 5; field++) reader.uint32()
  },
  [Operation.PUTROOTFH]: () => undefined,
  [Operation.PUTPUBFH]: () => undefined,
  [Operation.PUTFH]: () => undefined,
  [Operation.LOOKUP]: () => undefined,
  [Operation.VERIFY]: () => undefined,
  [Operation.NVERIFY]: () => undefined,
  [Operation.FREE_STATEID]: () => undefined,
  [Operation.GETFH]: (reader) => reader.opaque(),
  [Operation.ACCESS]: (reader) => ({ supported: reader.uint32(), access: reader.uint32() }),
  [Operation.COMMIT]: (reader) => reader.fixedOpaque(8),
  [Operation.SECINFO]: (reader) => reader.array((item) => item.uint32()),
  [Operation.TEST_STATEID]: (reader) => reader.array((item) => item.uint32()),
  [Operation.OPEN_DOWNGRADE]: (reader) => reader.fixedOpaque(16),
  [Operation.CLOSE]: (reader) => reader.fixedOpaque(16),
  [Operation.LOCKT]: () => undefined,
  [Operation.READLINK]: (reader) => reader.opaque(),
  [Operation.BACKCHANNEL_CTL]: () => undefined,
  [Operation.BIND_CONN_TO_SESSION]: (reader) => ({
    session: reader.fixedOpaque(16),
    direction: reader.uint32(),
    rdma: reader.boolean()
  }),
  [Operation.READ]: (reader) => ({ eof: reader.boolean(), data: reader.opaque() }),
  [Operation.OPEN]: (reader) => {
    const stateid = reader.fixedOpaque(16)
    reader.boolean()
    reader.uint64()
    reader.uint64()
    reader.uint32()
    reader.array((item) => item.uint32())
    const delegation = reader.uint32()
    const why = delegation === 3 ? reader.uint32() : -1

    return { stateid, delegation, why }
  },
  [Operation.LOOKUPP]: () => undefined,
  [Operation.SAVEFH]: () => undefined,
  [Operation.RESTOREFH]: () => undefined,
  [Operation.RECLAIM_COMPLETE]: () => undefined,
  [Operation.DESTROY_SESSION]: () => undefined,
  [Operation.SECINFO_NO_NAME]: (reader) => reader.array((item) => item.uint32()),
  [Operation.EXCHANGE_ID]: (reader) => {
    const clientid = reader.uint64()
    const sequence = reader.uint32()
    const flags = reader.uint32()
    reader.uint32()
    reader.uint64()
    reader.opaque()
    reader.opaque()
    reader.array(() => undefined)

    return { clientid, sequence, flags }
  },
  [Operation.CREATE_SESSION]: (reader) => {
    const session = reader.fixedOpaque(16)
    const sequence = reader.uint32()
    reader.uint32()

    for (let channel = 0; channel < 2; channel++) {
      for (let field = 0; field < 6; field++) reader.uint32()
      reader.array((item) => item.uint32())
    }

    return { session, sequence }
  }
} satisfies Readonly<Record<number, BodyReader>>

const decode = (bytes: Uint8Array) => {
  const reader = new Reader(bytes, limits)
  const status = reader.uint32()
  reader.string()
  const count = reader.uint32()
  const operations: Array<{ readonly code: number; readonly status: number; readonly value?: unknown }> = []

  for (let index = 0; index < count; index++) {
    const code = reader.uint32()
    const operationStatus = reader.uint32()

    if (operationStatus !== Status.OK) {
      operations.push({ code, status: operationStatus })
      continue
    }

    // SAFETY: The own-property check proves that a known operation code indexes this table.
    const body = Object.hasOwn(bodyReaders, code) ? bodyReaders[code as keyof typeof bodyReaders] : undefined

    if (body === undefined) throw new Error(`No body reader for operation ${code}`)
    operations.push({ code, status: operationStatus, value: body(reader) })
  }

  reader.finish()

  return { status, operations }
}

const makeHandler = (caller: Vfs.Caller) =>
  makeNfs4Handler(
    makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
    { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits }
  )

const run = (handler: Nfs4Handler, request: CompoundCall) => handler.compound(request).pipe(Effect.map(decode))

const fattr = (writer: Writer, attribute: number, value: (values: Writer) => void) => {
  const values = new Writer()
  value(values)
  const words = Array.from<number>({ length: Math.floor(attribute / 32) + 1 }).fill(0)
  words[Math.floor(attribute / 32)] = (1 << (attribute % 32)) >>> 0
  writer.array(words, (item, word) => item.uint32(word)).opaque(values.bytes())
}

it.layer(NodeCrypto.layer)("read-only-local protocol completeness", (it) => {
  it.effect("answers must-not-implement and optional operations with NOTSUPP", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const handler = yield* makeHandler(caller)

      const setclientid = yield* run(handler, call([(writer) => writer.uint32(Operation.SETCLIENTID).uint32(1)]))
      assert.strictEqual(setclientid.status, Status.NOTSUPP)
      assert.deepStrictEqual(setclientid.operations, [{ code: Operation.SETCLIENTID, status: Status.NOTSUPP }])

      const optionalFirst = yield* run(handler, call([(writer) => writer.uint32(Operation.OPENATTR).boolean(false)]))
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
        ].entries()
      ) {
        const reply = yield* run(
          handler,
          call([
            sequence(session, index + 1),
            (writer) => writer.uint32(Operation.PUTROOTFH),
            (writer) => writer.uint32(code).uint32(0xdead_beef)
          ])
        )

        assert.strictEqual(reply.status, Status.NOTSUPP, `operation ${code}`)
        assert.strictEqual(reply.operations.length, 3)
        assert.strictEqual(reply.operations[1]!.status, Status.OK)
        assert.deepStrictEqual(reply.operations[2], { code, status: Status.NOTSUPP })
      }

      const unknown = yield* run(
        handler,
        call([sequence(session, 7), (writer) => writer.uint32(99_999)])
      )

      assert.deepStrictEqual(unknown.operations[1], { code: Operation.ILLEGAL, status: Status.OP_ILLEGAL })
    }))

  it.effect("completes COMMIT, PUTPUBFH, and SECINFO on a read-only export", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1, 2, 3]), { access: "write", create: "exclusive" })
      const handler = yield* makeHandler(caller)
      const { session } = yield* startSession(handler, "commit")

      const handles = yield* run(
        handler,
        call([
          sequence(session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          (writer) => writer.uint32(Operation.GETFH),
          (writer) => writer.uint32(Operation.PUTPUBFH),
          (writer) => writer.uint32(Operation.GETFH)
        ])
      )

      assert.strictEqual(handles.status, Status.OK)
      assert.deepStrictEqual(handles.operations[2]!.value, handles.operations[4]!.value)

      const commit = yield* run(
        handler,
        call([
          sequence(session, 2),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          (writer) => writer.uint32(Operation.LOOKUP).string("file"),
          (writer) => writer.uint32(Operation.COMMIT).uint64(0n).uint32(0)
        ])
      )

      assert.strictEqual(commit.status, Status.OK)
      assert.deepStrictEqual(commit.operations[3]!.value, generation.slice(0, 8))

      const commitDirectory = yield* run(
        handler,
        call([
          sequence(session, 3),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          (writer) => writer.uint32(Operation.COMMIT).uint64(0n).uint32(0)
        ])
      )

      assert.strictEqual(commitDirectory.status, Status.ISDIR)

      const secinfo = yield* run(
        handler,
        call([
          sequence(session, 4),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          (writer) => writer.uint32(Operation.SECINFO).string("file"),
          (writer) => writer.uint32(Operation.GETFH)
        ])
      )

      assert.strictEqual(secinfo.status, Status.NOFILEHANDLE, "SECINFO consumes the current filehandle")
      assert.deepStrictEqual(secinfo.operations[2]!.value, [1, 0])

      const missing = yield* run(
        handler,
        call([
          sequence(session, 5),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          (writer) => writer.uint32(Operation.SECINFO).string("missing")
        ])
      )

      assert.strictEqual(missing.status, Status.NOENT)
    }))

  it.effect("compares attributes with VERIFY and NVERIFY", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1, 2, 3]), { access: "write", create: "exclusive" })
      const handler = yield* makeHandler(caller)
      const { session } = yield* startSession(handler, "verify")

      const probe = (sequenceId: number, code: number, attribute: number, value: (values: Writer) => void) =>
        run(
          handler,
          call([
            sequence(session, sequenceId),
            (writer) => writer.uint32(Operation.PUTROOTFH),
            (writer) => writer.uint32(Operation.LOOKUP).string("file"),
            (writer) => {
              writer.uint32(code)
              fattr(writer, attribute, value)
            },
            (writer) => writer.uint32(Operation.GETFH)
          ])
        ).pipe(Effect.map((reply) => reply.status))

      assert.strictEqual(yield* probe(1, Operation.VERIFY, 4, (values) => values.uint64(3n)), Status.OK)
      assert.strictEqual(yield* probe(2, Operation.NVERIFY, 4, (values) => values.uint64(3n)), Status.SAME)
      assert.strictEqual(yield* probe(3, Operation.VERIFY, 4, (values) => values.uint64(9n)), Status.NOT_SAME)
      assert.strictEqual(yield* probe(4, Operation.NVERIFY, 4, (values) => values.uint64(9n)), Status.OK)
      assert.strictEqual(yield* probe(5, Operation.VERIFY, 1, (values) => values.uint32(1)), Status.OK)
      assert.strictEqual(yield* probe(6, Operation.VERIFY, 12, (values) => values.uint32(0)), Status.ATTRNOTSUPP)
      assert.strictEqual(yield* probe(7, Operation.VERIFY, 11, (values) => values.uint32(0)), Status.INVAL)
    }))

  it.effect("manages open stateids with OPEN_DOWNGRADE, TEST_STATEID, and FREE_STATEID", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const handler = yield* makeHandler(caller)
      const { client, session } = yield* startSession(handler, "stateids")

      const opened = parseOpen(
        yield* handler.compound(call([
          sequence(session, 1, true),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openReadOnly(client, "file"),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      const downgrade = yield* run(
        handler,
        call([
          sequence(session, 2),
          (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
          (writer) => writer.uint32(Operation.OPEN_DOWNGRADE).fixedOpaque(opened.stateid).uint32(0).uint32(1).uint32(0)
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
          (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
          (writer) => writer.uint32(Operation.OPEN_DOWNGRADE).fixedOpaque(downgraded).uint32(0).uint32(2).uint32(0)
        ])
      )

      assert.strictEqual(widen.status, Status.INVAL)

      const unknownStateid = new Uint8Array(16).fill(0x42)

      const tested = yield* run(
        handler,
        call([
          sequence(session, 4),
          (writer) =>
            writer.uint32(Operation.TEST_STATEID).array(
              [downgraded, opened.stateid, unknownStateid, new Uint8Array(16)],
              (item, stateid) => item.fixedOpaque(stateid)
            )
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
        call([sequence(session, 5), (writer) => writer.uint32(Operation.FREE_STATEID).fixedOpaque(downgraded)])
      )

      assert.strictEqual(held.status, Status.LOCKS_HELD)

      const freeUnknown = yield* run(
        handler,
        call([sequence(session, 6), (writer) => writer.uint32(Operation.FREE_STATEID).fixedOpaque(unknownStateid)])
      )

      assert.strictEqual(freeUnknown.status, Status.BAD_STATEID)

      const badDowngrade = yield* run(
        handler,
        call([
          sequence(session, 7),
          (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
          (writer) => writer.uint32(Operation.OPEN_DOWNGRADE).fixedOpaque(unknownStateid).uint32(0).uint32(1).uint32(0)
        ])
      )

      assert.strictEqual(badDowngrade.status, Status.BAD_STATEID)
    }))

  it.effect("validates lock stateids and rejects write-lock tests on a read-only export", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const handler = yield* makeHandler(caller)
      const { client, session } = yield* startSession(handler, "locks")

      const onFile = (sequenceId: number, operation: (writer: Writer) => void) =>
        run(
          handler,
          call([
            sequence(session, sequenceId),
            (writer) => writer.uint32(Operation.PUTROOTFH),
            (writer) => writer.uint32(Operation.LOOKUP).string("file"),
            operation
          ])
        ).pipe(Effect.map((reply) => reply.status))

      const lock = (writer: Writer) =>
        writer.uint32(Operation.LOCK).uint32(1).boolean(false).uint64(0n).uint64(0xffff_ffff_ffff_ffffn)
          .boolean(true).uint32(0).fixedOpaque(new Uint8Array(16)).uint32(0).uint64(client).string("lock-owner")

      assert.strictEqual(yield* onFile(1, lock), Status.BAD_STATEID)

      // A write-lock test reports the read-only file system; a read-lock test finds no conflict.
      const lockt = (writer: Writer) =>
        writer.uint32(Operation.LOCKT).uint32(2).uint64(0n).uint64(1n).uint64(client).string("lock-owner")

      assert.strictEqual(yield* onFile(2, lockt), Status.ROFS)

      const locku = (writer: Writer) =>
        writer.uint32(Operation.LOCKU).uint32(1).uint32(0).fixedOpaque(new Uint8Array(16).fill(9)).uint64(0n)
          .uint64(1n)

      assert.strictEqual(yield* onFile(3, locku), Status.BAD_STATEID)

      const setSsv = (writer: Writer) =>
        writer.uint32(Operation.SET_SSV).opaque(new Uint8Array(4)).opaque(new Uint8Array(4))

      assert.strictEqual(yield* onFile(4, setSsv), Status.INVAL)

      const truncatedLock = (writer: Writer) => writer.uint32(Operation.LOCK).uint32(1).boolean(false)
      assert.strictEqual(yield* onFile(5, truncatedLock), Status.BADXDR)
    }))

  it.effect("reports ACCESS from mode bits against the RPC identity without granting writes", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      yield* caller.chmod("/file", 0o640)
      yield* caller.chown("/file", { uid: 501, gid: 20 })
      yield* caller.writeFile("/tool", new Uint8Array([1]), { access: "write", create: "exclusive" })
      yield* caller.chmod("/tool", 0o750)
      yield* caller.chown("/tool", { uid: 501, gid: 20 })
      yield* caller.mkdir("/dir")
      yield* caller.chmod("/dir", 0o751)
      yield* caller.chown("/dir", { uid: 501, gid: 20 })
      const handler = yield* makeHandler(caller)
      const { session } = yield* startSession(handler, "access")
      let sequenceId = 0

      const access = (credentials: CompoundCall["credentials"], name: string) =>
        run(
          handler,
          callAs(credentials, [
            sequence(session, ++sequenceId),
            (writer) => writer.uint32(Operation.PUTROOTFH),
            (writer) => writer.uint32(Operation.LOOKUP).string(name),
            (writer) => writer.uint32(Operation.ACCESS).uint32(ACCESS_ALL)
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
    }))

  it.effect("distinguishes reserved names from invalid names", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const handler = yield* makeHandler(caller)
      const { session } = yield* startSession(handler, "names")

      const lookup = (sequenceId: number, name: Uint8Array) =>
        run(
          handler,
          call([
            sequence(session, sequenceId),
            (writer) => writer.uint32(Operation.PUTROOTFH),
            (writer) => writer.uint32(Operation.LOOKUP).opaque(name)
          ])
        ).pipe(Effect.map((reply) => reply.status))

      assert.strictEqual(yield* lookup(1, new TextEncoder().encode(".")), Status.BADNAME)
      assert.strictEqual(yield* lookup(2, new TextEncoder().encode("..")), Status.BADNAME)
      assert.strictEqual(yield* lookup(3, new Uint8Array([0xff, 0xfe])), Status.INVAL)
      assert.strictEqual(yield* lookup(4, new TextEncoder().encode("missing")), Status.NOENT)
    }))

  it.effect("follows the EXCHANGE_ID client record cases of RFC 8881 Section 18.35.4", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const handler = yield* makeHandler(caller)
      const owner = "record-cases"

      type Exchanged = { readonly clientid: bigint; readonly sequence: number; readonly flags: number }

      const exchange = (credentials: CompoundCall["credentials"], verifier: Uint8Array, flags = 0) =>
        run(
          handler,
          callAs(credentials, [(writer) =>
            writer.uint32(Operation.EXCHANGE_ID).fixedOpaque(verifier).string(owner).uint32(flags).uint32(0)
              .uint32(0)])
        ).pipe(Effect.map((reply) => {
          // SAFETY: EXCHANGE_ID succeeded, so the body reader table produced the EXCHANGE_ID result shape.
          const value = reply.operations[0]!.value as Exchanged

          return { status: reply.status, value }
        }))

      const createSession = (credentials: CompoundCall["credentials"], clientid: bigint, sequenceId: number) =>
        run(
          handler,
          callAs(credentials, [(writer) => {
            writer.uint32(Operation.CREATE_SESSION).uint64(clientid).uint32(sequenceId).uint32(0)

            for (let channel = 0; channel < 2; channel++) {
              writer.uint32(0).uint32(8192).uint32(8192).uint32(8192).uint32(32).uint32(2).uint32(0)
            }

            writer.uint32(0).uint32(0)
          }])
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
        call([(writer) => writer.uint32(Operation.DESTROY_SESSION).fixedOpaque(session)])
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
    }))

  it.effect("guards CREATE_SESSION by principal, channel size, and operation-level replay", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const handler = yield* makeHandler(caller)

      const exchanged = yield* run(
        handler,
        callAs(sys(501, 20), [
          (writer) =>
            writer.uint32(Operation.EXCHANGE_ID).fixedOpaque(new Uint8Array(8)).string("session-guards").uint32(0)
              .uint32(0).uint32(0)
        ])
      )

      // SAFETY: EXCHANGE_ID succeeded, so the body reader table produced the EXCHANGE_ID result shape.
      const { clientid, sequence: firstSequence } = exchanged.operations[0]!.value as {
        readonly clientid: bigint
        readonly sequence: number
      }

      const createSession =
        (sequenceId: number, maxRequest = 8192, maxResponse = 8192, flags = 0) => (writer: Writer) => {
          writer.uint32(Operation.CREATE_SESSION).uint64(clientid).uint32(sequenceId).uint32(flags)
          writer.uint32(0).uint32(maxRequest).uint32(maxResponse).uint32(8192).uint32(32).uint32(2).uint32(0)
          writer.uint32(0).uint32(8192).uint32(8192).uint32(8192).uint32(32).uint32(2).uint32(0)
          writer.uint32(0).uint32(0)
        }

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
    }))

  it.effect("scopes RECLAIM_COMPLETE with rca_one_fs to the current filehandle", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const handler = yield* makeHandler(caller)
      const { session } = yield* startSession(handler, "reclaim")
      const reclaim = (oneFs: boolean) => (writer: Writer) => writer.uint32(Operation.RECLAIM_COMPLETE).boolean(oneFs)

      const oneFs = yield* run(
        handler,
        call([sequence(session, 1), (writer) => writer.uint32(Operation.PUTROOTFH), reclaim(true)])
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
    }))

  it.effect("answers SECINFO_NO_NAME for the current object and its parent", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.mkdir("/dir")
      const handler = yield* makeHandler(caller)
      const { session } = yield* startSession(handler, "secinfo-no-name")

      const current = yield* run(
        handler,
        call([
          sequence(session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          (writer) => writer.uint32(Operation.SECINFO_NO_NAME).uint32(0),
          (writer) => writer.uint32(Operation.GETFH)
        ])
      )

      assert.strictEqual(current.status, Status.NOFILEHANDLE)
      assert.deepStrictEqual(current.operations[2]!.value, [1, 0])

      const rootParent = yield* run(
        handler,
        call([
          sequence(session, 2),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          (writer) => writer.uint32(Operation.SECINFO_NO_NAME).uint32(1)
        ])
      )

      assert.strictEqual(rootParent.status, Status.NOENT)

      const parent = yield* run(
        handler,
        call([
          sequence(session, 3),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          (writer) => writer.uint32(Operation.LOOKUP).string("dir"),
          (writer) => writer.uint32(Operation.SECINFO_NO_NAME).uint32(1)
        ])
      )

      assert.strictEqual(parent.status, Status.OK)

      const lookupp = yield* run(
        handler,
        call([
          sequence(session, 4),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          (writer) => writer.uint32(Operation.LOOKUPP)
        ])
      )

      assert.strictEqual(lookupp.status, Status.NOENT)

      const badStyle = yield* run(
        handler,
        call([
          sequence(session, 5),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          (writer) => writer.uint32(Operation.SECINFO_NO_NAME).uint32(7)
        ])
      )

      assert.strictEqual(badStyle.status, Status.BADXDR)
    }))

  it.effect("answers delegation wants in OPEN share_access with OPEN_DELEGATE_NONE_EXT", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1, 2, 3]), { access: "write", create: "exclusive" })
      const handler = yield* makeHandler(caller)
      const { session } = yield* startSession(handler, "wants")
      let sequenceId = 0

      // The macOS 26 client opens with CLAIM_FH and OPEN4_SHARE_ACCESS_WANT_READ_DELEG (0x0100).
      const open = (shareAccess: number) =>
        run(
          handler,
          callAs(sys(501, 20), [
            sequence(session, ++sequenceId),
            (writer) => writer.uint32(Operation.PUTROOTFH),
            (writer) => writer.uint32(Operation.LOOKUP).string("file"),
            (writer) =>
              writer.uint32(Operation.OPEN).uint32(1).uint32(shareAccess).uint32(0).uint64(1n).string("mac")
                .uint32(0).uint32(4),
            (writer) =>
              writer.uint32(Operation.READ).fixedOpaque(new Uint8Array([0, 0, 0, 1, ...new Uint8Array(12)]))
                .uint64(0n).uint32(16)
          ])
        )

      const expectOpen = (reply: Awaited<ReturnType<typeof decode>>, delegation: number, why: number) => {
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
    }))

  it.effect("substitutes the current stateid in OPEN_DOWNGRADE and CLOSE within one compound", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const handler = yield* makeHandler(caller)
      const { client, session } = yield* startSession(handler, "current-stateid")
      const current = new Uint8Array([0, 0, 0, 1, ...new Uint8Array(12)])

      const reply = yield* run(
        handler,
        call([
          sequence(session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openReadOnly(client, "file"),
          (writer) => writer.uint32(Operation.OPEN_DOWNGRADE).fixedOpaque(current).uint32(0).uint32(1).uint32(0),
          (writer) => writer.uint32(Operation.READ).fixedOpaque(current).uint64(0n).uint32(4),
          (writer) => writer.uint32(Operation.CLOSE).uint32(0).fixedOpaque(current)
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
    }))

  it.effect("keeps RFC precedence for replayed CREATE_SESSION, write-only VERIFY attributes, and minimal channels", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const handler = yield* makeHandler(caller)

      const exchanged = yield* run(
        handler,
        call([
          (writer) =>
            writer.uint32(Operation.EXCHANGE_ID).fixedOpaque(new Uint8Array(8)).string("precedence").uint32(0).uint32(0)
              .uint32(0)
        ])
      )

      // SAFETY: EXCHANGE_ID succeeded, so the body reader table produced the EXCHANGE_ID result shape.
      const { clientid, sequence: firstSequence } = exchanged.operations[0]!.value as {
        readonly clientid: bigint
        readonly sequence: number
      }

      const createSession = (sequenceId: number, flags: number, maxResponse: number) => (writer: Writer) => {
        writer.uint32(Operation.CREATE_SESSION).uint64(clientid).uint32(sequenceId).uint32(flags)
        writer.uint32(0).uint32(8192).uint32(maxResponse).uint32(8192).uint32(32).uint32(2).uint32(0)
        writer.uint32(0).uint32(8192).uint32(8192).uint32(8192).uint32(32).uint32(2).uint32(0)
        writer.uint32(0).uint32(0)
      }

      // The smallest usable response channel is an RPC reply carrying a SEQUENCE-only compound.
      // The failed attempt consumes the slot, so the corrected request uses the next sequence.
      assert.strictEqual((yield* run(handler, call([createSession(firstSequence, 0, 79)]))).status, Status.TOOSMALL)
      const created = yield* run(handler, call([createSession(firstSequence + 1, 0, 80)]))
      assert.strictEqual(created.status, Status.OK)
      // An equal csa_sequence replays the cached result before any argument validation.
      const replayed = yield* run(handler, call([createSession(firstSequence + 1, 0xf, 80)]))
      assert.deepStrictEqual(replayed.operations[0]!.value, created.operations[0]!.value)

      // A normal channel for the attribute check; the 80-byte one cannot carry this reply.
      const { session } = yield* startSession(handler, "precedence-verify")

      const verify = yield* run(
        handler,
        call([
          sequence(session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          (writer) => writer.uint32(Operation.LOOKUP).string("file"),
          (writer) => {
            writer.uint32(Operation.VERIFY)
            fattr(writer, 48, (values) => values.uint32(0))
          }
        ])
      )

      assert.strictEqual(verify.status, Status.INVAL, "time_access_set is write-only, not unsupported")
    }))

  it.effect("rejects an oversized reply before any state-changing operation runs", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
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
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openReadOnly(client, "file"),
          (writer) => writer.uint32(Operation.GETATTR).array(allAttributes, (item, word) => item.uint32(word))
        ])
      )

      assert.strictEqual(tooBig.status, Status.REP_TOO_BIG)
      assert.strictEqual(tooBig.operations.length, 1, "rejected at SEQUENCE, before OPEN executed")

      // The open never happened, so a fresh OPEN yields seqid 1 rather than a bumped seqid.
      const opened = parseOpen(
        yield* handler.compound(call([
          sequence(session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openReadOnly(client, "file"),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      assert.strictEqual(new DataView(opened.stateid.buffer).getUint32(0), 1)

      // DESTROY_SESSION of another session changes state too, so it is also gated by the preflight.
      const destroyTooBig = yield* run(
        handler,
        call([
          sequence(session, 2),
          (writer) => writer.uint32(Operation.DESTROY_SESSION).fixedOpaque(other.session),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          (writer) =>
            writer.uint32(Operation.READDIR).uint64(0n).fixedOpaque(new Uint8Array(8)).uint32(0).uint32(16_384)
              .uint32(0)
        ])
      )

      assert.strictEqual(destroyTooBig.status, Status.REP_TOO_BIG)
      assert.strictEqual((yield* run(handler, call([sequence(other.session, 1)]))).status, Status.OK)
    }))

  it.effect("renews the lease on CREATE_SESSION and rejects channels without room for two operations", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      let now = 0

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => now, limits }
      )

      const exchanged = yield* run(
        handler,
        call([
          (writer) =>
            writer.uint32(Operation.EXCHANGE_ID).fixedOpaque(new Uint8Array(8)).string("lease").uint32(0).uint32(0)
              .uint32(0)
        ])
      )

      // SAFETY: EXCHANGE_ID succeeded, so the body reader table produced the EXCHANGE_ID result shape.
      const { clientid, sequence: firstSequence } = exchanged.operations[0]!.value as {
        readonly clientid: bigint
        readonly sequence: number
      }

      const createSession = (maxOperations: number, sequenceId: number) => (writer: Writer) => {
        writer.uint32(Operation.CREATE_SESSION).uint64(clientid).uint32(sequenceId).uint32(0)
        writer.uint32(0).uint32(8192).uint32(8192).uint32(8192).uint32(maxOperations).uint32(2).uint32(0)
        writer.uint32(0).uint32(8192).uint32(8192).uint32(8192).uint32(32).uint32(2).uint32(0)
        writer.uint32(0).uint32(0)
      }

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
    }))

  it.effect("checks filehandles, object kinds, and names before rejecting mutations as read-only", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      yield* caller.symlink("file", "/link")
      const handler = yield* makeHandler(caller)
      const { session } = yield* startSession(handler, "precedence")
      let sequenceId = 0

      const attempt = (...operations: ReadonlyArray<(writer: Writer) => void>) =>
        run(handler, call([sequence(session, ++sequenceId), ...operations])).pipe(Effect.map((reply) => reply.status))

      const root = (writer: Writer) => writer.uint32(Operation.PUTROOTFH)
      const lookup = (name: string) => (writer: Writer) => writer.uint32(Operation.LOOKUP).string(name)
      const remove = (name: string) => (writer: Writer) => writer.uint32(Operation.REMOVE).string(name)
      const rename = (writer: Writer) => writer.uint32(Operation.RENAME).string("file").string("moved")
      const link = (writer: Writer) => writer.uint32(Operation.LINK).string("linked")
      const savefh = (writer: Writer) => writer.uint32(Operation.SAVEFH)

      assert.strictEqual(yield* attempt(remove("file")), Status.NOFILEHANDLE)
      assert.strictEqual(yield* attempt(root, rename), Status.NOFILEHANDLE, "RENAME needs a saved filehandle")
      assert.strictEqual(yield* attempt(root, link), Status.NOFILEHANDLE, "LINK needs a saved object")
      assert.strictEqual(yield* attempt(root, lookup("file"), remove("x")), Status.NOTDIR)
      assert.strictEqual(yield* attempt(root, lookup("link"), remove("x")), Status.NOTDIR, "REMOVE lists no SYMLINK")
      assert.strictEqual(yield* attempt(root, lookup("file"), savefh, root, rename), Status.NOTDIR, "saved source dir")
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
    }))

  it.effect("bounds the back channel and the client-record table", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const constrained = { ...limits, maxClients: 2 }

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }),
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits: constrained }
      )

      const exchange = (owner: string) =>
        run(
          handler,
          call([(writer) =>
            writer.uint32(Operation.EXCHANGE_ID).fixedOpaque(new Uint8Array(8)).string(owner).uint32(0).uint32(0)
              .uint32(0)])
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
        call([(writer) => {
          writer.uint32(Operation.CREATE_SESSION).uint64(clientid).uint32(firstSequence).uint32(0)
          writer.uint32(0).uint32(8192).uint32(8192).uint32(8192).uint32(32).uint32(2).uint32(0)
          writer.uint32(0).uint32(10).uint32(8192).uint32(8192).uint32(32).uint32(1).uint32(0)
          writer.uint32(0).uint32(0)
        }])
      )

      assert.strictEqual(backTooSmall.status, Status.TOOSMALL)
    }))

  it.effect("names the object type when OPEN, READ, COMMIT, and locks meet a non-regular object", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1, 2, 3, 4]), { access: "write", create: "exclusive" })
      yield* caller.mkdir("/dir")
      yield* caller.symlink("file", "/link")
      const handler = yield* makeHandler(caller)
      const { client, session } = yield* startSession(handler, "object-types")
      let sequenceId = 0

      const attempt = (...operations: ReadonlyArray<(writer: Writer) => void>) =>
        run(handler, call([sequence(session, ++sequenceId), ...operations]))

      const status = (...operations: ReadonlyArray<(writer: Writer) => void>) =>
        attempt(...operations).pipe(Effect.map((reply) => reply.status))

      const root = (writer: Writer) => writer.uint32(Operation.PUTROOTFH)
      const lookup = (name: string) => (writer: Writer) => writer.uint32(Operation.LOOKUP).string(name)
      const anonymous = new Uint8Array(16)
      const read = (writer: Writer) => writer.uint32(Operation.READ).fixedOpaque(anonymous).uint64(0n).uint32(4)
      const commit = (writer: Writer) => writer.uint32(Operation.COMMIT).uint64(0n).uint32(0)

      const lock = (lockType: number) => (writer: Writer) =>
        writer.uint32(Operation.LOCK).uint32(lockType).boolean(false).uint64(0n).uint64(1n).boolean(true).uint32(0)
          .fixedOpaque(anonymous).uint32(0).uint64(client).string("lock-owner")

      const lockt = (lockType: number) => (writer: Writer) =>
        writer.uint32(Operation.LOCKT).uint32(lockType).uint64(0n).uint64(1n).uint64(client).string("lock-owner")

      const locku = (writer: Writer) =>
        writer.uint32(Operation.LOCKU).uint32(1).uint32(0).fixedOpaque(anonymous).uint64(0n).uint64(1n)

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
      assert.strictEqual(yield* status(root, lookup("file"), lockt(1)), Status.OK, "no lock conflicts with a read test")
      assert.strictEqual(yield* status(root, lookup("file"), lockt(4)), Status.ROFS, "WRITEW_LT")
      assert.strictEqual(yield* status(root, lookup("file"), locku), Status.BAD_STATEID)
      assert.strictEqual(yield* status(locku), Status.NOFILEHANDLE)

      const badLockType = yield* attempt(root, lookup("file"), lock(5))
      assert.strictEqual(badLockType.status, Status.BADXDR)
      assert.deepStrictEqual(badLockType.operations[3], { code: Operation.LOCK, status: Status.BADXDR })

      const badUnlockType = yield* attempt(
        root,
        lookup("file"),
        (writer) => writer.uint32(Operation.LOCKU).uint32(0).uint32(0).fixedOpaque(anonymous).uint64(0n).uint64(1n)
      )

      assert.deepStrictEqual(badUnlockType.operations[3], { code: Operation.LOCKU, status: Status.BADXDR })
    }))

  it.effect("answers reclaim claims, share reservations, and masked downgrades per Sections 18.16 and 18.18", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const handler = yield* makeHandler(caller)
      const { client, session } = yield* startSession(handler, "share-reservations")
      let sequenceId = 0

      const attempt = (...operations: ReadonlyArray<(writer: Writer) => void>) =>
        run(handler, call([sequence(session, ++sequenceId), ...operations]))

      const root = (writer: Writer) => writer.uint32(Operation.PUTROOTFH)
      const lookup = (name: string) => (writer: Writer) => writer.uint32(Operation.LOOKUP).string(name)

      const openAs = (owner: string, deny: number, claim = 0) => (writer: Writer) => {
        writer.uint32(Operation.OPEN).uint32(0).uint32(1).uint32(deny).uint64(client).string(owner).uint32(0)
          .uint32(claim)

        if (claim === 0) writer.string("file")
        else if (claim === 1) writer.uint32(0)
        else if (claim === 3) writer.string("")
        else if (claim === 2) writer.fixedOpaque(new Uint8Array(16)).string("file")
        else if (claim === 5) writer.fixedOpaque(new Uint8Array(16))
      }

      const stateidOf = (reply: ReturnType<typeof decode>, index: number) =>
        // SAFETY: the caller asserted that OPEN at this index succeeded, so its body is the OPEN result shape.
        (reply.operations[index]!.value as { readonly stateid: Uint8Array }).stateid

      const close = (stateid: Uint8Array) => (writer: Writer) =>
        writer.uint32(Operation.CLOSE).uint32(0).fixedOpaque(stateid)

      const downgrade = (stateid: Uint8Array, access: number, deny: number) => (writer: Writer) =>
        writer.uint32(Operation.OPEN_DOWNGRADE).fixedOpaque(stateid).uint32(0).uint32(access).uint32(deny)

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
    }))

  it.effect("moves the current stateid with the filehandle", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/a", new Uint8Array([1]), { access: "write", create: "exclusive" })
      yield* caller.writeFile("/b", new Uint8Array([2]), { access: "write", create: "exclusive" })
      const handler = yield* makeHandler(caller)
      const { client, session } = yield* startSession(handler, "current-stateid-set")
      const current = new Uint8Array([0, 0, 0, 1, ...new Uint8Array(12)])
      const root = (writer: Writer) => writer.uint32(Operation.PUTROOTFH)
      const lookup = (name: string) => (writer: Writer) => writer.uint32(Operation.LOOKUP).string(name)

      const read = (stateid: Uint8Array) => (writer: Writer) =>
        writer.uint32(Operation.READ).fixedOpaque(stateid).uint64(0n).uint32(1)

      const close = (writer: Writer) => writer.uint32(Operation.CLOSE).uint32(0).fixedOpaque(current)

      // Section 16.2.3.1.2: SAVEFH and RESTOREFH carry the stateid with the filehandle.
      const saved = yield* run(
        handler,
        call([
          sequence(session, 1),
          root,
          openReadOnly(client, "a"),
          (writer) => writer.uint32(Operation.SAVEFH),
          root,
          openReadOnly(client, "b"),
          (writer) => writer.uint32(Operation.RESTOREFH),
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
          (writer) => writer.uint32(Operation.OPEN_DOWNGRADE).fixedOpaque(current).uint32(0).uint32(1).uint32(0)
        ])
      )

      assert.strictEqual(downgrade.status, Status.NOFILEHANDLE)
    }))

  it.effect("binds connections, accepts backchannel parameters, and judges a misplaced SEQUENCE in place", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const handler = yield* makeHandler(caller)
      const { session } = yield* startSession(handler, "bind")

      const bind = (id: Uint8Array) => (writer: Writer) =>
        writer.uint32(Operation.BIND_CONN_TO_SESSION).fixedOpaque(id).uint32(3).boolean(false)

      const bindDirection = (direction: number) => (writer: Writer) =>
        writer.uint32(Operation.BIND_CONN_TO_SESSION).fixedOpaque(session).uint32(direction).boolean(false)

      // Section 18.34.3: the sole operation of its compound, with or without a session; the
      // connection is already the fore channel, so fore-channel requests succeed as CDFS4_FORE.
      const unknown = yield* run(handler, call([bind(new Uint8Array(16).fill(1))]))
      assert.deepStrictEqual(unknown.operations, [{ code: Operation.BIND_CONN_TO_SESSION, status: Status.BADSESSION }])
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
      const followed = yield* run(handler, call([bind(session), (writer) => writer.uint32(Operation.PUTROOTFH)]))
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
      assert.deepStrictEqual(badDirection.operations, [{ code: Operation.BIND_CONN_TO_SESSION, status: Status.BADXDR }])

      const backchannelCtl = (flavors: (writer: Writer) => void) => (writer: Writer) => {
        writer.uint32(Operation.BACKCHANNEL_CTL).uint32(0x4000_0001)
        flavors(writer)
      }

      const authSys = (writer: Writer) => {
        writer.uint32(1).uint32(0).string("probe").uint32(501).uint32(20).array([], () => undefined)
      }

      const gss = (writer: Writer) => writer.uint32(6).uint32(0).opaque(new Uint8Array([1])).opaque(new Uint8Array([2]))

      const backchannel = yield* run(
        handler,
        call([
          sequence(session, 2),
          backchannelCtl((writer) =>
            writer.array([0, 1], (item, flavor) => {
              if (flavor === 0) item.uint32(0)
              else authSys(item)
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
        call([sequence(session, 3), backchannelCtl((writer) => writer.array([1], (item) => gss(item)))])
      )

      assert.deepStrictEqual(gssHandle.operations[1], { code: Operation.BACKCHANNEL_CTL, status: Status.NOENT })
      const withoutSession = yield* run(handler, call([backchannelCtl((writer) => writer.array([], () => undefined))]))
      assert.deepStrictEqual(withoutSession.operations, [{
        code: Operation.BACKCHANNEL_CTL,
        status: Status.OP_NOT_IN_SESSION
      }])

      const badFlavor = yield* run(
        handler,
        call([
          sequence(session, 4),
          backchannelCtl((writer) => writer.array([9], (item, flavor) => item.uint32(flavor)))
        ])
      )

      assert.deepStrictEqual(badFlavor.operations[1], { code: Operation.BACKCHANNEL_CTL, status: Status.BADXDR })

      // A SEQUENCE after other operations answers SEQUENCE_POS in place; the earlier ones ran.
      const misplaced = yield* run(
        handler,
        call([sequence(session, 5), (writer) => writer.uint32(Operation.PUTROOTFH), sequence(session, 6)])
      )

      assert.strictEqual(misplaced.status, Status.SEQUENCE_POS)
      assert.strictEqual(misplaced.operations.length, 3)
      assert.strictEqual(misplaced.operations[1]!.status, Status.OK)
      assert.strictEqual((yield* run(handler, call([sequence(session, 6)]))).status, Status.OK, "slot 5 was consumed")

      const bootstrapPair = yield* run(
        handler,
        call([(writer) => writer.uint32(Operation.DESTROY_SESSION).fixedOpaque(session), sequence(session, 7)])
      )

      assert.deepStrictEqual(bootstrapPair.operations, [{
        code: Operation.DESTROY_SESSION,
        status: Status.NOT_ONLY_OP
      }])
    }))

  it.effect("keeps anonymous READ, LOOKUP, READLINK, LOCKU, and OPEN4_CREATE inside their error lists", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1, 2]), { access: "write", create: "exclusive" })
      yield* caller.mkdir("/dir")
      yield* caller.symlink("file", "/link")
      const handler = yield* makeHandler(caller)
      const { client, session } = yield* startSession(handler, "error-lists")
      let sequenceId = 0

      const attempt = (...operations: ReadonlyArray<(writer: Writer) => void>) =>
        run(handler, call([sequence(session, ++sequenceId), ...operations]))

      const status = (...operations: ReadonlyArray<(writer: Writer) => void>) =>
        attempt(...operations).pipe(Effect.map((reply) => reply.status))

      const root = (writer: Writer) => writer.uint32(Operation.PUTROOTFH)
      const lookup = (name: string) => (writer: Writer) => writer.uint32(Operation.LOOKUP).string(name)
      const readlink = (writer: Writer) => writer.uint32(Operation.READLINK)
      const anonymous = new Uint8Array(16)
      const bypass = new Uint8Array(16).fill(0xff)

      const read = (stateid: Uint8Array) => (writer: Writer) =>
        writer.uint32(Operation.READ).fixedOpaque(stateid).uint64(0n).uint32(2)

      const openAs = (owner: string, deny: number) => (writer: Writer) =>
        writer.uint32(Operation.OPEN).uint32(0).uint32(1).uint32(deny).uint64(client).string(owner).uint32(0)
          .uint32(0).string("file")

      const create = (name: string, claim = 0, access = 1) => (writer: Writer) => {
        writer.uint32(Operation.OPEN).uint32(0).uint32(access).uint32(0).uint64(client).string("creator").uint32(1)
          .uint32(0).array([], () => undefined).opaque(new Uint8Array()).uint32(claim)

        if (claim === 0) writer.string(name)
      }

      // Section 9.1.2: the anonymous stateid respects a deny-read reservation; all ones bypasses it.
      assert.strictEqual(yield* status(root, lookup("file"), read(anonymous)), Status.OK)
      const holder = yield* attempt(root, openAs("holder", 1))
      assert.strictEqual(holder.status, Status.OK)
      assert.strictEqual(yield* status(root, lookup("file"), read(anonymous)), Status.LOCKED)
      assert.strictEqual(yield* status(root, lookup("file"), read(bypass)), Status.OK)
      // SAFETY: OPEN succeeded, so its body is the OPEN result shape.
      const holderStateid = (holder.operations[2]!.value as { readonly stateid: Uint8Array }).stateid
      const close = (writer: Writer) => writer.uint32(Operation.CLOSE).uint32(0).fixedOpaque(holderStateid)
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
      const locku = (writer: Writer) =>
        writer.uint32(Operation.LOCKU).uint32(1).uint32(0).fixedOpaque(anonymous).uint64(0n).uint64(1n)

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
    }))

  it.effect("rejects a READ that cannot fit the channel before it touches the file", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1, 2, 3]), { access: "write", create: "exclusive" })
      const before = (yield* caller.stat("/file")).atimeNs
      const handler = yield* makeHandler(caller)
      const { session } = yield* startSession(handler, "read-preflight", { maxResponse: 512 })

      // Reading updates the access time, so the worst-case reply must fit before READ runs.
      const reply = yield* run(
        handler,
        call([
          sequence(session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          (writer) => writer.uint32(Operation.LOOKUP).string("file"),
          (writer) => writer.uint32(Operation.READ).fixedOpaque(new Uint8Array(16)).uint64(0n).uint32(4_096)
        ])
      )

      assert.deepStrictEqual(reply.operations, [{ code: Operation.SEQUENCE, status: Status.REP_TOO_BIG }])
      assert.strictEqual((yield* caller.stat("/file")).atimeNs, before)

      const fitting = yield* run(
        handler,
        call([
          sequence(session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          (writer) => writer.uint32(Operation.LOOKUP).string("file"),
          (writer) => writer.uint32(Operation.READ).fixedOpaque(new Uint8Array(16)).uint64(0n).uint32(64)
        ])
      )

      assert.strictEqual(fitting.status, Status.OK)
    }))

  it.effect("reports TOO_MANY_OPS from the header count even when a later operation is malformed", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const handler = yield* makeHandler(caller)
      const { session } = yield* startSession(handler, "count", { maxOperations: 3 })

      const oversized = call([
        sequence(session, 1),
        (writer) => writer.uint32(Operation.LOOKUP).uint32(100),
        (writer) => writer.uint32(Operation.GETFH),
        (writer) => writer.uint32(Operation.GETFH)
      ])

      assert.deepStrictEqual((yield* run(handler, oversized)).operations, [
        { code: Operation.SEQUENCE, status: Status.TOO_MANY_OPS }
      ])
    }))

  it.effect("reports an illegal first opcode as OP_ILLEGAL and a malformed operation in place", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const handler = yield* makeHandler(caller)

      const illegal = yield* run(handler, call([(writer) => writer.uint32(99_999)]))
      assert.deepStrictEqual(illegal.operations, [{ code: Operation.ILLEGAL, status: Status.OP_ILLEGAL }])

      // A LOOKUP whose name length exceeds the remaining bytes never decodes.
      const truncatedLookup = (writer: Writer) => writer.uint32(Operation.LOOKUP).uint32(100)
      const beforeSession = yield* run(handler, call([truncatedLookup]))
      assert.deepStrictEqual(beforeSession.operations, [{ code: Operation.LOOKUP, status: Status.BADXDR }])

      const { session } = yield* startSession(handler, "malformed")

      const request = call([
        sequence(session, 1, true),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        truncatedLookup,
        (writer) => writer.uint32(Operation.GETFH)
      ])

      // Section 15.1.1.1: the operations before the malformed one are processed and reported.
      const first = yield* handler.compound(request)
      const reply = decode(first)
      assert.strictEqual(reply.status, Status.BADXDR)
      assert.strictEqual(reply.operations.length, 3)
      assert.strictEqual(reply.operations[1]!.status, Status.OK)
      assert.deepStrictEqual(reply.operations[2], { code: Operation.LOOKUP, status: Status.BADXDR })

      // The slot was consumed, so the retry is served from the reply cache.
      assert.deepStrictEqual(yield* handler.compound(request), first)
    }))

  it.effect("rejects state protection it cannot honor and names forbidden bytes as BADCHAR", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const handler = yield* makeHandler(caller)

      const exchange = (protection: (writer: Writer) => void) =>
        run(
          handler,
          call([(writer) => {
            writer.uint32(Operation.EXCHANGE_ID).fixedOpaque(new Uint8Array(8)).string("protected").uint32(0)
            protection(writer)
            writer.array([], () => undefined)
          }])
        )

      const ops = (writer: Writer) => writer.array([], () => undefined).array([], () => undefined)

      // Section 18.35.3: SP4_MACH_CRED needs RPCSEC_GSS integrity, which AUTH_SYS cannot give.
      const machCred = yield* exchange((writer) => ops(writer.uint32(1)))
      assert.deepStrictEqual(machCred.operations, [{ code: Operation.EXCHANGE_ID, status: Status.INVAL }])

      const machCredWithOps = yield* exchange((writer) =>
        writer.uint32(1).array([0x0800_0000, 0x0000_0002], (item, word) => item.uint32(word))
          .array([0x0000_0400], (item, word) => item.uint32(word))
      )

      assert.deepStrictEqual(machCredWithOps.operations, [{ code: Operation.EXCHANGE_ID, status: Status.INVAL }])

      // SP4_SSV decodes fully and fails on the algorithm list rather than on the XDR.
      const ssv = yield* exchange((writer) => {
        ops(writer.uint32(2))
        writer.array([new Uint8Array([1, 2])], (item, oid) => item.opaque(oid))
          .array([new Uint8Array([3])], (item, oid) => item.opaque(oid)).uint32(8).uint32(1)
      })

      assert.deepStrictEqual(ssv.operations, [{ code: Operation.EXCHANGE_ID, status: Status.ENCR_ALG_UNSUPP }])
      const undefinedHow = yield* exchange((writer) => writer.uint32(3))
      assert.deepStrictEqual(undefinedHow.operations, [{ code: Operation.EXCHANGE_ID, status: Status.BADXDR }])

      // Section 14.5: valid UTF-8 the file system cannot store is BADCHAR; invalid UTF-8 is INVAL.
      const { session } = yield* startSession(handler, "badchar")

      const lookup = (sequenceId: number, name: Uint8Array) =>
        run(
          handler,
          call([
            sequence(session, sequenceId),
            (writer) => writer.uint32(Operation.PUTROOTFH),
            (writer) => writer.uint32(Operation.LOOKUP).opaque(name)
          ])
        ).pipe(Effect.map((reply) => reply.status))

      assert.strictEqual(yield* lookup(1, new TextEncoder().encode("a/b")), Status.BADCHAR)
      assert.strictEqual(yield* lookup(2, new Uint8Array([0x61, 0x00])), Status.BADCHAR)
      assert.strictEqual(yield* lookup(3, new Uint8Array([0xff, 0x61])), Status.INVAL)
      assert.strictEqual(yield* lookup(4, new TextEncoder().encode("file")), Status.OK)
    }))
})
