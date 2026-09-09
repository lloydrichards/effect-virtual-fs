import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"

describe("whole-file byte ownership", () => {
  it.effect("should capture independent bytes on each execution when a write effect is reused", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      const input = new Uint8Array([0, 1, 2, 0])
      const write = fs.writeFile("/f", input.subarray(1, 3), { access: "write", create: "ifMissing" })
      input[1] = 3
      yield* write
      input[1] = 4
      assert.deepStrictEqual(yield* fs.readFile("/f"), new Uint8Array([3, 2]))
      const handle = yield* fs.open("/f", { access: "write" })
      yield* handle.pwrite(new Uint8Array([9]), 0n)
      assert.deepStrictEqual(input, new Uint8Array([0, 4, 2, 0]))
      yield* write
      input.fill(0)
      const output = yield* fs.readFile("/f")
      assert.deepStrictEqual(output, new Uint8Array([4, 2]))
      output.fill(8)
      assert.deepStrictEqual(yield* fs.readFile("/f"), new Uint8Array([4, 2]))
    }))
})
