import { LiveVolume, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Result } from "effect"
import * as ByteSize from "effect/ByteSize"
import { makeExport } from "../src/internal/export.js"
import { makeNfs4Handler, Operation, Status } from "../src/internal/nfs4.js"
import { Reader, Writer } from "../src/internal/xdr.js"
import { call, generation, limits, openByName, parseOpen, sequence, startSession } from "./support/harness.js"

const create = (
  client: bigint,
  name: string,
  mode: 0 | 1 = 0,
  access = 3,
  owner = "creator",
  attrs: ReadonlyArray<readonly [number, number | bigint]> = []
) =>
(writer: Writer) => {
  const words: Array<number> = []

  for (const [attribute] of attrs) {
    const index = Math.floor(attribute / 32)
    words[index] = (words[index] ?? 0) | (1 << (attribute % 32))
  }

  const values = new Writer()

  for (const [attribute, value] of [...attrs].sort(([left], [right]) => left - right)) {
    if (attribute === 4) values.uint64(BigInt(value))
    else values.uint32(Number(value))
  }

  writer.uint32(Operation.OPEN).uint32(0).uint32(access).uint32(0).uint64(client).string(owner)
    .uint32(1).uint32(mode).array(
      Array.from({ length: words.length }, (_, index) => (words[index] ?? 0) >>> 0),
      (target, bit) => target.uint32(bit)
    )
    .opaque(values.bytes()).uint32(0).string(name)
}

const statusOf = (bytes: Uint8Array) => new Reader(bytes, limits).uint32()

const createInfo = (bytes: Uint8Array) => {
  const reader = new Reader(bytes, limits)
  reader.uint32()
  reader.string()
  reader.uint32()
  reader.uint32()
  reader.uint32()
  reader.fixedOpaque(16)

  for (let field = 0; field < 5; field++) reader.uint32()

  reader.uint32()
  reader.uint32()
  reader.uint32()
  reader.uint32()
  reader.fixedOpaque(16)
  const atomic = reader.boolean()
  const before = reader.uint64()
  const after = reader.uint64()
  reader.uint32()

  return { atomic, before, after, attrset: reader.array((item) => item.uint32()) }
}

it.layer(NodeCrypto.layer)("writable OPEN creation", (it) => {
  it.effect("creates an exact regular file, replays once, and guards an existing name", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller({ umask: 0 })

      const export_ = makeExport(
        caller,
        generation,
        { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) },
        generation,
        volume
      )

      const handler = yield* makeNfs4Handler(export_, {
        leaseDurationSeconds: 30,
        callbackTimeout: "1 second",
        generation,
        now: () => 0,
        limits,
        writable: true
      })

      const { client, session } = yield* startSession(handler, "create")

      const request = call([
        sequence(session, 1, true),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        create(client, "new", 0, 3, "creator", [[33, 0o640]]),
        (writer) => writer.uint32(Operation.GETFH)
      ])

      const first = yield* handler.compound(request)
      const opened = parseOpen(first)
      const info = createInfo(first)

      assert.strictEqual(opened.atomic, true)
      assert.strictEqual(info.atomic, true)
      assert.isTrue(info.after > info.before)
      assert.deepStrictEqual(info.attrset, [0, 2])
      assert.deepStrictEqual(yield* handler.compound(request), first)
      assert.deepInclude(yield* caller.stat("/new"), { kind: "file", mode: 0o640 })
      assert.deepStrictEqual(
        yield* export_.resolve(opened.filehandle),
        yield* caller.lookupReference(yield* caller.rootReference, new TextEncoder().encode("new"))
      )

      const writeReply = yield* handler.compound(call([
        sequence(session, 2),
        (writer) => writer.uint32(Operation.PUTFH).opaque(opened.filehandle),
        (writer) =>
          writer.uint32(Operation.WRITE).fixedOpaque(opened.stateid).uint64(0n).uint32(2).opaque(new Uint8Array([9]))
      ]))

      assert.strictEqual(statusOf(writeReply), Status.OK)
      assert.deepStrictEqual(yield* caller.readFile("/new"), new Uint8Array([9]))

      const guarded = yield* handler.compound(call([
        sequence(session, 3),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        create(client, "new", 1)
      ]))

      assert.strictEqual(statusOf(guarded), Status.EXIST)
    }))

  it.effect("ignores an existing file's mode attribute and applies a zero size", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller({ umask: 0 })
      yield* caller.writeFile("/old", new Uint8Array([1, 2]), { access: "write", create: "exclusive", mode: 0o600 })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }, generation, volume),
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits, writable: true }
      )

      const { client, session } = yield* startSession(handler, "existing")

      const reply = yield* handler.compound(call([
        sequence(session, 1),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        create(client, "old", 0, 3, "creator", [[4, 0n], [33, 0o777]]),
        (writer) => writer.uint32(Operation.GETFH)
      ]))

      parseOpen(reply)
      const info = createInfo(reply)
      assert.strictEqual(info.before, info.after)
      assert.deepStrictEqual(info.attrset, [16])
      assert.deepInclude(yield* caller.stat("/old"), { mode: 0o600, size: 0n })
    }))

  it.effect("sets a new file's requested size inside creation", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }, generation, volume),
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits, writable: true }
      )

      const { client, session } = yield* startSession(handler, "initial-size")
      parseOpen(
        yield* handler.compound(call([
          sequence(session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          create(client, "sized", 1, 1, "creator", [[4, 3n]]),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )
      assert.deepStrictEqual(yield* caller.readFile("/sized"), new Uint8Array(3))

      parseOpen(
        yield* handler.compound(call([
          sequence(session, 2),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          create(client, "sized", 0, 1, "creator", [[4, 8n]]),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )
      assert.deepStrictEqual(yield* caller.readFile("/sized"), new Uint8Array(3))
    }))

  it.effect("reports a symbolic-link target as SYMLINK for ordinary create", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()
      yield* caller.symlink("target", "/link")

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }, generation, volume),
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits, writable: true }
      )

      const { client, session } = yield* startSession(handler, "symlink")

      const reply = yield* handler.compound(call([
        sequence(session, 1),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        create(client, "link")
      ]))

      assert.strictEqual(statusOf(reply), Status.SYMLINK)
      assert.strictEqual(Result.isFailure(yield* Effect.result(caller.stat("/target"))), true)
    }))

  it.effect("rejects a conflicting reservation before truncating or creating", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()
      yield* caller.writeFile("/old", new Uint8Array([1, 2]), { access: "write", create: "exclusive" })

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }, generation, volume),
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits, writable: true }
      )

      const { client, session } = yield* startSession(handler, "conflict")
      parseOpen(
        yield* handler.compound(call([
          sequence(session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openByName(client, "old", 1, 2),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      const reply = yield* handler.compound(call([
        sequence(session, 2),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        create(client, "old", 0, 2, "other", [[4, 0n]])
      ]))

      assert.strictEqual(statusOf(reply), Status.SHARE_DENIED)
      assert.deepStrictEqual(yield* caller.readFile("/old"), new Uint8Array([1, 2]))
    }))

  it.effect("upgrades the same owner's create open and keeps its stateid identity", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }, generation, volume),
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits, writable: true }
      )

      const { client, session } = yield* startSession(handler, "upgrade")

      const first = parseOpen(
        yield* handler.compound(call([
          sequence(session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          create(client, "upgrade", 0, 1),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      const second = parseOpen(
        yield* handler.compound(call([
          sequence(session, 2),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          create(client, "upgrade", 0, 2),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      assert.deepStrictEqual(second.stateid.subarray(4), first.stateid.subarray(4))
      assert.deepStrictEqual(second.filehandle, first.filehandle)
      assert.strictEqual(new DataView(second.stateid.buffer, second.stateid.byteOffset).getUint32(0), 2)
    }))

  it.effect("rejects a replaced child before truncation or an extra open reservation", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()
      yield* caller.writeFile("/victim", new Uint8Array([1]), { access: "write", create: "exclusive" })

      const base = makeExport(
        caller,
        generation,
        { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) },
        generation,
        volume
      )

      let replace = false

      const export_ = {
        ...base,
        lookup: (directory: Vfs.ObjectReference, name: Uint8Array) =>
          base.lookup(directory, name).pipe(
            Effect.tap(() =>
              replace
                ? Effect.gen(function*() {
                  replace = false
                  yield* caller.unlink("/victim")
                  yield* caller.writeFile("/victim", new Uint8Array([7]), { access: "write", create: "exclusive" })
                })
                : Effect.void
            )
          )
      }

      const handler = yield* makeNfs4Handler(export_, {
        leaseDurationSeconds: 30,
        callbackTimeout: "1 second",
        generation,
        now: () => 0,
        limits: { ...limits, maxOpens: 1 },
        writable: true
      })

      const { client, session } = yield* startSession(handler, "replaced")
      parseOpen(
        yield* handler.compound(call([
          sequence(session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          openByName(client, "victim"),
          (writer) => writer.uint32(Operation.GETFH)
        ]))
      )

      replace = true

      const reply = yield* handler.compound(call([
        sequence(session, 2),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        create(client, "victim", 0, 2, "owner", [[4, 0n]])
      ]))

      assert.strictEqual(statusOf(reply), Status.DELAY)
      assert.deepStrictEqual(yield* caller.readFile("/victim"), new Uint8Array([7]))
    }))

  it.effect("does not publish a file when the filehandle budget is full", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()

      const export_ = makeExport(
        caller,
        generation,
        { maxFilehandles: 1, maxNameBytes: ByteSize.bytes(255) },
        generation,
        volume
      )

      yield* export_.handleFor(yield* caller.rootReference)

      const handler = yield* makeNfs4Handler(
        export_,
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits, writable: true }
      )

      const { client, session } = yield* startSession(handler, "capacity")

      const reply = yield* handler.compound(call([
        sequence(session, 1),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        create(client, "no-room")
      ]))

      assert.strictEqual(statusOf(reply), Status.DELAY)
      assert.strictEqual(Result.isFailure(yield* Effect.result(caller.stat("/no-room"))), true)
    }))

  it.effect("does not publish a file when its requested size exceeds the core limit", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make({ maxFileBytes: ByteSize.bytes(2) })
      const caller = yield* volume.caller()

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }, generation, volume),
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits, writable: true }
      )

      const { client, session } = yield* startSession(handler, "too-large")

      const reply = yield* handler.compound(call([
        sequence(session, 1),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        create(client, "too-large", 0, 1, "creator", [[4, 3n]])
      ]))

      assert.strictEqual(statusOf(reply), Status.FBIG)
      assert.strictEqual(Result.isFailure(yield* Effect.result(caller.stat("/too-large"))), true)
    }))

  it.effect("uses the mapped caller's directory permission", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const admin = yield* volume.caller()
      const guest = yield* volume.caller({ identity: { uid: 1000, gid: 1000, groups: [], privileged: false } })

      const handler = yield* makeNfs4Handler(
        makeExport(admin, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }, generation, volume),
        {
          leaseDurationSeconds: 30,
          callbackTimeout: "1 second",
          generation,
          now: () => 0,
          limits,
          writable: true,
          callerFor: () => Effect.succeed(guest)
        }
      )

      const { client, session } = yield* startSession(handler, "guest")

      const reply = yield* handler.compound(call([
        sequence(session, 1),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        create(client, "forbidden")
      ]))

      assert.strictEqual(statusOf(reply), Status.ACCESS)
      assert.strictEqual(Result.isFailure(yield* Effect.result(admin.stat("/forbidden"))), true)
    }))

  it.effect("keeps rejected store commits unpublished and reopens a confirmed create", () => {
    let saved: Uint8Array | undefined
    let reject = false

    const store = Layer.succeed(
      LiveVolume.LiveImageStore,
      LiveVolume.LiveImageStore.of({
        loadOrCreate: (initial) => Effect.succeed(saved ?? initial),
        commit: (image) =>
          Effect.sync(() => {
            if (reject) return "rejected" as const
            saved = new Uint8Array(image)

            return "committed" as const
          })
      })
    )

    const open = LiveVolume.open({
      maxImageBytes: ByteSize.kilobytes(64),
      volume: {
        maxEntries: 16,
        maxBytes: ByteSize.bytes(32),
        maxFileBytes: ByteSize.bytes(32),
        maxPathBytes: ByteSize.bytes(255)
      }
    })

    return Effect.gen(function*() {
      yield* Effect.scoped(Effect.gen(function*() {
        const volume = yield* open
        const caller = yield* volume.caller()

        const handler = yield* makeNfs4Handler(
          makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }, generation, volume),
          { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits, writable: true }
        )

        const { client, session } = yield* startSession(handler, "store")
        reject = true

        const rejected = yield* handler.compound(call([
          sequence(session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          create(client, "rejected")
        ]))

        assert.strictEqual(statusOf(rejected), Status.IO)
        assert.strictEqual(Result.isFailure(yield* Effect.result(caller.stat("/rejected"))), true)

        reject = false
        parseOpen(
          yield* handler.compound(call([
            sequence(session, 2),
            (writer) => writer.uint32(Operation.PUTROOTFH),
            create(client, "confirmed"),
            (writer) => writer.uint32(Operation.GETFH)
          ]))
        )

        parseOpen(
          yield* handler.compound(call([
            sequence(session, 3),
            (writer) => writer.uint32(Operation.PUTROOTFH),
            create(client, "confirmed"),
            (writer) => writer.uint32(Operation.GETFH)
          ]))
        )
      }))

      yield* Effect.scoped(Effect.gen(function*() {
        const volume = yield* open
        const caller = yield* volume.caller()
        assert.deepInclude(yield* caller.stat("/confirmed"), { kind: "file" })
        assert.strictEqual(Result.isFailure(yield* Effect.result(caller.stat("/rejected"))), true)
      }))
    }).pipe(Effect.provide(store))
  })

  it.effect("returns no success when the create commit outcome is unknown", () => {
    let unknown = false

    const store = Layer.succeed(
      LiveVolume.LiveImageStore,
      LiveVolume.LiveImageStore.of({
        loadOrCreate: (initial) => Effect.succeed(initial),
        commit: () => Effect.succeed(unknown ? "unknown" as const : "committed" as const)
      })
    )

    return Effect.scoped(Effect.gen(function*() {
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

      const handler = yield* makeNfs4Handler(
        makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }, generation, volume),
        { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits, writable: true }
      )

      const { client, session } = yield* startSession(handler, "unknown")
      unknown = true

      const reply = yield* handler.compound(call([
        sequence(session, 1),
        (writer) => writer.uint32(Operation.PUTROOTFH),
        create(client, "uncertain")
      ]))

      assert.strictEqual(statusOf(reply), Status.IO)
      assert.strictEqual(Result.isFailure(yield* Effect.result(caller.stat("/uncertain"))), true)
    })).pipe(Effect.provide(store))
  })

  it.effect("does not create after interruption while waiting for the core commit gate", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let hold = false

      const store = Layer.succeed(
        LiveVolume.LiveImageStore,
        LiveVolume.LiveImageStore.of({
          loadOrCreate: (initial) => Effect.succeed(initial),
          commit: () =>
            hold
              ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as("committed" as const)
              )
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

        const handler = yield* makeNfs4Handler(
          makeExport(caller, generation, { maxFilehandles: 16, maxNameBytes: ByteSize.bytes(255) }, generation, volume),
          { leaseDurationSeconds: 30, callbackTimeout: "1 second", generation, now: () => 0, limits, writable: true }
        )

        const { client, session } = yield* startSession(handler, "interrupted")
        hold = true

        const blocked = yield* caller.writeFile("/block", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        }).pipe(Effect.forkChild({ startImmediately: true }))

        yield* Deferred.await(entered)

        const attempt = yield* handler.compound(call([
          sequence(session, 1),
          (writer) => writer.uint32(Operation.PUTROOTFH),
          create(client, "cancelled")
        ])).pipe(Effect.forkChild({ startImmediately: true }))

        yield* Fiber.interrupt(attempt)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(blocked)
        assert.strictEqual(Result.isFailure(yield* Effect.result(caller.stat("/cancelled"))), true)
      })).pipe(Effect.provide(store))
    }))
})
