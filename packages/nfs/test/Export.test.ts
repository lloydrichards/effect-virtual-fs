import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import * as ByteSize from "effect/ByteSize"
import { InvalidFilehandleError, InvalidNameError, makeExport, validateName } from "../src/internal/export.js"

const generation = (value: number) => new Uint8Array(16).fill(value)

const utf8 = (value: string) => new TextEncoder().encode(value)

const maxNameBytes = ByteSize.bytes(255)

it.layer(NodeCrypto.layer)("NFS export identity", (it) => {
  it.effect("derives fsid from stable identity and filehandles from the incarnation", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const root = yield* caller.rootReference
      const incarnation = generation(0x11)
      const identity = Uint8Array.from({ length: 16 }, (_, index) => index)
      const export_ = makeExport(caller, incarnation, { maxFilehandles: 2, maxNameBytes }, identity)
      const handle = yield* export_.handleFor(root)

      assert.deepStrictEqual(export_.fsid, [0x0001_0203_0405_0607n, 0x0809_0a0b_0c0d_0e0fn])
      assert.deepStrictEqual(handle.subarray(1, 17), incarnation)
    }))

  it.effect("keeps handles opaque and stable across hard-link and rename aliases", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/original", new Uint8Array([1]), { access: "write", create: "exclusive" })
      yield* caller.link("/original", "/alias")
      const root = yield* caller.rootReference
      const original = yield* caller.lookupReference(root, utf8("original"))
      const alias = yield* caller.lookupReference(root, utf8("alias"))
      const export_ = makeExport(caller, generation(1), { maxFilehandles: 4, maxNameBytes })
      const before = yield* export_.handleFor(original)
      assert.deepStrictEqual(yield* export_.handleFor(alias), before)
      yield* caller.rename("/original", "/renamed")
      assert.strictEqual(yield* export_.resolve(before), original)
      assert.notInclude(new TextDecoder().decode(before), "original")
    }))

  it.effect("rejects handles from a different server generation", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const root = yield* caller.rootReference
      const oldExport = makeExport(caller, generation(1), { maxFilehandles: 2, maxNameBytes })
      const nextExport = makeExport(caller, generation(2), { maxFilehandles: 2, maxNameBytes })
      const failure = yield* Effect.flip(nextExport.resolve(yield* oldExport.handleFor(root)))
      assert.instanceOf(failure, InvalidFilehandleError)
      assert.strictEqual(failure.reason, "WrongGeneration")
    }))

  it.effect("rejects a handle after its object is deleted", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const root = yield* caller.rootReference
      const reference = yield* caller.lookupReference(root, utf8("file"))
      const export_ = makeExport(caller, generation(1), { maxFilehandles: 2, maxNameBytes })
      const handle = yield* export_.handleFor(reference)
      yield* caller.unlink("/file")
      const failure = yield* Effect.flip(export_.resolve(handle))
      assert.strictEqual(failure.reason, "Stale")
    }))

  it.effect("keeps a deleted object's handle valid while the file remains open", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const root = yield* caller.rootReference
      const reference = yield* caller.lookupReference(root, utf8("file"))
      const export_ = makeExport(caller, generation(1), { maxFilehandles: 2, maxNameBytes })
      const handle = yield* export_.handleFor(reference)
      const opened = yield* export_.open(reference)
      yield* caller.unlink("/file")
      assert.strictEqual(yield* export_.resolve(handle), reference)
      yield* opened.close
      assert.strictEqual((yield* Effect.flip(export_.resolve(handle))).reason, "Stale")
    }))

  it.effect("reclaims stale mappings without changing live handle identity", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/old", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const root = yield* caller.rootReference
      const old = yield* caller.lookupReference(root, utf8("old"))
      const export_ = makeExport(caller, generation(1), { maxFilehandles: 2, maxNameBytes })
      const rootHandle = yield* export_.handleFor(root)
      const oldHandle = yield* export_.handleFor(old)
      yield* caller.unlink("/old")
      yield* caller.writeFile("/new", new Uint8Array([2]), { access: "write", create: "exclusive" })
      const fresh = yield* caller.lookupReference(root, utf8("new"))
      yield* export_.handleFor(fresh)
      assert.deepStrictEqual(yield* export_.handleFor(root), rootHandle)
      assert.strictEqual((yield* Effect.flip(export_.resolve(oldHandle))).reason, "Unknown")
    }))

  it("accepts exact UTF-8 without normalizing and rejects unsafe components", () => {
    const decomposed = utf8("e\u0301")
    assert.strictEqual(validateName(decomposed, maxNameBytes), "e\u0301")
    assert.deepStrictEqual(new TextEncoder().encode(validateName(decomposed, maxNameBytes)), decomposed)

    for (const name of [new Uint8Array(), utf8("a/b"), new Uint8Array([0]), new Uint8Array([0xff]), utf8("..")]) {
      assert.throws(() => validateName(name, maxNameBytes), InvalidNameError)
    }
  })
})
