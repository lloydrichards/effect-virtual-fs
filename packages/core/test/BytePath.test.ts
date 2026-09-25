import { assert, describe, it } from "@effect/vitest"
import { Effect, Equal, Hash, HashSet, Option } from "effect"
import { BytePath, VirtualFileSystem as Vfs } from "../src/index.js"

const path = (bytes: ReadonlyArray<number>) => Vfs.pathFromBytes(Uint8Array.from(bytes))

describe("BytePath", () => {
  it.effect("compares and hashes paths by their owned bytes", () =>
    Effect.gen(function*() {
      const first = yield* path([47, 97])
      const same = yield* path([47, 97])
      const third = yield* path([47, 97])
      const differentByte = yield* path([47, 98])
      const differentLength = yield* path([47, 97, 99])

      assert.isTrue(Equal.equals(first, same))
      assert.isTrue(Equal.equals(same, first))
      assert.isTrue(Equal.equals(same, third))
      assert.isTrue(Equal.equals(first, third))
      assert.isFalse(Equal.equals(first, differentByte))
      assert.isFalse(Equal.equals(first, differentLength))
      assert.strictEqual(Hash.hash(first), Hash.hash(same))
      assert.strictEqual(HashSet.size(HashSet.make(first, same, differentByte, differentLength)), 3)
      assert.isFalse(Equal.equals({ path: first }, { path: differentByte }))
      assert.deepEqual(yield* first.pipe(Vfs.pathToBytes), Uint8Array.from([47, 97]))
    }))
})

describe("BytePath toolkit", () => {
  it.effect("every toolkit function names itself when it fails", () =>
    Effect.gen(function*() {
      // SAFETY: a forged value stands in for a byte path from an untyped caller, which the toolkit must reject.
      const forged = Object.freeze({}) as BytePath.BytePath

      const operations = [
        (yield* Effect.flip(BytePath.fromBytes(new Uint8Array()))).operation,
        (yield* Effect.flip(BytePath.toBytes(forged))).operation,
        (yield* Effect.flip(BytePath.toString(forged))).operation,
        (yield* Effect.flip(BytePath.toString(yield* BytePath.fromBytes(Uint8Array.from([47, 0xff]))))).operation
      ]

      assert.deepStrictEqual(operations, [
        "BytePath.fromBytes",
        "BytePath.toBytes",
        "BytePath.toString",
        "BytePath.toString"
      ])
    }))

  it.effect("fromString names itself on every failure", () =>
    Effect.gen(function*() {
      const empty = yield* Effect.flip(BytePath.fromString(""))
      const unencodable = yield* Effect.flip(BytePath.fromString("\uD800"))

      assert.deepStrictEqual([empty.code, empty.operation], ["InvalidArgument", "BytePath.fromString"])
      assert.deepStrictEqual([unencodable.code, unencodable.operation], ["InvalidPathEncoding", "BytePath.fromString"])
    }))

  it.effect("join adds components for a slash in the name", () =>
    Effect.gen(function*() {
      const joined = BytePath.join(yield* BytePath.fromString("/a"), "b/c")

      assert.strictEqual(yield* BytePath.toString(joined), "/a/b/c")
      assert.strictEqual(yield* BytePath.toString(BytePath.parent(joined)), "/a/b")
    }))

  it("decodeOption is none for bytes that are not UTF-8", () => {
    assert.deepStrictEqual(BytePath.decodeOption(Uint8Array.from([104, 105])), Option.some("hi"))
    assert.isTrue(Option.isNone(BytePath.decodeOption(Uint8Array.from([0xff]))))
  })
})
