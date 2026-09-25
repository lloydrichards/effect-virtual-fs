import { Testing, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Deferred, Effect, Exit, Fiber, Option, Scope, Stream } from "effect"
import * as Memory from "../src/MemoryFileSystem.js"

const bytes = new TextEncoder()

describe("core-backed memory bindings", () => {
  it.effect("should share file contents and keep cursors independent when bindings use one volume", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const core = yield* Vfs.Caller
      const a = yield* Memory.bind(volume)
      const b = yield* Memory.bind(volume)
      yield* core.writeFile("/f", bytes.encode("abc"), { access: "write", create: "exclusive" })
      const af = yield* a.open("/f")
      const bf = yield* b.open("/f")
      const read = yield* af.readAlloc(1)
      assert.isTrue(Option.isSome(read))
      assert.strictEqual(yield* bf.seek(0n, "current"), 0n)
      yield* b.writeFileString("/f", "xyz")
      assert.strictEqual(new TextDecoder().decode(Option.getOrThrow(yield* bf.readAlloc(3))), "xyz")
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("should leave the volume namespace unchanged when binding an adapter", () =>
    Effect.gen(function*() {
      const adapter = yield* Memory.bind(yield* Vfs.Volume)
      assert.isFalse(yield* adapter.exists("/tmp"))
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("should close only the handle owned by a binding when its scope closes", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const a = yield* Memory.bind(volume)
      const b = yield* Memory.bind(volume)
      yield* b.writeFileString("/f", "xyz")
      const scope = yield* Scope.make()
      const closed = yield* a.open("/f").pipe(Scope.provide(scope))
      yield* Scope.close(scope, Exit.void)
      yield* Effect.flip(closed.readAlloc(1))
      assert.strictEqual(yield* closed.seek(10n, "start"), 0n)
      assert.strictEqual(yield* b.readFileString("/f"), "xyz")
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("should deliver direct core and alias writes in commit order when an adapter watches", () =>
    Effect.gen(function*() {
      const core = yield* Vfs.Caller
      const adapter = yield* Memory.bind(yield* Vfs.Volume)
      yield* core.writeFile("/f", bytes.encode("old"), { access: "write", create: "exclusive" })
      yield* core.link("/f", "/alias")
      const changes = yield* Testing.collectChanges(adapter.watch("/"), 4)

      yield* core.writeFile("/f", bytes.encode("new"), { access: "write", truncate: true })
      yield* core.rename("/alias", "/renamed")
      assert.deepStrictEqual(yield* changes, [
        { _tag: "Update", path: "/f" },
        { _tag: "Update", path: "/alias" },
        { _tag: "Remove", path: "/alias" },
        { _tag: "Create", path: "/renamed" }
      ])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("should recover subtree changes when a watch overflows during rescan", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const core = yield* Vfs.Caller
      yield* core.mkdir("/sub")
      const adapter = yield* Memory.bind(volume)
      const scope = yield* Scope.make()
      const stream = yield* volume.watch().pipe(Scope.provide(scope))
      yield* core.mkdir("/sub/a")
      yield* core.mkdir("/sub/b")
      const marker = yield* Stream.runCollect(Stream.take(stream, 2))
      assert.deepEqual(Array.from(marker, (event) => event._tag), ["Create", "Rescan"])
      yield* Scope.close(scope, Exit.void)

      const first = yield* Deferred.make<void>()
      const resume = yield* Deferred.make<void>()

      const watch = yield* adapter.watch("/sub").pipe(
        Stream.tap(() => Deferred.succeed(first, undefined).pipe(Effect.andThen(Deferred.await(resume)))),
        Stream.runDrain,
        Effect.flip,
        Effect.forkChild({ startImmediately: true })
      )

      yield* Effect.yieldNow
      yield* core.mkdir("/sub/c")
      yield* Deferred.await(first)
      yield* core.mkdir("/sub/d")
      yield* core.mkdir("/sub/e")
      yield* Deferred.succeed(resume, undefined)
      const error = yield* Fiber.join(watch)
      assert.strictEqual(error.reason._tag, "Unknown")
      assert.isTrue(Memory.isWatchOverflow(error))

      const newWatchReady = yield* Deferred.make<void>()

      const recovered = yield* adapter.watch("/sub").pipe(
        Stream.take(2),
        Stream.tap(() => Deferred.succeed(newWatchReady, undefined)),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )

      yield* Effect.yieldNow
      yield* core.mkdir("/sub/ready")
      yield* Deferred.await(newWatchReady)

      const scanRead = yield* Deferred.make<void>()
      const finishScan = yield* Deferred.make<void>()

      const scan = yield* adapter.readDirectory("/sub").pipe(
        Effect.tap(() => Deferred.succeed(scanRead, undefined)),
        Effect.tap(() => Deferred.await(finishScan)),
        Effect.forkChild({ startImmediately: true })
      )

      yield* Deferred.await(scanRead)
      yield* core.mkdir("/sub/during-rescan")
      yield* Deferred.succeed(finishScan, undefined)
      const scanned = yield* Fiber.join(scan)
      assert.isTrue(scanned.includes("ready"))
      assert.isFalse(scanned.includes("during-rescan"))
      assert.deepStrictEqual(yield* Fiber.join(recovered), [
        { _tag: "Create", path: "/sub/ready" },
        { _tag: "Create", path: "/sub/during-rescan" }
      ])
    }).pipe(Effect.provide(Testing.layer({ volume: { maxWatchEvents: 2 } }))))

  it.effect("should preserve the old file and publish no update when a whole-file write exceeds quota", () =>
    Effect.gen(function*() {
      const core = yield* Vfs.Caller
      const adapter = yield* Memory.bind(yield* Vfs.Volume)
      yield* adapter.writeFileString("/f", "old")
      const before = yield* core.stat("/f")
      const changes = yield* Testing.collectChanges(adapter.watch("/"), 1)

      yield* Effect.flip(adapter.writeFileString("/f", "too long"))
      assert.deepStrictEqual(yield* core.stat("/f"), before)
      assert.strictEqual(yield* adapter.readFileString("/f"), "old")
      yield* core.mkdir("/sentinel")
      assert.deepStrictEqual(yield* changes, [{ _tag: "Create", path: "/sentinel" }])
    }).pipe(Effect.provide(Testing.layer({ volume: { maxBytes: ByteSize.bytes(3) } }))))

  it.effect("should filter unrelated byte names when converting watched paths to strings", () =>
    Effect.gen(function*() {
      const core = yield* Vfs.Caller
      const adapter = yield* Memory.bind(yield* Vfs.Volume)
      yield* core.mkdir("/watched")
      const changes = yield* Testing.collectChanges(adapter.watch("/watched"), 1)

      yield* core.mkdir(yield* Vfs.pathFromBytes(new Uint8Array([47, 255])))
      yield* core.mkdir("/watched/child")
      assert.deepStrictEqual(yield* changes, [{ _tag: "Create", path: "/watched/child" }])
      const invalid = yield* Effect.flip(adapter.readDirectory("/"))
      assert.strictEqual(invalid.reason._tag, "InvalidData")
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("should keep delivering a watched directory's changes after an ancestor is renamed", () =>
    Effect.gen(function*() {
      const core = yield* Vfs.Caller
      const adapter = yield* Memory.bind(yield* Vfs.Volume)
      yield* core.mkdir("/project")
      yield* core.mkdir("/project/watched")
      const changes = yield* Testing.collectChanges(adapter.watch("/project/watched"), 1)

      yield* core.rename("/project", "/renamed")
      yield* core.mkdir("/renamed/watched/child")
      assert.deepStrictEqual(yield* changes, [{ _tag: "Create", path: "/renamed/watched/child" }])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("should keep delivering a watched file's updates at its new name after it is renamed", () =>
    Effect.gen(function*() {
      const core = yield* Vfs.Caller
      const adapter = yield* Memory.bind(yield* Vfs.Volume)
      yield* core.writeFile("/a", bytes.encode("one"), { access: "write", create: "exclusive" })
      const changes = yield* Testing.collectChanges(adapter.watch("/a"), 3)

      yield* core.rename("/a", "/b")
      yield* core.writeFile("/b", bytes.encode("two"), { access: "write" })
      assert.deepStrictEqual(yield* changes, [
        { _tag: "Remove", path: "/a" },
        { _tag: "Create", path: "/b" },
        { _tag: "Update", path: "/b" }
      ])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("should keep delivering a watched file's updates after an ancestor is renamed", () =>
    Effect.gen(function*() {
      const core = yield* Vfs.Caller
      const adapter = yield* Memory.bind(yield* Vfs.Volume)
      yield* core.mkdir("/d")
      yield* core.writeFile("/d/a", bytes.encode("one"), { access: "write", create: "exclusive" })
      const changes = yield* Testing.collectChanges(adapter.watch("/d/a"), 1)

      yield* core.rename("/d", "/e")
      yield* core.writeFile("/e/a", bytes.encode("two"), { access: "write" })
      assert.deepStrictEqual(yield* changes, [{ _tag: "Update", path: "/e/a" }])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("should not deliver a watched file's updates made through another hard link", () =>
    Effect.gen(function*() {
      const core = yield* Vfs.Caller
      const adapter = yield* Memory.bind(yield* Vfs.Volume)
      yield* core.writeFile("/a", bytes.encode("one"), { access: "write", create: "exclusive" })
      yield* core.link("/a", "/alias")
      const changes = yield* Testing.collectChanges(adapter.watch("/a"), 1)

      yield* core.writeFile("/alias", bytes.encode("two"), { access: "write" })
      yield* core.writeFile("/a", bytes.encode("three"), { access: "write" })
      assert.deepStrictEqual(yield* changes, [{ _tag: "Update", path: "/a" }])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("should end a watch after reporting the watched directory's removal", () =>
    Effect.gen(function*() {
      const core = yield* Vfs.Caller
      const adapter = yield* Memory.bind(yield* Vfs.Volume)
      yield* core.mkdir("/watched")
      // Asks for more changes than arrive, so it completes only because the stream ends.
      const changes = yield* Testing.collectChanges(adapter.watch("/watched"), 2)

      yield* core.rmdir("/watched")
      assert.deepStrictEqual(yield* changes, [{ _tag: "Remove", path: "/watched" }])
    }).pipe(Effect.provide(Testing.layer())))

  // A volume whose first watch registration runs `change` first, as a change queued ahead of it would.
  const changedBeforeFirstWatch = (volume: Vfs.Volume, change: Effect.Effect<unknown, Vfs.FsFailure>): Vfs.Volume => {
    let pending = true

    return {
      ...volume,
      watch: (options) =>
        Effect.suspend(() => {
          if (!pending) return volume.watch(options)
          pending = false

          return Effect.andThen(Effect.orDie(change), volume.watch(options))
        })
    }
  }

  it.effect("should watch the object a path names once the watch is active when a rename lands as it opens", () =>
    Effect.gen(function*() {
      const core = yield* Vfs.Caller
      yield* core.mkdir("/w")
      yield* core.mkdir("/x")

      const volume = changedBeforeFirstWatch(
        yield* Vfs.Volume,
        Effect.andThen(core.rename("/w", "/x/w"), core.mkdir("/w"))
      )

      const adapter = yield* Memory.bind(volume)
      const changes = yield* Testing.collectChanges(adapter.watch("/w"), 1)

      yield* core.mkdir("/x/w/other")
      yield* core.mkdir("/w/child")
      assert.deepStrictEqual(yield* changes, [{ _tag: "Create", path: "/w/child" }])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("should fail a watch with NotFound when its path is removed as the watch opens", () =>
    Effect.gen(function*() {
      const core = yield* Vfs.Caller
      yield* core.mkdir("/w")
      const adapter = yield* Memory.bind(changedBeforeFirstWatch(yield* Vfs.Volume, core.rmdir("/w")))

      const error = yield* Effect.flip(Stream.runCollect(adapter.watch("/w")))
      assert.strictEqual(error._tag, "PlatformError")
      assert.strictEqual(error.reason._tag, "NotFound")
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("should preserve hard-link topology when copying a directory", () =>
    Effect.gen(function*() {
      const fs = yield* Memory.make
      yield* fs.makeDirectory("/source/nested", { recursive: true })
      yield* fs.writeFileString("/source/nested/a", "content")
      yield* fs.link("/source/nested/a", "/source/nested/b")
      yield* fs.utimes("/source/nested", 100, 200)
      yield* fs.copy("/source", "/copy", { preserveTimestamps: true })
      assert.deepStrictEqual((yield* fs.stat("/copy/nested/a")).ino, (yield* fs.stat("/copy/nested/b")).ino)
    }))

  it.effect("should preserve directory timestamps when copying with metadata preservation", () =>
    Effect.gen(function*() {
      const fs = yield* Memory.make
      yield* fs.makeDirectory("/source/nested", { recursive: true })
      yield* fs.utimes("/source/nested", 100, 200)
      yield* fs.copy("/source", "/copy", { preserveTimestamps: true })
      assert.strictEqual(Option.getOrThrow((yield* fs.stat("/copy/nested")).mtime).getTime(), 200_000)
    }))

  it.effect("should retain an append handle cursor when its file is truncated", () =>
    Effect.gen(function*() {
      const fs = yield* Memory.make
      yield* fs.writeFileString("/f", "abcd")
      const f = yield* fs.open("/f", { flag: "a+" })
      yield* f.seek(4n, "start")
      yield* f.truncate(1)
      assert.strictEqual(yield* f.seek(0n, "current"), 4n)
    }))

  it.effect("should retain an open cursor when its path is truncated", () =>
    Effect.gen(function*() {
      const fs = yield* Memory.make
      yield* fs.writeFileString("/f", "abcd")
      const g = yield* fs.open("/f", { flag: "r+" })
      yield* g.seek(3n, "start")
      yield* fs.truncate("/f", 0)
      assert.strictEqual(yield* g.seek(0n, "current"), 3n)
    }))

  it.effect("should preserve the cursor when a seek before the start is rejected", () =>
    Effect.gen(function*() {
      const fs = yield* Memory.make
      yield* fs.writeFileString("/f", "abcd")
      const g = yield* fs.open("/f", { flag: "r+" })
      yield* g.seek(3n, "start")
      const error = yield* Effect.flip(g.seek(-1n, "start"))
      assert.strictEqual(error.reason._tag, "BadArgument")
      assert.strictEqual(error.reason.method, "seek")
      assert.strictEqual(yield* g.seek(0n, "current"), 3n)
    }))
})
