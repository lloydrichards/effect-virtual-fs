import { LiveVolume, Testing, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer } from "effect"
import * as ByteSize from "effect/ByteSize"
import { Operation, Status } from "../src/internal/nfs4.js"
import { type EncoderSession, make, XdrCodec } from "../src/internal/xdr.js"
import {
  call,
  exportFor,
  handlerFor,
  limits,
  openByName,
  openSession,
  parseOpen,
  sequence,
  startSession
} from "./support/harness.js"

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
  it.effect("reports the committed prefix and replays a lost WRITE reply without writing twice", () =>
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
        writable: true,
        export: { generation: storageGeneration, capacity: volume }
      })

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
  it.effect("writes through the held write handle after either OPEN upgrade order", () =>
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
        writable: true,
        export: { capacity: volume }
      })

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
  it.effect("reuses the held write handle across downgrade and upgrade cycles", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const export_ = exportFor(caller, { capacity: volume })

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
  it.effect("returns IO without publishing bytes when storage rejects the write", () =>
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
          writable: true,
          export: { capacity: volume }
        })

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
  it.effect("holds the WRITE reply until the store confirms the commit", () =>
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
          writable: true,
          export: { capacity: volume }
        })

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
  it.effect("returns no success after an unknown storage outcome and stops COMMIT", () =>
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
          writable: true,
          export: { capacity: volume }
        })

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
