import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { BytePath, Target, VirtualFileSystem as Vfs } from "../src/index.js"

describe("Target", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect("addresses the same entry through a path, reference or directory handle", () =>
      Effect.gen(function*() {
        const caller = yield* (yield* Vfs.make()).caller()
        yield* caller.mkdir("/work")
        const path = yield* BytePath.fromString("/work")
        const reference = yield* caller.lookup(path)
        const handle = yield* caller.openDirectory(path)
        yield* caller.writeFile(Target.Entry(path, "data"), Uint8Array.of(7), { access: "write", create: "exclusive" })

        for (const directory of [path, reference, handle, Target.Target.of("/work")]) {
          const entry = Target.Entry("data")(directory)
          assert.isTrue(Target.isEntry(entry))
          assert.deepStrictEqual(yield* caller.readFile(yield* caller.lookup(entry)), Uint8Array.of(7))
        }
      }))
  })

  it("accepts byte names up to 255 bytes and rejects empty names, NUL and slash", () => {
    const isName = Schema.is(Target.Name)
    assert.isTrue(isName(new Uint8Array(255).fill(255)))

    for (const invalid of [Uint8Array.of(), Uint8Array.of(0), Uint8Array.of(47), new Uint8Array(256).fill(65)]) {
      assert.isFalse(isName(invalid))
    }
  })
})
