import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { VirtualFileSystem as Vfs } from "../../src/index.js"

describe("directory insertion order", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect("should preserve live order and captured contents when deleted slots are compacted", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make()
        const caller = yield* volume.caller()
        const names = Array.from({ length: 80 }, (_, i) => `f${i}`)
        const bytes = new Uint8Array([1])

        for (const name of names) yield* caller.writeFile(`/${name}`, bytes, { access: "write", create: "exclusive" })
        const snapshot = yield* volume.snapshot

        for (const name of names.slice(0, 60)) yield* caller.unlink(`/${name}`)
        yield* caller.writeFile("/f65", new Uint8Array([2]), { access: "write", create: "never" })
        yield* caller.writeFile("/f1", bytes, { access: "write", create: "exclusive" })
        const decoder = new TextDecoder()
        assert.deepStrictEqual(
          (yield* caller.readDirectory("/")).value.map((entry) => decoder.decode(entry.name)),
          [...names.slice(60), "f1"]
        )
        const restored = yield* (yield* Vfs.fromSnapshot(snapshot)).caller()
        assert.deepStrictEqual(
          (yield* restored.readDirectory("/")).value.map((entry) => decoder.decode(entry.name)),
          [...names].sort()
        )
        assert.deepStrictEqual(yield* restored.readFile("/f65"), bytes)
        assert.deepStrictEqual(yield* caller.readFile("/f65"), new Uint8Array([2]))
      }))
  })
})
