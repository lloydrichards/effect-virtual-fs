import { VirtualFileSystem } from "@effect-vfs/core"
import * as Vfs from "@effect-vfs/core/VirtualFileSystem"
import * as FileSystemTesting from "@effect-vfs/memory/FileSystemTesting"
import * as MemoryFileSystem from "@effect-vfs/memory/MemoryFileSystem"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { Effect, FileSystem, Ref } from "effect"
import assert from "node:assert/strict"

assert.strictEqual(VirtualFileSystem.make, Vfs.make)

const build = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const output = "/dist/manifest.json"
  const stale = "/dist/stale.json"
  const manifest = yield* fs.readFileString("/src/manifest.json")

  if (!(yield* fs.exists(output)) || (yield* fs.readFileString(output)) !== manifest) {
    yield* fs.writeFileString(output, manifest)
  }

  if (yield* fs.exists(stale)) yield* fs.remove(stale)
})

await Effect.runPromise(
  Effect.scoped(Effect.gen(function*() {
    const volume: Vfs.Volume = yield* VirtualFileSystem.make()
    const writer = yield* volume.caller()
    const bytes = Uint8Array.of(0, 127, 128, 255)
    yield* writer.writeFile("/round-trip", bytes, { access: "write", create: "exclusive" })

    const reader = yield* volume.caller()
    assert.deepStrictEqual(yield* reader.readFile("/round-trip"), bytes)

    const base = yield* MemoryFileSystem.bind(volume)
    const missing = yield* Effect.flip(base.writeFileString("/missing/out", "rejected"))
    assert.equal(missing.reason._tag, "NotFound")

    yield* base.makeDirectory("/src")
    yield* base.makeDirectory("/dist")
    yield* base.writeFileString("/src/manifest.json", "{\"name\":\"packed-workload\"}")
    yield* base.writeFileString("/dist/stale.json", "{}")

    const { fileSystem, state: writes } = yield* FileSystemTesting.make(base, () =>
      Effect.gen(function*() {
        const state = yield* Ref.make<ReadonlyArray<string>>([])

        return {
          state,
          handlers: { writeFile: (path) => Ref.update(state, (paths) => [...paths, path]) }
        }
      }))

    const runBuild = build.pipe(Effect.provideService(FileSystem.FileSystem, fileSystem))
    yield* runBuild
    assert.equal(yield* base.readFileString("/dist/manifest.json"), "{\"name\":\"packed-workload\"}")
    assert.equal(yield* base.exists("/dist/stale.json"), false)
    assert.deepEqual(yield* Ref.get(writes), ["/dist/manifest.json"])

    yield* runBuild
    assert.deepEqual(yield* Ref.get(writes), ["/dist/manifest.json"])

    const temporary = yield* Effect.scoped(Effect.gen(function*() {
      const path = yield* base.makeTempFileScoped({ directory: "/dist" })
      assert.equal(yield* base.exists(path), true)

      return path
    }))

    assert.equal(yield* base.exists(temporary), false)
  })).pipe(Effect.provide(NodeCrypto.layer))
)
