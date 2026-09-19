import { LiveVolume, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer } from "effect"
import * as ByteSize from "effect/ByteSize"
import { makeExport } from "../src/internal/export.js"
import { makeNfs4Handler, Operation, Status } from "../src/internal/nfs4.js"
import { Reader, type Writer } from "../src/internal/xdr.js"
import { call, generation, limits, openByName, parseOpen, sequence, startSession } from "./support/harness.js"

const write = (stateid: Uint8Array, bytes: Uint8Array, offset = 0n, stable = 2) => (writer: Writer) =>
  writer.uint32(Operation.WRITE).fixedOpaque(stateid).uint64(offset).uint32(stable).opaque(bytes)

const readWriteResult = (bytes: Uint8Array) => {
  const reader = new Reader(bytes, limits)
  const status = reader.uint32()
  reader.string()
  reader.uint32()
  assert.strictEqual(reader.uint32(), Operation.SEQUENCE)
  assert.strictEqual(reader.uint32(), Status.OK)
  reader.fixedOpaque(16)

  for (let field = 0; field < 5; field++) reader.uint32()

  assert.strictEqual(reader.uint32(), Operation.PUTFH)
  assert.strictEqual(reader.uint32(), Status.OK)
  assert.strictEqual(reader.uint32(), Operation.WRITE)
  assert.strictEqual(reader.uint32(), status)

  if (status !== Status.OK) return { status }

  const count = reader.uint32()
  const committed = reader.uint32()
  const verifier = reader.fixedOpaque(8)
  reader.finish()

  return { status, count, committed, verifier }
}

const readCommitResult = (bytes: Uint8Array) => {
  const reader = new Reader(bytes, limits)
  const status = reader.uint32()
  reader.string()
  reader.uint32()
  assert.strictEqual(reader.uint32(), Operation.SEQUENCE)
  assert.strictEqual(reader.uint32(), Status.OK)
  reader.fixedOpaque(16)

  for (let field = 0; field < 5; field++) reader.uint32()

  assert.strictEqual(reader.uint32(), Operation.PUTFH)
  assert.strictEqual(reader.uint32(), Status.OK)
  assert.strictEqual(reader.uint32(), Operation.COMMIT)
  assert.strictEqual(reader.uint32(), status)

  if (status !== Status.OK) return { status }
  const verifier = reader.fixedOpaque(8)
  reader.finish()

  return { status, verifier }
}

it.layer(NodeCrypto.layer)("NFS durable write preparation", (it) => {
  it.effect("reports the committed prefix and replays a lost WRITE reply without writing twice", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make({ maxBytes: ByteSize.bytes(4), maxFileBytes: ByteSize.bytes(4) })
      const caller = yield* volume.caller()
      yield* caller.writeFile("/file", new Uint8Array([1, 2]), { access: "write", create: "exclusive" })
      const storageGeneration = new Uint8Array(16).fill(9)

      const handler = yield* makeNfs4Handler(
        makeExport(
          caller,
          storageGeneration,
          { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) },
          storageGeneration,
          volume
        ),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          storageGeneration,
          now: () => 0,
          limits,
          writable: true
        }
      )

      const { client, session } = yield* startSession(handler, "write-prefix")

      const opened = parseOpen(
        yield* handler.compound(call([
          sequence(session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openByName(client, "file", 2),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      const request = call([
        sequence(session, 2, true),
        (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
        write(opened.stateid, new Uint8Array([3, 4, 5, 6]), 2n, 0)
      ])

      const first = yield* handler.compound(request)
      const result = readWriteResult(first)
      assert.strictEqual(result.status, Status.OK)
      assert.strictEqual(result.count, 2)
      assert.strictEqual(result.committed, 2)
      assert.strictEqual(result.verifier?.length, 8)
      assert.deepStrictEqual(yield* handler.compound(request), first)
      assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([1, 2, 3, 4]))

      const zero = readWriteResult(
        yield* handler.compound(call([
          sequence(session, 3),
          (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
          write(opened.stateid, new Uint8Array(0), 0n)
        ]))
      )

      assert.strictEqual(zero.count, 0)

      const committed = readCommitResult(
        yield* handler.compound(call([
          sequence(session, 4),
          (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
          (writer) => writer.uint32(Operation.COMMIT).uint64(0n).uint32(0)
        ]))
      )

      assert.deepStrictEqual(committed.verifier, result.verifier)

      const invalid = readWriteResult(
        yield* handler.compound(call([
          sequence(session, 5),
          (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
          write(new Uint8Array(16), new Uint8Array([8]), 0n)
        ]))
      )

      assert.strictEqual(invalid.status, Status.BAD_STATEID)

      const badStability = readWriteResult(
        yield* handler.compound(call([
          sequence(session, 6),
          (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
          write(opened.stateid, new Uint8Array([8]), 0n, 3)
        ]))
      )

      assert.strictEqual(badStability.status, Status.INVAL)
    }))

  it.effect("writes through the held write handle after either OPEN upgrade order", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()
      yield* caller.writeFile("/read-first", new Uint8Array([1]), { access: "write", create: "exclusive" })
      yield* caller.writeFile("/write-first", new Uint8Array([1]), { access: "write", create: "exclusive" })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }, generation, volume),
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits, writable: true }
      )

      const { client, session } = yield* startSession(handler, "write-upgrade")

      let sequenceId = 1

      for (
        const [name, firstAccess, secondAccess] of [
          ["read-first", 1, 2],
          ["write-first", 2, 1]
        ] as const
      ) {
        yield* handler.compound(call([
          sequence(session, sequenceId++),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openByName(client, name, firstAccess),
          (writer) => writer.uint32(Operation.GETFH)
        ]))

        const upgraded = parseOpen(
          yield* handler.compound(call([
            sequence(session, sequenceId++),
            (writer) => writer.uint32(Operation.PUTROOTFH),
            openByName(client, name, secondAccess),
            (writer) => writer.uint32(Operation.GETFH)
          ]))
        )

        const result = readWriteResult(
          yield* handler.compound(call([
            sequence(session, sequenceId++),
            (writer) => writer.uint32(Operation.PUTFH).opaque(upgraded.filehandle),
            write(upgraded.stateid, new Uint8Array([2]), 0n)
          ]))
        )

        assert.strictEqual(result.status, Status.OK)
        assert.strictEqual(result.count, 1)
        assert.deepStrictEqual(yield* caller.readFile(`/${name}`), new Uint8Array([2]))
      }
    }))

  it.effect("reuses the held write handle across downgrade and upgrade cycles", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })

      const export_ = makeExport(
        caller,
        generation,
        { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) },
        generation,
        volume
      )

      let openedHandles = 0

      const handler = yield* makeNfs4Handler(
        {
          ...export_,
          open: (reference, access) => {
            openedHandles++

            return export_.open(reference, access)
          }
        },
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits, writable: true }
      )

      const { client, session } = yield* startSession(handler, "write-handle-reuse")
      let sequenceId = 1

      let opened = parseOpen(
        yield* handler.compound(call([
          sequence(session, sequenceId++),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openByName(client, "file", 3),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      for (let cycle = 0; cycle < 3; cycle++) {
        const downgraded = new Reader(
          yield* handler.compound(call([
            sequence(session, sequenceId++),
            (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
            (writer) =>
              writer.uint32(Operation.OPEN_DOWNGRADE).fixedOpaque(opened.stateid).uint32(0).uint32(1)
                .uint32(0)
          ])),
          limits
        )

        assert.strictEqual(downgraded.uint32(), Status.OK)

        opened = parseOpen(
          yield* handler.compound(call([
            sequence(session, sequenceId++),
            (writer) => writer.uint32(Operation.PUTROOTFH),
            openByName(client, "file", 2),
            (writer) => writer.uint32(Operation.GETFH)
          ]))
        )

        const result = readWriteResult(
          yield* handler.compound(call([
            sequence(session, sequenceId++),
            (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
            write(opened.stateid, new Uint8Array([cycle + 2]), 0n)
          ]))
        )

        assert.strictEqual(result.status, Status.OK)
      }

      assert.strictEqual(openedHandles, 1)
      assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([4]))
    }))

  it.effect("returns IO without publishing bytes when storage rejects the write", () => {
    let reject = false

    const store = Layer.succeed(
      LiveVolume.LiveImageStore,
      LiveVolume.LiveImageStore.of({
        loadOrCreate: (initial) => Effect.succeed(initial),
        commit: () => Effect.succeed(reject ? "rejected" as const : "committed" as const)
      })
    )

    return Effect.gen(function*() {
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
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }, generation, volume),
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits, writable: true }
      )

      const { client, session } = yield* startSession(handler, "write-reject")

      const opened = parseOpen(
        yield* handler.compound(call([
          sequence(session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openByName(client, "file", 2),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      reject = true

      const result = readWriteResult(
        yield* handler.compound(call([
          sequence(session, 2),
          (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
          write(opened.stateid, new Uint8Array([2]), 0n)
        ]))
      )

      assert.strictEqual(result.status, Status.IO)
      reject = false
      assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([1]))
    }).pipe(Effect.provide(store))
  })

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
            hold
              ? Effect.gen(function*() {
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(release)

                return "committed" as const
              })
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
        yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })

        const handler = yield* makeNfs4Handler(
          makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }, generation, volume),
          { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits, writable: true }
        )

        const { client, session } = yield* startSession(handler, "write-commit-order")

        const opened = parseOpen(
          yield* handler.compound(call([
            sequence(session, 1),
            (writer) => writer.uint32(Operation.PUTROOTFH),
            openByName(client, "file", 2),
            (writer) => writer.uint32(Operation.GETFH)
          ]))
        )

        hold = true

        const reply = yield* handler.compound(call([
          sequence(session, 2),
          (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
          write(opened.stateid, new Uint8Array([2]), 0n)
        ])).pipe(Effect.forkChild({ startImmediately: true }))

        yield* Deferred.await(started)
        assert.strictEqual(reply.pollUnsafe(), undefined)
        yield* Deferred.succeed(release, undefined)
        const result = readWriteResult(yield* Fiber.join(reply))
        assert.strictEqual(result.status, Status.OK)
        assert.strictEqual(result.committed, 2)
        assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([2]))
      })).pipe(Effect.provide(store))
    }))

  it.effect("returns no success after an unknown storage outcome and stops COMMIT", () => {
    let unknown = false

    const store = Layer.succeed(
      LiveVolume.LiveImageStore,
      LiveVolume.LiveImageStore.of({
        loadOrCreate: (initial) => Effect.succeed(initial),
        commit: () => Effect.succeed(unknown ? "unknown" as const : "committed" as const)
      })
    )

    return Effect.gen(function*() {
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
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }, generation, volume),
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits, writable: true }
      )

      const { client, session } = yield* startSession(handler, "write-unknown")

      const opened = parseOpen(
        yield* handler.compound(call([
          sequence(session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openByName(client, "file", 2),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      unknown = true

      const result = readWriteResult(
        yield* handler.compound(call([
          sequence(session, 2),
          (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
          write(opened.stateid, new Uint8Array([2]), 0n)
        ]))
      )

      assert.strictEqual(result.status, Status.IO)

      const next = new Reader(
        yield* handler.compound(call([
          sequence(session, 3),
          (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
          (writer) => writer.uint32(Operation.COMMIT).uint64(0n).uint32(0)
        ])),
        limits
      )

      assert.strictEqual(next.uint32(), Status.SERVERFAULT)
      next.string()
      assert.strictEqual(next.uint32(), 2)
      assert.strictEqual(next.uint32(), Operation.SEQUENCE)
      assert.strictEqual(next.uint32(), Status.OK)
      next.fixedOpaque(16)

      for (let field = 0; field < 5; field++) next.uint32()

      assert.strictEqual(next.uint32(), Operation.PUTFH)
      assert.strictEqual(next.uint32(), Status.SERVERFAULT)
      assert.strictEqual((yield* Effect.flip(volume.usage)).code, "VolumeUnavailable")
    }).pipe(Effect.provide(store))
  })
})
