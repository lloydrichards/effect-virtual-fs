import { LiveVolume, Testing, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as ByteSize from "effect/ByteSize"
import { makeExport } from "../src/internal/export.js"
import { Operation, Status } from "../src/internal/nfs4.js"
import { make, XdrCodec } from "../src/internal/xdr.js"
import {
  call,
  EXPORT_LIMITS,
  exportFor,
  handlerFor,
  limits,
  sequence,
  startSession,
  statuses,
  type WriteOperation
} from "./support/harness.js"

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
  it.effect("encode version, identity, epoch, inode number and tag in 57 bytes", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()
      yield* caller.writeFile("/f", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const reference = yield* caller.lookup("/f")
      const key = yield* volume.referenceKey(reference)
      const { export_ } = yield* serve(volume, "layout")
      const handle = yield* export_.handleFor(reference)

      assert.lengthOf(handle, 57)
      assert.strictEqual(handle[0], 2)
      assert.deepStrictEqual(handle.subarray(1, 17), key.identity)
      assert.deepStrictEqual(handle.subarray(17, 33), key.epoch)
      assert.strictEqual(new DataView(handle.buffer).getBigUint64(33), (yield* caller.stat(reference)).ino)
      assert.deepStrictEqual(handle.subarray(41, 57), key.tag)
    }))

  it.effect("survive a server restart over a durable volume, and say so in fh_expire_type", () =>
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

  it.effect("answer STALE under persistent handles for a removed object and for another volume's handle", () =>
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

  it.effect("expire after a restart over a memory volume, even under the same identity", () =>
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
  it.effect("answer BADHANDLE for a handle forged from another by its inode number or tag", () =>
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

  it.effect("answer STALE from GETFH and the filehandle attribute once the current object is removed", () =>
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

        assert.deepStrictEqual(reply, [Status.OK, Status.OK, Status.OK, Status.OK, Status.OK, Status.OK, Status.STALE])
      }
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("answer PUTFH with a status its RFC 8881 error list holds for every volume failure", () =>
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
