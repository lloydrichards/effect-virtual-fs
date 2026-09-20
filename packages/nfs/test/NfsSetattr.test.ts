import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import * as ByteSize from "effect/ByteSize"
import { makeExport } from "../src/internal/export.js"
import { makeNfs4Handler, type Nfs4Handler, Operation, Status } from "../src/internal/nfs4.js"
import { Reader, Writer } from "../src/internal/xdr.js"
import { call, generation, limits, openByName, parseOpen, sequence, startSession } from "./support/harness.js"

type Attribute = readonly [number, (writer: Writer) => void]

const bitmap = (writer: Writer, attributes: ReadonlyArray<number>) => {
  const words = Array.from(
    { length: attributes.length === 0 ? 0 : Math.floor(Math.max(...attributes) / 32) + 1 },
    () => 0
  )

  for (const attribute of attributes) words[Math.floor(attribute / 32)]! |= 1 << (attribute % 32)
  writer.array(words, (item, word) => item.uint32(word >>> 0))
}

const readBitmap = (reader: Reader) =>
  reader.array((item) => item.uint32()).flatMap((word, index) =>
    Array.from({ length: 32 }, (_, bit) => index * 32 + bit).filter((attribute) =>
      (word & (1 << (attribute % 32))) !== 0
    )
  )

const setattr =
  (attributes: ReadonlyArray<Attribute>, stateid: Uint8Array = new Uint8Array(16)) => (writer: Writer) => {
    writer.uint32(Operation.SETATTR).fixedOpaque(stateid)
    bitmap(writer, attributes.map(([attribute]) => attribute))
    const values = new Writer()

    for (const [, write] of attributes) write(values)
    writer.opaque(values.bytes())
  }

const setup = Effect.fnUntraced(function*(mapped = false, writable = true, mappedUid = 1000) {
  const volume = yield* Vfs.make()
  const caller = yield* volume.caller()
  yield* caller.writeFile("/file", new Uint8Array([1, 2]), { access: "write", create: "exclusive" })

  const guest = mapped ?
    yield* volume.caller({
      identity: { uid: mappedUid, gid: 1000, groups: [1001], privileged: false }
    }) :
    undefined

  if (guest !== undefined) {
    const reference = yield* caller.lookupReference(yield* caller.rootReference, new TextEncoder().encode("file"))
    yield* caller.chownReference(reference, { uid: 1000, gid: 1000 })
  }

  const options = {
    leaseDurationSeconds: 30,
    callbackTimeout: "1 second",
    generation,
    now: () => 0,
    limits,
    writable
  } as const

  const handler = yield* makeNfs4Handler(
    makeExport(caller, generation, { maxFilehandles: 32, maxNameBytes: ByteSize.bytes(255) }, generation, volume),
    guest === undefined ? options : { ...options, callerFor: () => Effect.succeed(guest) }
  )

  const { client, session } = yield* startSession(handler, "setattr-client")

  return { caller, client, handler, session }
})

const run = (
  handler: Nfs4Handler,
  session: Uint8Array,
  seq: number,
  attributes: ReadonlyArray<Attribute>,
  stateid?: Uint8Array
) =>
  handler.compound(call([
    sequence(session, seq),
    (writer) => writer.uint32(Operation.PUTROOTFH),
    (writer) => writer.uint32(Operation.LOOKUP).string("file"),
    setattr(attributes, stateid)
  ]))

const result = (bytes: Uint8Array) => {
  const reader = new Reader(bytes, limits)
  const status = reader.uint32()
  reader.string()
  assert.strictEqual(reader.uint32(), 4)
  assert.strictEqual(reader.uint32(), Operation.SEQUENCE)
  assert.strictEqual(reader.uint32(), Status.OK)
  reader.fixedOpaque(16)

  for (let field = 0; field < 5; field++) reader.uint32()
  assert.strictEqual(reader.uint32(), Operation.PUTROOTFH)
  assert.strictEqual(reader.uint32(), Status.OK)
  assert.strictEqual(reader.uint32(), Operation.LOOKUP)
  assert.strictEqual(reader.uint32(), Status.OK)
  assert.strictEqual(reader.uint32(), Operation.SETATTR)
  assert.strictEqual(reader.uint32(), status)
  const attrsset = readBitmap(reader)
  reader.finish()

  return { status, attrsset }
}

const readOwners = (bytes: Uint8Array) => {
  const reader = new Reader(bytes, limits)
  assert.strictEqual(reader.uint32(), Status.OK)
  reader.string()
  assert.strictEqual(reader.uint32(), 4)
  assert.strictEqual(reader.uint32(), Operation.SEQUENCE)
  assert.strictEqual(reader.uint32(), Status.OK)
  reader.fixedOpaque(16)

  for (let field = 0; field < 5; field++) reader.uint32()
  assert.strictEqual(reader.uint32(), Operation.PUTROOTFH)
  assert.strictEqual(reader.uint32(), Status.OK)
  assert.strictEqual(reader.uint32(), Operation.LOOKUP)
  assert.strictEqual(reader.uint32(), Status.OK)
  assert.strictEqual(reader.uint32(), Operation.GETATTR)
  assert.strictEqual(reader.uint32(), Status.OK)
  assert.deepStrictEqual(readBitmap(reader), [36, 37])
  const values = new Reader(reader.opaque(), limits)
  const owners = [values.string(), values.string()]
  values.finish()
  reader.finish()

  return owners
}

it.layer(NodeCrypto.layer)("NFS SETATTR", (it) => {
  it.effect("distinguishes read-only attributes from unsupported attributes", () =>
    Effect.gen(function*() {
      const { handler, session } = yield* setup()

      assert.deepStrictEqual(
        result(yield* run(handler, session, 1, [[1, (writer) => writer.uint32(1)]])),
        { status: Status.INVAL, attrsset: [] }
      )
      assert.deepStrictEqual(
        result(yield* run(handler, session, 2, [[63, (writer) => writer.uint32(1)]])),
        { status: Status.ATTRNOTSUPP, attrsset: [] }
      )
    }))

  it.effect("reports mode and owner attributes applied through the mapped caller", () =>
    Effect.gen(function*() {
      const { caller, handler, session } = yield* setup()

      const changed = result(
        yield* run(handler, session, 1, [
          [33, (writer) => writer.uint32(0o640)],
          [36, (writer) => writer.string("4294967295")],
          [37, (writer) => writer.string("0")]
        ])
      )

      assert.deepStrictEqual(changed, { status: Status.OK, attrsset: [33, 36, 37] })
      assert.deepInclude(yield* caller.stat("/file"), { mode: 0o640, uid: 4294967295, gid: 0 })
      assert.deepStrictEqual(
        readOwners(
          yield* handler.compound(call([
            sequence(session, 2),
            (writer) => writer.uint32(Operation.PUTROOTFH),
            (writer) => writer.uint32(Operation.LOOKUP).string("file"),
            (writer) =>
              writer.uint32(Operation.GETATTR).array([0, (1 << 4) | (1 << 5)], (item, word) => item.uint32(word))
          ]))
        ),
        ["4294967295", "0"]
      )
      assert.deepStrictEqual(
        result(
          yield* run(handler, session, 3, [
            [36, (writer) => writer.string("0")],
            [37, (writer) => writer.string("4294967295")]
          ])
        ),
        { status: Status.OK, attrsset: [36, 37] }
      )
      assert.deepInclude(yield* caller.stat("/file"), { uid: 0, gid: 4294967295 })
      assert.deepStrictEqual(
        readOwners(
          yield* handler.compound(call([
            sequence(session, 4),
            (writer) => writer.uint32(Operation.PUTROOTFH),
            (writer) => writer.uint32(Operation.LOOKUP).string("file"),
            (writer) =>
              writer.uint32(Operation.GETATTR).array([0, (1 << 4) | (1 << 5)], (item, word) => item.uint32(word))
          ]))
        ),
        ["0", "4294967295"]
      )
    }))

  it.effect("rejects noncanonical owner strings without changing ownership", () =>
    Effect.gen(function*() {
      const { caller, handler, session } = yield* setup()
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
          const changed = result(yield* run(handler, session, seq++, [[attribute, (writer) => writer.string(value)]]))
          assert.deepStrictEqual(changed, { status: Status.BADOWNER, attrsset: [] })
        }
      }

      assert.strictEqual((yield* caller.stat("/file")).uid, original.uid)
      assert.strictEqual((yield* caller.stat("/file")).gid, original.gid)
    }))

  it.effect("rejects malformed timestamp selectors and nanoseconds before mutation", () =>
    Effect.gen(function*() {
      const { caller, handler, session } = yield* setup()
      const original = yield* caller.stat("/file")

      for (const attribute of [48, 54]) {
        for (
          const [index, write] of [
            (writer: Writer) => writer.uint32(2),
            (writer: Writer) => writer.uint32(1).uint64(1n).uint32(1_000_000_000)
          ].entries()
        ) {
          const response = yield* run(handler, session, (attribute === 48 ? 0 : 2) + index + 1, [
            [attribute, write]
          ])

          assert.strictEqual(new Reader(response, limits).uint32(), Status.BADXDR)
        }
      }

      assert.deepInclude(yield* caller.stat("/file"), {
        atimeNs: original.atimeNs,
        mtimeNs: original.mtimeNs
      })
    }))

  it.effect("maps explicit and server-time timestamp setters to the correct metadata fields", () =>
    Effect.gen(function*() {
      const { caller, handler, session } = yield* setup()
      assert.deepStrictEqual(
        result(
          yield* run(handler, session, 1, [
            [48, (writer) => writer.uint32(1).uint64(12n).uint32(345)],
            [54, (writer) => writer.uint32(1).uint64(34n).uint32(567)]
          ])
        ),
        { status: Status.OK, attrsset: [48, 54] }
      )
      assert.deepInclude(yield* caller.stat("/file"), { atimeNs: 12_000_000_345n, mtimeNs: 34_000_000_567n })
      assert.deepStrictEqual(
        result(
          yield* run(handler, session, 2, [
            [48, (writer) => writer.uint32(0)]
          ])
        ),
        { status: Status.OK, attrsset: [48] }
      )
      const after = yield* caller.stat("/file")
      assert.notStrictEqual(after.atimeNs, 12_000_000_345n)
      assert.strictEqual(after.mtimeNs, 34_000_000_567n)
    }))

  it.effect("lets a mapped non-owner writer set both timestamps to server time", () =>
    Effect.gen(function*() {
      const { caller, handler, session } = yield* setup(true)
      const reference = yield* caller.lookupReference(yield* caller.rootReference, new TextEncoder().encode("file"))
      yield* caller.chownReference(reference, { uid: 2000, gid: 2000 })
      yield* caller.chmodReference(reference, 0o666)

      assert.deepStrictEqual(
        result(
          yield* run(handler, session, 1, [
            [48, (writer) => writer.uint32(0)],
            [54, (writer) => writer.uint32(0)]
          ])
        ),
        { status: Status.OK, attrsset: [48, 54] }
      )
    }))

  it.effect("requires a writable open stateid for size and refuses conflicting share denial", () =>
    Effect.gen(function*() {
      const { caller, client, handler, session } = yield* setup()
      const size = [[4, (writer: Writer) => writer.uint64(5n)]] as const
      assert.deepStrictEqual(result(yield* run(handler, session, 1, size)), {
        status: Status.BAD_STATEID,
        attrsset: []
      })

      const opened = parseOpen(
        yield* handler.compound(call([
          sequence(session, 2),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openByName(client, "file", 2),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      assert.deepStrictEqual(result(yield* run(handler, session, 3, size, opened.stateid)), {
        status: Status.OK,
        attrsset: [4]
      })
      assert.strictEqual((yield* caller.stat("/file")).size, 5n)
      const invalid = new Uint8Array(opened.stateid)
      invalid[15] = invalid[15]! ^ 1
      assert.deepStrictEqual(result(yield* run(handler, session, 4, [[4, (writer) => writer.uint64(6n)]], invalid)), {
        status: Status.BAD_STATEID,
        attrsset: []
      })
      assert.strictEqual((yield* caller.stat("/file")).size, 5n)
    }))

  it.effect("refuses size changes while a write-denying open exists", () =>
    Effect.gen(function*() {
      const { caller, client, handler, session } = yield* setup()

      const opened = parseOpen(
        yield* handler.compound(call([
          sequence(session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openByName(client, "file", 2, 2),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      assert.deepStrictEqual(
        result(yield* run(handler, session, 2, [[4, (writer) => writer.uint64(5n)]], opened.stateid)),
        {
          status: Status.SHARE_DENIED,
          attrsset: []
        }
      )
      assert.strictEqual((yield* caller.stat("/file")).size, 2n)
    }))

  it.effect("reports prior attributes when a later ownership change is denied", () =>
    Effect.gen(function*() {
      const { caller, handler, session } = yield* setup(true)

      const changed = result(
        yield* run(handler, session, 1, [
          [33, (writer) => writer.uint32(0o640)],
          [36, (writer) => writer.string("2000")]
        ])
      )

      assert.deepStrictEqual(changed, { status: Status.PERM, attrsset: [33] })
      assert.deepInclude(yield* caller.stat("/file"), { mode: 0o640, uid: 1000 })
    }))

  it.effect("lets an owner select a supplementary group but rejects another group", () =>
    Effect.gen(function*() {
      const { caller, handler, session } = yield* setup(true)
      assert.deepStrictEqual(
        result(
          yield* run(handler, session, 1, [
            [37, (writer) => writer.string("1000")]
          ])
        ),
        { status: Status.OK, attrsset: [37] }
      )
      assert.deepStrictEqual(
        result(
          yield* run(handler, session, 2, [
            [37, (writer) => writer.string("1001")]
          ])
        ),
        { status: Status.OK, attrsset: [37] }
      )
      assert.strictEqual((yield* caller.stat("/file")).gid, 1001)
      assert.deepStrictEqual(
        result(
          yield* run(handler, session, 3, [
            [37, (writer) => writer.string("1002")]
          ])
        ),
        { status: Status.PERM, attrsset: [] }
      )
    }))

  it.effect("does not treat an unprivileged mapped UID zero as the file owner", () =>
    Effect.gen(function*() {
      const { caller, handler, session } = yield* setup(true, true, 0)
      assert.deepStrictEqual(
        result(
          yield* run(handler, session, 1, [
            [36, (writer) => writer.string("0")]
          ])
        ),
        { status: Status.PERM, attrsset: [] }
      )
      assert.strictEqual((yield* caller.stat("/file")).uid, 1000)
    }))

  it.effect("keeps a read-only export immutable", () =>
    Effect.gen(function*() {
      const { caller, handler, session } = yield* setup(false, false)
      const response = result(yield* run(handler, session, 1, [[33, (writer) => writer.uint32(0o600)]]))

      assert.deepStrictEqual(response, { status: Status.ROFS, attrsset: [] })
      assert.notStrictEqual((yield* caller.stat("/file")).mode, 0o600)
    }))
})
