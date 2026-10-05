import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref, Stream } from "effect"
import { FileSystemTesting, MemoryFileSystem, TreeTransfer } from "../src/index.js"

describe("data-first and data-last calls", () => {
  it.layer(NodeCrypto.layer)((it) => {
    it.effect("imports streams with omitted, undefined, or explicit options in either call style", () =>
      Effect.gen(function*() {
        const entries = Stream.fromIterable<TreeTransfer.Entry>([
          { kind: "directory", path: "/" },
          { kind: "file", path: "/file", bytes: Uint8Array.of(7), metadata: { mode: 0o4755 } }
        ])

        const imports = [
          TreeTransfer.toVolume(entries),
          TreeTransfer.toVolume(entries, undefined),
          entries.pipe(TreeTransfer.toVolume()),
          entries.pipe(TreeTransfer.toVolume(undefined)),
          TreeTransfer.toVolume(entries, { specialBits: true }),
          entries.pipe(TreeTransfer.toVolume({ specialBits: true }))
        ]

        for (const [index, operation] of imports.entries()) {
          const volume = yield* operation
          const caller = yield* volume.caller()
          assert.deepStrictEqual(yield* caller.readFile("/file"), Uint8Array.of(7))
          assert.strictEqual((yield* caller.stat("/file")).mode, index >= 4 ? 0o4755 : 0o755)
        }

        assert.strictEqual(
          yield* Effect.flip(Stream.fail("source failed").pipe(TreeTransfer.toVolume())),
          "source failed"
        )
      }))

    it.effect("allocates independent decorator state each time a reusable curried constructor executes", () =>
      Effect.gen(function*() {
        const factory = Effect.fnUntraced(function*() {
          const state = yield* Ref.make(0)

          return { state, handlers: { writeFile: () => Ref.update(state, (n) => n + 1) } }
        })

        const decorate = FileSystemTesting.make(factory)
        const base = yield* MemoryFileSystem.make
        const first = yield* decorate(base)
        const second = yield* decorate(base)
        const direct = yield* FileSystemTesting.make(base, factory)
        yield* first.fileSystem.writeFileString("/file", "hello")
        assert.strictEqual(yield* Ref.get(first.state), 1)
        assert.strictEqual(yield* Ref.get(second.state), 0)
        assert.strictEqual(yield* Ref.get(direct.state), 0)
        assert.strictEqual(yield* second.fileSystem.readFileString("/file"), "hello")
        assert.strictEqual(yield* direct.fileSystem.readFileString("/file"), "hello")
      }))
  })
})
