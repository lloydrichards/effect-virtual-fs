import { VirtualFileSystem } from "@effect-vfs/core"
import * as Vfs from "@effect-vfs/core/VirtualFileSystem"
import * as MemoryFileSystem from "@effect-vfs/memory/MemoryFileSystem"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { Cause, Context, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Scope } from "effect"
import assert from "node:assert/strict"
import { manifestPath, rebuildManifest } from "./manifest-workload.mjs"

assert.strictEqual(VirtualFileSystem.make, Vfs.make)

await Effect.runPromise(
  Effect.scoped(Effect.gen(function*() {
    const volume: Vfs.Volume = yield* Vfs.make()
    const caller = yield* volume.caller()
    const bytes = Uint8Array.of(0, 127, 128, 255)
    yield* caller.writeFile("/round-trip", bytes, { access: "write", create: "exclusive" })
    assert.deepStrictEqual(yield* (yield* volume.caller()).readFile("/round-trip"), bytes)

    const fs = yield* MemoryFileSystem.bind(volume)
    const missing = yield* Effect.flip(fs.writeFileString("/missing/out", "rejected"))
    assert.equal(missing._tag, "PlatformError")
    assert.equal(missing.reason._tag, "NotFound")
    assert.equal(yield* fs.exists("/missing"), false)

    yield* fs.makeDirectory("/src")
    yield* fs.makeDirectory("/dist")
    yield* fs.writeFileString("/src/manifest.json", "{\"name\":\"packed-workload\"}")
    yield* fs.writeFileString("/dist/stale.json", "{}")

    // Version 0.8.0 has no public FileSystemTesting export. Rebuild derived
    // methods with Effect's FileSystem.make so they delegate through the spy.
    const writes: Array<string> = []

    const observed = FileSystem.make({
      ...fs,
      writeFile: (path, data, options) =>
        Effect.sync(() => {
          writes.push(path)
        }).pipe(Effect.andThen(fs.writeFile(path, data, options)))
    })

    const runBuild = rebuildManifest.pipe(Effect.provideService(FileSystem.FileSystem, observed))
    yield* runBuild
    assert.equal(yield* fs.readFileString(manifestPath), "{\"name\":\"packed-workload\"}")
    assert.equal(yield* fs.exists("/dist/stale.json"), false)
    assert.deepStrictEqual(writes, [manifestPath])

    yield* runBuild
    assert.deepStrictEqual(writes, [manifestPath])

    const scope = yield* Scope.Scope
    const memo = yield* Layer.makeMemoMap
    const first = Context.get(yield* Layer.buildWithMemoMap(MemoryFileSystem.layer, memo, scope), FileSystem.FileSystem)

    const shared = Context.get(
      yield* Layer.buildWithMemoMap(MemoryFileSystem.layer, memo, scope),
      FileSystem.FileSystem
    )

    const fresh = Context.get(
      yield* Layer.buildWithMemoMap(Layer.fresh(MemoryFileSystem.layer), memo, scope),
      FileSystem.FileSystem
    )

    yield* first.writeFileString("/layer-state", "shared")
    assert.equal(yield* shared.readFileString("/layer-state"), "shared")
    assert.equal(yield* fresh.exists("/layer-state"), false)

    const released = yield* Effect.scoped(fs.open(manifestPath, { flag: "r" }))
    assert.equal((yield* Effect.flip(released.stat)).reason._tag, "BadResource")

    const started = yield* Deferred.make<{ path: string; handle: FileSystem.File }>()

    const task = yield* Effect.forkChild(Effect.scoped(Effect.gen(function*() {
      const path = yield* fs.makeTempFileScoped({ directory: "/dist" })
      const handle = yield* fs.open(path, { flag: "r" })
      yield* Deferred.succeed(started, { path, handle })

      return yield* Effect.never
    })))

    const temporary = yield* Deferred.await(started)
    assert.equal(yield* fs.exists(temporary.path), true)
    yield* Fiber.interrupt(task)

    const outcome = yield* Fiber.await(task)
    assert.ok(Exit.isFailure(outcome) && Cause.hasInterruptsOnly(outcome.cause))
    assert.equal((yield* Effect.flip(temporary.handle.stat)).reason._tag, "BadResource")
    assert.equal(yield* fs.exists(temporary.path), false)
  })).pipe(Effect.provide(NodeCrypto.layer))
)
