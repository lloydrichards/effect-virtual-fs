import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { InvalidFilehandleError, InvalidNameError, makeExport, validateName } from "../src/internal/export.js"

const generation = (value: number) => new Uint8Array(16).fill(value)
const utf8 = (value: string) => new TextEncoder().encode(value)

describe("NFS export identity", () => {
  it.effect("keeps handles opaque and stable across hard-link and rename aliases", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/original", new Uint8Array([1]), { access: "write", create: "exclusive" })
      yield* caller.link("/original", "/alias")
      const root = yield* caller.rootReference
      const original = yield* caller.lookupReference(root, utf8("original"))
      const alias = yield* caller.lookupReference(root, utf8("alias"))
      const export_ = makeExport(caller, generation(1), { maxFilehandles: 4, maxNameBytes: 255 })
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
      const oldExport = makeExport(caller, generation(1), { maxFilehandles: 2, maxNameBytes: 255 })
      const nextExport = makeExport(caller, generation(2), { maxFilehandles: 2, maxNameBytes: 255 })
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
      const export_ = makeExport(caller, generation(1), { maxFilehandles: 2, maxNameBytes: 255 })
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
      const export_ = makeExport(caller, generation(1), { maxFilehandles: 2, maxNameBytes: 255 })
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
      const export_ = makeExport(caller, generation(1), { maxFilehandles: 2, maxNameBytes: 255 })
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
    assert.strictEqual(validateName(decomposed, 255), "e\u0301")
    assert.deepStrictEqual(new TextEncoder().encode(validateName(decomposed, 255)), decomposed)
    for (const name of [new Uint8Array(), utf8("a/b"), new Uint8Array([0]), new Uint8Array([0xff]), utf8("..")]) {
      assert.throws(() => validateName(name, 255), InvalidNameError)
    }
  })
})
