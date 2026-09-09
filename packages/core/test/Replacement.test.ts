import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"

describe("whole-file symlink replacement", () => {
  it.effect("replaces only the final link at full quota and publishes only its destination", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make({ maxEntries: 2, maxBytes: 8 })
      const fs = yield* volume.caller()
      yield* fs.writeFile("/target", new Uint8Array([42]), { access: "write", create: "exclusive" })
      yield* fs.symlink("/target", "/link")
      const watcher = yield* (yield* volume.watch).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )
      yield* fs.writeFile("/link", new Uint8Array(7), {
        access: "write",
        create: "ifMissing",
        truncate: true,
        replaceFinalSymlink: true
      })
      assert.strictEqual((yield* fs.lstat("/link")).kind, "file")
      assert.deepStrictEqual(yield* fs.readFile("/target"), new Uint8Array([42]))
      const events = yield* Fiber.join(watcher)
      assert.strictEqual(events.length, 1)
      const event = events[0]
      assert.isDefined(event)
      assert.strictEqual(event._tag, "Update")
      assert.deepStrictEqual(yield* Vfs.pathToBytes(event.path), new TextEncoder().encode("/link"))
      assert.deepStrictEqual([...(yield* fs.readDirectory("/"))].sort(), ["link", "target"])
    }))

  it.effect("retains linked target charges and metadata when replacement exceeds quota", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make({ maxBytes: 1 })
      const fs = yield* volume.caller()
      yield* fs.symlink("/", "/a")
      yield* fs.link("/a", "/b")
      const before = yield* fs.lstat("/a")
      const root = yield* fs.stat("/")
      const failure = yield* Effect.flip(fs.writeFile("/a", new Uint8Array([1]), {
        access: "write",
        create: "ifMissing",
        truncate: true,
        replaceFinalSymlink: true
      }))
      assert.strictEqual(failure.code, "NoSpace")
      assert.deepStrictEqual(yield* fs.lstat("/a"), before)
      assert.deepStrictEqual(yield* fs.stat("/"), root)
      assert.strictEqual(yield* fs.readLink("/b"), "/")
      yield* fs.unlink("/b")
      yield* fs.writeFile("/a", new Uint8Array([1]), {
        access: "write",
        create: "ifMissing",
        truncate: true,
        replaceFinalSymlink: true
      })
      assert.deepStrictEqual(yield* fs.readFile("/a"), new Uint8Array([1]))
    }))

  it.effect("requires namespace authority and retains ordinary no-follow behavior", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const root = yield* volume.caller()
      yield* root.mkdir("/sticky", { mode: 0o1777 })
      yield* root.chmod("/sticky", 0o1777)
      yield* root.symlink("missing", "/sticky/link")
      const other = yield* volume.caller({ identity: { uid: 1, gid: 1, groups: [], privileged: false } })
      const options = { access: "write", create: "ifMissing", truncate: true } as const
      assert.strictEqual(
        (yield* Effect.flip(other.writeFile("/sticky/link", new Uint8Array([1]), {
          ...options,
          replaceFinalSymlink: true
        }))).code,
        "AccessDenied"
      )
      assert.strictEqual(
        (yield* Effect.flip(root.writeFile("/sticky/link", new Uint8Array([1]), {
          ...options,
          followFinalSymlink: false
        }))).code,
        "SymlinkLoop"
      )
      assert.strictEqual(yield* root.readLink("/sticky/link"), "missing")
    }))
  it.effect("rejects unauthorized final-mode changes before overwriting bytes", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const root = yield* volume.caller()
      yield* root.writeFile("/file", new Uint8Array([42]), { access: "write", create: "exclusive" })
      yield* root.chmod("/file", 0o666)
      const before = yield* root.stat("/file")
      const other = yield* volume.caller({ identity: { uid: 1, gid: 1, groups: [], privileged: false } })
      assert.strictEqual(
        (yield* Effect.flip(other.writeFile("/file", new Uint8Array([9]), {
          access: "write",
          truncate: true,
          finalMode: 0o600
        }))).code,
        "AccessDenied"
      )
      assert.deepStrictEqual(yield* root.stat("/file"), before)
      assert.deepStrictEqual(yield* root.readFile("/file"), new Uint8Array([42]))
    }))
})
