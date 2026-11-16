import { Search, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { MemoryFileSystem } from "@effect-vfs/memory"
import { Deferred, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import assert from "node:assert/strict"

const platform = process.versions.bun
  ? await import("@effect/platform-bun/BunCrypto")
  : await import("@effect/platform-node-shared/NodeCrypto")

const check = Effect.scoped(Effect.gen(function*() {
  const volume = yield* Vfs.fromFixture({
    entries: [{ kind: "file", path: "/seed", bytes: new TextEncoder().encode("before") }]
  })

  const caller = yield* volume.caller()
  const fs = yield* MemoryFileSystem.bind(volume)
  assert.equal(yield* fs.readFileString("/seed"), "before")

  const before = yield* volume.snapshot
  const registered = yield* Deferred.make<Stream.Stream<Vfs.Change>>()

  // Keep the stream so we can observe its subscription ending when the owner is interrupted.
  const owner = yield* Effect.scoped(Effect.gen(function*() {
    const events = yield* volume.watch()
    yield* Deferred.succeed(registered, events)

    return yield* Effect.never
  })).pipe(Effect.forkChild)

  const events = yield* Deferred.await(registered)
  yield* fs.writeFileString("/seed", "after")
  assert.deepEqual(yield* caller.readFile("/seed"), new TextEncoder().encode("after"))

  const first = yield* Stream.runHead(events)
  assert.ok(Option.isSome(first))
  assert.equal(first.value._tag, "Update")
  assert.equal(new TextDecoder().decode(yield* Vfs.pathToBytes(first.value.path)), "/seed")
  yield* Fiber.interrupt(owner)
  assert.ok(Exit.hasInterrupts(yield* Effect.exit(Stream.runHead(events))))

  const after = yield* volume.snapshot
  const restored = yield* Vfs.applySnapshotDelta(before, yield* Vfs.diffSnapshots(before, after))

  const matches = yield* Search.files(restored, {
    root: "/",
    include: ["**"],
    pattern: Search.Pattern.cases.Literal.make({ pattern: "after" })
  })

  assert.deepEqual(matches.results, ["seed"])

  const key = yield* volume.referenceKey(yield* caller.lookup("/seed"))
  assert.deepEqual(yield* volume.referenceKey(yield* volume.resolveReferenceKey(key)), key)
})).pipe(Effect.timeout("10 seconds"))

await Effect.runPromise(check.pipe(Effect.provide(platform.layer)))

await Effect.runPromise(check.pipe(Effect.provide(Layer.merge(Digest.layerWebCrypto, SecureRandom.layerWebCrypto))))
