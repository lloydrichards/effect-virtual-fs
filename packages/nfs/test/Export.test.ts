import { Testing, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, it } from "@effect/vitest"
import { Effect, Exit, Predicate, Scope } from "effect"
import * as ByteSize from "effect/ByteSize"
import { InvalidFilehandleError, InvalidNameError, makeExport, validateName } from "../src/internal/export.js"

const utf8 = (value: string) => new TextEncoder().encode(value)

const maxNameBytes = ByteSize.bytes(255)

// The export of the volume in context, read through its root caller.
const volumeExport = Effect.gen(function*() {
  const volume = yield* Vfs.Volume

  return makeExport(volume, yield* Vfs.Caller, { maxNameBytes })
})

// Why a handle names nothing: the export's reason, or the volume's code when the volume's failure says it.
const whyUnresolved = (effect: Effect.Effect<Vfs.ObjectReference, InvalidFilehandleError | Vfs.VfsError>) =>
  Effect.map(
    Effect.flip(effect),
    (failure) => failure instanceof InvalidFilehandleError ? failure.reason : failure.code
  )

// The finalizers a scope still holds, read from the state the Scope interface exposes.
const finalizerCount = (scope: Scope.Scope): number => {
  const state = scope.state

  if (!Predicate.isTagged(state, "Open")) return 0

  return state.finalizers?.size ?? (state.finalizer === undefined ? 0 : 1)
}

it.layer(NodeCrypto.layer)("NFS export identity", (it) => {
  it.effect("derives fsid from the volume identity and filehandles from reference keys", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const root = yield* (yield* Vfs.Caller).root
      const export_ = yield* volumeExport
      const key = yield* volume.referenceKey(root)
      const handle = yield* export_.handleFor(root)

      assert.deepStrictEqual(export_.fsid, [0x0001_0203_0405_0607n, 0x0809_0a0b_0c0d_0e0fn])
      assert.deepStrictEqual(handle.subarray(1, 17), key.identity)
      assert.deepStrictEqual(handle.subarray(17, 33), key.epoch)
      assert.deepStrictEqual(handle.subarray(41, 57), key.tag)
      assert.lengthOf(handle, 57)
      assert.isFalse(export_.persistentHandles)
    }).pipe(
      Effect.provide(
        Testing.layer({ volume: { identity: Vfs.VolumeIdentity.make("000102030405060708090a0b0c0d0e0f") } })
      )
    ))

  it.effect("keeps handles opaque and stable across hard-link and rename aliases", () =>
    Effect.gen(function*() {
      const caller = yield* Vfs.Caller
      yield* caller.writeFile("/original", new Uint8Array([1]), { access: "write", create: "exclusive" })
      yield* caller.link("/original", "/alias")
      const root = yield* caller.root
      const original = yield* caller.lookup(Vfs.Entry(root, utf8("original")))
      const alias = yield* caller.lookup(Vfs.Entry(root, utf8("alias")))
      const export_ = yield* volumeExport
      const before = yield* export_.handleFor(original)
      assert.deepStrictEqual(yield* export_.handleFor(alias), before)
      yield* caller.rename("/original", "/renamed")
      assert.strictEqual(yield* export_.resolve(before), original)
      assert.notInclude(new TextDecoder().decode(before), "original")
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("expires another volume's handles when volatile and reports them stale when persistent", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      const handle = yield* (yield* volumeExport).handleFor(yield* caller.root)
      const restored = yield* Vfs.fromSnapshot(yield* volume.snapshot, { identity: volume.identity })
      const restoredCaller = yield* restored.caller()
      const durable = { ...restored, durability: "survives-process-crash" as const }
      const volatile = makeExport(restored, restoredCaller, { maxNameBytes })
      const persistent = makeExport(durable, restoredCaller, { maxNameBytes })

      assert.isTrue(persistent.persistentHandles)
      assert.strictEqual(yield* whyUnresolved(volatile.resolve(handle)), "Expired")
      assert.strictEqual(yield* whyUnresolved(persistent.resolve(handle)), "Stale")
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("rejects a handle after its object is deleted", () =>
    Effect.gen(function*() {
      const caller = yield* Vfs.Caller
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const root = yield* caller.root
      const reference = yield* caller.lookup(Vfs.Entry(root, utf8("file")))
      const export_ = yield* volumeExport
      const handle = yield* export_.handleFor(reference)
      yield* caller.unlink("/file")
      assert.strictEqual(yield* whyUnresolved(export_.resolve(handle)), "StaleReference")
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("keeps a deleted object's handle valid while the file remains open", () =>
    Effect.gen(function*() {
      const caller = yield* Vfs.Caller
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const root = yield* caller.root
      const reference = yield* caller.lookup(Vfs.Entry(root, utf8("file")))
      const export_ = yield* volumeExport
      const handle = yield* export_.handleFor(reference)
      const opened = yield* export_.open(reference)
      yield* caller.unlink("/file")
      assert.strictEqual(yield* export_.resolve(handle), reference)
      yield* opened.close
      assert.strictEqual(yield* whyUnresolved(export_.resolve(handle)), "StaleReference")
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("closes an open with the scope it was opened in, and early on close", () =>
    Effect.gen(function*() {
      const caller = yield* Vfs.Caller
      yield* caller.writeFile("/held", new Uint8Array([1]), { access: "write", create: "exclusive" })
      yield* caller.writeFile("/closed", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const root = yield* caller.root
      const held = yield* caller.lookup(Vfs.Entry(root, utf8("held")))
      const closed = yield* caller.lookup(Vfs.Entry(root, utf8("closed")))
      const export_ = yield* volumeExport
      const parent = yield* Scope.make()

      yield* Scope.provide(export_.open(held), parent)
      const early = yield* Scope.provide(export_.open(closed), parent)
      yield* caller.unlink("/held")
      yield* caller.unlink("/closed")

      yield* early.close
      assert.strictEqual((yield* Effect.flip(caller.stat(closed))).code, "StaleReference")
      assert.strictEqual((yield* caller.stat(held)).nlink, 0)

      yield* Scope.close(parent, Exit.void)
      assert.strictEqual((yield* Effect.flip(caller.stat(held))).code, "StaleReference")
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("leaves no finalizer in the scope an open was opened in once it closes", () =>
    Effect.gen(function*() {
      const caller = yield* Vfs.Caller
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const root = yield* caller.root
      const reference = yield* caller.lookup(Vfs.Entry(root, utf8("file")))
      const export_ = yield* volumeExport
      const parent = yield* Scope.make()

      for (let cycle = 0; cycle < 8; cycle++) {
        const opened = yield* Scope.provide(export_.open(reference), parent)
        yield* opened.close
        const child = yield* Scope.provide(export_.openChild(root, utf8("file"), { access: "read" }), parent)
        yield* child.close
      }

      assert.strictEqual(finalizerCount(parent), 0)
      yield* Scope.close(parent, Exit.void)
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("rejects bytes that are not a handle this export issued as malformed", () =>
    Effect.gen(function*() {
      const caller = yield* Vfs.Caller
      yield* caller.writeFile("/f", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const export_ = yield* volumeExport
      const handle = yield* export_.handleFor(yield* caller.root)
      const version = handle.slice()
      version[0] = 1
      const noInode = handle.slice()
      noInode.fill(0, 33)
      // The root's handle with the next inode number, which /f holds, and with one tag bit flipped.
      const neighbour = handle.slice()
      new DataView(neighbour.buffer).setBigUint64(33, (yield* caller.stat("/f")).ino)
      const altered = handle.slice()
      altered[56] = altered[56]! ^ 1

      for (const malformed of [handle.subarray(0, 41), version, noInode, neighbour, altered]) {
        assert.strictEqual(yield* whyUnresolved(export_.resolve(malformed)), "Malformed")
      }
    }).pipe(Effect.provide(Testing.layer())))

  it("accepts exact UTF-8 without normalizing and rejects unsafe components", () => {
    const decomposed = utf8("e\u0301")
    assert.strictEqual(validateName(decomposed, maxNameBytes), "e\u0301")
    assert.deepStrictEqual(new TextEncoder().encode(validateName(decomposed, maxNameBytes)), decomposed)

    for (const name of [new Uint8Array(), utf8("a/b"), new Uint8Array([0]), new Uint8Array([0xff]), utf8("..")]) {
      assert.throws(() => validateName(name, maxNameBytes), InvalidNameError)
    }
  })
})
