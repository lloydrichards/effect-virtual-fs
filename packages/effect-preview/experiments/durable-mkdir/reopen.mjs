// Exercise both sessions through the scratch core's public API and on-disk v1 image.
// Core declarations are generated in the scratch build.
/* eslint-disable effecttsgo/any-unknown-in-error-context */
import assert from "node:assert/strict"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { ByteSize, Effect, FileSystem, Layer } from "effect"
import * as Live from "../../core/dist/LiveVolume.js"

const bound = ByteSize.kilobytes(64)

const imagePath = "live-image"

const pending = "candidate"

const read = () => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFile(imagePath))

const session = (decide, use) => Effect.scoped(Effect.gen(function*() {
  const { volume, shutdown } = yield* Live.openImage(yield* read(), bound, decide)
  yield* Effect.addFinalizer(() => shutdown)

  return yield* use(volume, yield* volume.caller())
}))

const store = (bytes) => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  yield* fs.writeFile(pending, bytes)
  yield* fs.rename(pending, imagePath)

  return "committed"
})

for (const accepted of [true, false]) {
  const empty = await Effect.runPromise(Live.prepareEmptyImage().pipe(Effect.provide(BunCrypto.layer)))
  // Seed a previously used allocator and a volume revision ahead of the root.
  const lines = new TextDecoder().decode(empty).trimEnd().split("\n")
  const header = JSON.parse(lines[0])
  header.runtime.nextInode = 41
  header.runtime.revision = "19"
  const root = JSON.parse(lines[1])
  root.rev = "7"
  const initial = [JSON.stringify(header), JSON.stringify(root), ""].join("\n")

  await Effect.runPromise(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(imagePath, initial)

    let offers = 0

    const before = yield* session((bytes) => {
      offers++

      return accepted ? store(bytes) : Effect.succeed("rejected")
    }, (volume, fs) => Effect.gen(function*() {
      const root = yield* fs.lookup("/")
      const key = yield* volume.referenceKey(root)
      assert.equal((yield* fs.stat(root)).revision, 7n)

      if (!accepted) {
        assert.equal((yield* Effect.flip(fs.mkdir("/candidate"))).code, "StorageRejected")

        return { key, incarnation: volume.incarnation }
      }

      yield* fs.mkdir("/candidate")
      const child = yield* fs.lookup("/candidate")
      const childKey = yield* volume.referenceKey(child)
      assert.equal(childKey.ino, 41n)
      assert.equal((yield* fs.stat(root)).revision, 20n)
      assert.equal((yield* fs.stat(child)).revision, 20n)

      return { key, childKey, incarnation: volume.incarnation }
    }))

    assert.equal(offers, 1)

    if (!accepted) assert.equal(new TextDecoder().decode(yield* read()), initial)

    yield* session(store, (volume, fs) => Effect.gen(function*() {
      assert.notEqual(volume.incarnation, before.incarnation)

      const verify = (key, path, revision) => Effect.gen(function*() {
        const ref = yield* volume.resolveReferenceKey(key)
        assert.equal(ref, yield* fs.lookup(path))
        assert.deepEqual(yield* volume.referenceKey(ref), key)
        assert.equal((yield* fs.stat(ref)).revision, revision)
      })

      yield* verify(before.key, "/", accepted ? 20n : 7n)

      if (accepted) yield* verify(before.childKey, "/candidate", 20n)
      else assert.equal((yield* Effect.flip(fs.lookup("/candidate"))).code, "NotFound")
      yield* fs.mkdir("/next")
      const next = yield* fs.stat("/next")
      assert.equal(next.ino, accepted ? 42n : 41n)
      assert.equal(next.revision, accepted ? 21n : 20n)
    }))
  }).pipe(Effect.provide(Layer.merge(BunCrypto.layer, BunFileSystem.layer))))
}

process.stdout.write("Core v1 reopen passed reference-key resolution, persisted revisions and allocation after acceptance and rejection.\n")
