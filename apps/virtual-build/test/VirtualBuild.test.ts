import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, it } from "@effect/vitest"
import { ByteSize, Effect } from "effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { describe } from "vitest"
import { buildVirtual, demoFixture } from "../src/VirtualBuild.js"

const evaluate = (code: string) =>
  Effect.promise(() => import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`))

describe("standalone virtual builds", () => {
  it.live("should build, rebuild, and resolve a package through the demo CLI", () =>
    Effect.gen(function*() {
      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.spawn(["bun", fileURLToPath(new URL("../src/demo.ts", import.meta.url))], {
            stdout: "pipe",
            stderr: "inherit"
          })
        ),
        (child) => Effect.sync(() => child.kill())
      )

      const output = yield* Effect.promise(() => new Response(child.stdout).text())
      assert.strictEqual(yield* Effect.promise(() => child.exited), 0, output)
      assert.include(output, "firstBundle")
      assert.include(output, "rebuiltBundle")
      assert.include(output, "virtual-package")
    }).pipe(Effect.timeout("10 seconds")))
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should evaluate the changed value when a virtual dependency is rebuilt",
      () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.fromFixture(demoFixture)
          const caller = yield* volume.caller()
          const first = yield* buildVirtual(caller, "/__effect_vfs_demo__/main.js")
          assert.strictEqual((yield* evaluate(first.code)).value, 42)
          assert.deepStrictEqual(first.reads.sort(), ["/__effect_vfs_demo__/main.js", "/__effect_vfs_demo__/value.js"])

          yield* caller.writeFile(
            "/__effect_vfs_demo__/value.js",
            new TextEncoder().encode("export const value = 21"),
            {
              access: "write",
              truncate: true
            }
          )
          const rebuilt = yield* buildVirtual(caller, "/__effect_vfs_demo__/main.js")
          assert.strictEqual((yield* evaluate(rebuilt.code)).value, 43)
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should resolve a virtual package until its dependency is removed", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.fromFixture(demoFixture)
        const caller = yield* volume.caller()
        const built = yield* buildVirtual(caller, "/__effect_vfs_demo__/package.js")
        assert.strictEqual((yield* evaluate(built.code)).value, "virtual-package")
        assert.include(built.reads, "/node_modules/only-in-vfs/package.json")
        assert.include(built.reads, "/node_modules/only-in-vfs/index.js")

        yield* caller.unlink("/node_modules/only-in-vfs/index.js")
        const failure = yield* Effect.flip(buildVirtual(caller, "/__effect_vfs_demo__/package.js"))
        assert.include(String(failure.cause), "only-in-vfs/index.js")
      }))
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should rebuild from encoded snapshot bytes when external storage restores them",
      () =>
        Effect.gen(function*() {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => Fs.mkdtemp(Path.join(Os.tmpdir(), "effect-vfs-snapshot-"))),
            (path) => Effect.promise(() => Fs.rm(path, { recursive: true, force: true }))
          )

          const volume = yield* Vfs.fromFixture(demoFixture)
          const encoded = yield* Vfs.encodeSnapshot(yield* volume.snapshot)
          const path = Path.join(directory, "snapshot.json")
          yield* Effect.promise(() => Fs.writeFile(path, encoded))

          const restored = yield* Vfs.fromSnapshot(
            yield* Vfs.decodeSnapshot(yield* Effect.promise(() => Fs.readFile(path)), {
              maxEncodedBytes: ByteSize.megabytes(1),
              maxRecords: 100,
              maxEntries: 100,
              maxDecodedBytes: ByteSize.kilobytes(100)
            })
          )

          const result = yield* buildVirtual(yield* restored.caller(), "/__effect_vfs_demo__/main.js")
          assert.strictEqual((yield* evaluate(result.code)).value, 42)
          assert.deepStrictEqual(yield* Effect.promise(() => Fs.readdir(directory)), ["snapshot.json"])
        })
    )
  })
})
