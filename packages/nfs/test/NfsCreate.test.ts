import { LiveVolume, Testing, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer } from "effect"
import * as ByteSize from "effect/ByteSize"
import { Operation, Status } from "../src/internal/nfs4.js"
import { type DecoderSession, type EncoderSession, make, XdrCodec } from "../src/internal/xdr.js"
import {
  call,
  limits,
  makeHandler,
  openByName,
  parseOpen,
  sequence,
  startSession,
  type WriteOperation
} from "./support/harness.js"

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
  it.effect("creates one file with initial attributes and returns usable filehandle and open state", () =>
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
      assert.deepStrictEqual(opened.attrs, [4, 33, 36, 37, 48, 54])
      assert.isTrue(opened.atomic)
      assert.strictEqual(opened.before, before.revision)
      assert.strictEqual(opened.after, (yield* caller.readDirectory(root)).revision)
      assert.notStrictEqual(opened.before, opened.after)

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
  it.effect("guarded creation rejects an existing name without changing its contents or metadata", () =>
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
  it.effect("unchecked opens ignore existing-file attributes except size zero truncation", () =>
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
      assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array())
    }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))
  it.effect("both exclusive modes recognize the verifier and reject another creation attempt", () =>
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
  it.effect("ignores unused initial attribute values when the named file already exists", () =>
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

      const unused: Attributes = [[33, (writer) => writer.write(XdrCodec.uint32, 0xffff_ffff)], [36, (writer) =>
        writer.write(XdrCodec.string(), "unmapped@example.test")]]

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
    }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))
  it.effect("EXCLUSIVE4_1 rejects timestamp setters before creating a file", () =>
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
              yield* createCall(client, session, index + 1, "file", 3, [[attribute, (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.uint32, 1)
                  yield* writer.write(XdrCodec.uint64, 1n)
                  yield* writer.write(XdrCodec.uint32, 0)
                })]])
            )
          ),
          Status.INVAL
        )
        assert.strictEqual((yield* Effect.flip(caller.stat("/file"))).code, "NotFound")
      }
    }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))
  it.effect("advertises the EXCLUSIVE4_1 initial attributes without timestamp setters", () =>
    Effect.gen(function*() {
      const {
        handler,
        session
      } = yield* setup()

      const reader = yield* afterRoot(
        yield* handler.compound(
          yield* call([sequence(session, 1), (writer) =>
            writer.write(XdrCodec.uint32, Operation.PUTROOTFH), (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.GETATTR)
              yield* writeBitmap(writer, [75])
            })])
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
  it.effect("rejects unsupported initial attributes without leaving a directory entry", () =>
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
  it.effect("checks share reservations before an unchecked open can truncate", () =>
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
  it.effect("uses the mapped caller's authority before creating or truncating", () =>
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
  it.effect("exhausted open-state capacity cannot create or truncate", () =>
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
  it.effect("exhausted entry capacity leaves no file or retained open reservation", () =>
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
  it.effect("read-only handlers reject every creation mode and preserve existing data", () =>
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
  it.effect("replays a cached reply and never reexecutes an uncached creation request", () =>
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
  it.effect("a rejected commit publishes neither the file nor an open reservation", () => {
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
  it.effect("an unknown commit outcome refuses success and blocks subsequent volume access", () => {
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
  it.effect("recovers the file and exclusive verifier together from the committed image", () => {
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
  it.effect("waits for confirmed commit before returning a successful open", () =>
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

        const reply = yield* handler.compound(yield* createCall(client, session, 1, "file", 2)).pipe(Effect.forkChild({
          startImmediately: true
        }))

        yield* Deferred.await(started)
        assert.strictEqual(reply.pollUnsafe(), undefined)
        yield* Deferred.succeed(release, undefined)
        yield* readCreate(yield* Fiber.join(reply))
        assert.strictEqual((yield* caller.stat("/file")).size, 0n)
      })).pipe(Effect.provide(store))
    }))
  it.effect("closes the acquired handle when creation is interrupted during commit", () =>
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

        const request = yield* createCall(client, session, 1, "file", 3, [[4, (writer) =>
          writer.write(XdrCodec.uint64, 8n)]])

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
