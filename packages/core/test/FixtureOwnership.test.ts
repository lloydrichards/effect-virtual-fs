import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"

describe("fixture byte ownership", () => {
  it.effect("should capture independent byte views when fixture construction is executed again", () =>
    Effect.gen(function*() {
      const input = new Uint8Array([0, 1, 2, 0])
      const construct = Vfs.fromFixture({ entries: [{ kind: "file", path: "/f", bytes: input.subarray(1, 3) }] })
      input[1] = 3
      const first = yield* (yield* construct).caller()
      input[1] = 4
      const second = yield* (yield* construct).caller()
      input.fill(0)
      assert.deepStrictEqual(yield* first.readFile("/f"), new Uint8Array([3, 2]))
      assert.deepStrictEqual(yield* second.readFile("/f"), new Uint8Array([4, 2]))
      yield* first.writeFile("/f", new Uint8Array([9]), { access: "write", truncate: true })
      assert.deepStrictEqual(yield* second.readFile("/f"), new Uint8Array([4, 2]))
    }))
})
