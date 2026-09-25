import { Testing, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { type Nfs4Handler, Operation, Status } from "../src/internal/nfs4.js"
import { type DecoderSession, type EncoderSession, make, XdrCodec } from "../src/internal/xdr.js"
import {
  call,
  type HandlerOverrides,
  limits,
  openByName,
  openSession,
  parseOpen,
  sequence,
  type WriteOperation
} from "./support/harness.js"

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
  const volume = yield* Vfs.Volume
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

  const overrides: HandlerOverrides = { writable, export: { limits: { maxFilehandles: 32 }, capacity: volume } }

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
  it.effect("distinguishes read-only attributes from unsupported attributes", () =>
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
  it.effect("reports mode and owner attributes applied through the mapped caller", () =>
    Effect.gen(function*() {
      const {
        caller,
        handler,
        session
      } = yield* setup()

      const changed = yield* result(
        yield* run(handler, session, 1, [[33, (writer) => writer.write(XdrCodec.uint32, 0o640)], [36, (writer) =>
          writer.write(XdrCodec.string(), "4294967295")], [37, (writer) =>
          writer.write(XdrCodec.string(), "0")]])
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
          yield* run(handler, session, 3, [[36, (writer) => writer.write(XdrCodec.string(), "0")], [37, (writer) =>
            writer.write(XdrCodec.string(), "4294967295")]])
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
              (writer) =>
                writer.write(XdrCodec.uint32, Operation.PUTROOTFH),
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
                    yield* ((item, word) =>
                      item.write(XdrCodec.uint32, word))(writer, xdrValue)
                  }
                })
            ])
          )
        ),
        ["0", "4294967295"]
      )
    }).pipe(Effect.provide(Testing.layer())))
  it.effect("rejects noncanonical owner strings without changing ownership", () =>
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
  it.effect("rejects malformed timestamp selectors and nanoseconds before mutation", () =>
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
  it.effect("maps explicit and server-time timestamp setters to the correct metadata fields", () =>
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
  it.effect("lets a mapped non-owner writer set both timestamps to server time", () =>
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
          yield* run(handler, session, 1, [[48, (writer) => writer.write(XdrCodec.uint32, 0)], [54, (writer) =>
            writer.write(XdrCodec.uint32, 0)]])
        ),
        {
          status: Status.OK,
          attrsset: [48, 54]
        }
      )
    }).pipe(Effect.provide(Testing.layer())))
  it.effect("requires a writable open stateid for size and refuses conflicting share denial", () =>
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
  it.effect("refuses size changes while a write-denying open exists", () =>
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
  it.effect("applies no attribute and reports none when a later ownership change is denied", () =>
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
  it.effect("clears setuid from a mode sent with an owner change, as knfsd does, under one change", () =>
    Effect.gen(function*() {
      const {
        caller,
        handler,
        session
      } = yield* setup()

      const volume = yield* Vfs.Volume
      const changes = yield* Testing.collectChanges(yield* volume.watch, 2)
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
  it.effect("clears setgid too from a group-executable mode sent with a group change", () =>
    Effect.gen(function*() {
      const {
        caller,
        handler,
        session
      } = yield* setup()

      const changed = yield* result(
        yield* run(handler, session, 1, [[33, (writer) => writer.write(XdrCodec.uint32, 0o6755)], [37, (writer) =>
          writer.write(XdrCodec.string(), "7")]])
      )

      assert.deepStrictEqual(changed, {
        status: Status.OK,
        attrsset: [33, 37]
      })
      assert.deepInclude(yield* caller.stat("/file"), { mode: 0o755, gid: 7 })
    }).pipe(Effect.provide(Testing.layer())))
  it.effect("keeps a set-ID mode sent with an owner change on a directory, as knfsd does", () =>
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
  it.effect("accepts an owner re-sending a group it is not a member of when the group is unchanged, as knfsd does", () =>
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
  it.effect("still refuses an unchanged owner or group from a caller that does not own the file", () =>
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
  it.effect("keeps a set-ID mode sent with the owner the file already has, as knfsd does", () =>
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
  it.effect("clears set-ID bits when the group changes even though the owner sent is unchanged", () =>
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
  it.effect("lets an owner select a supplementary group but rejects another group", () =>
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
  it.effect("refuses a mode change by a caller that does not own the file as not permitted", () =>
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
  it.effect("refuses explicit timestamps from a caller that does not own the file as not permitted", () =>
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
  it.effect("does not treat an unprivileged mapped UID zero as the file owner", () =>
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
  it.effect("keeps a read-only export immutable", () =>
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
  it.effect("re-observes an owner that another client changed mid-SETATTR, so setuid never survives the chown", () =>
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
  it.effect("answers DELAY and applies nothing when the owner keeps moving under SETATTR", () =>
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
