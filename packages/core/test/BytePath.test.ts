import { assert, describe, it } from "@effect/vitest"
import { Effect, Equal, Hash, HashSet } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"

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
