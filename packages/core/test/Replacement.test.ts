import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect } from "effect"
import { Testing, VirtualFileSystem as Vfs } from "../src/index.js"
import { entryNames, text } from "./support/text.js"

describe("whole-file symlink replacement", () => {
  it.effect(
    "replaces only the final link at full quota and publishes only its destination",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const fs = yield* Vfs.Caller
        yield* fs.writeFile("/target", new Uint8Array([42]), { access: "write", create: "exclusive" })
        yield* fs.symlink("/target", "/link")

        const watcher = yield* Testing.collectChanges(yield* volume.watch(), 1)

        yield* fs.writeFile("/link", new Uint8Array(7), {
          access: "write",
          create: "ifMissing",
          truncate: true,
          replaceFinalSymlink: true
        })
        assert.strictEqual((yield* fs.stat(Vfs.Target.Path({ path: "/link", followFinalSymlink: false }))).kind, "file")
        assert.deepStrictEqual(yield* fs.readFile("/target"), new Uint8Array([42]))
        const events = yield* watcher
        assert.strictEqual(events.length, 1)
        const event = events[0]
        assert.isDefined(event)
        assert.strictEqual(event._tag, "Update")
        assert.deepStrictEqual(yield* Vfs.pathToBytes(event.path), new TextEncoder().encode("/link"))
        assert.deepStrictEqual([...(entryNames(yield* fs.readDirectory("/")))].sort(), ["link", "target"])
      }).pipe(Effect.provide(Testing.layer({ volume: { maxEntries: 2, maxBytes: ByteSize.bytes(8) } })))
  )

  it.effect("retains linked target charges and metadata when replacement exceeds quota", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* fs.symlink("/", "/a")
      yield* fs.link("/a", "/b")
      const before = yield* fs.stat(Vfs.Target.Path({ path: "/a", followFinalSymlink: false }))
      const root = yield* fs.stat("/")

      const failure = yield* Effect.flip(fs.writeFile("/a", new Uint8Array([1]), {
        access: "write",
        create: "ifMissing",
        truncate: true,
        replaceFinalSymlink: true
      }))

      assert.strictEqual(failure.code, "NoSpace")
      assert.deepStrictEqual(yield* fs.stat(Vfs.Target.Path({ path: "/a", followFinalSymlink: false })), before)
      assert.deepStrictEqual(yield* fs.stat("/"), root)
      assert.strictEqual(text(yield* fs.readLink("/b")), "/")
      yield* fs.unlink("/b")
      yield* fs.writeFile("/a", new Uint8Array([1]), {
        access: "write",
        create: "ifMissing",
        truncate: true,
        replaceFinalSymlink: true
      })
      assert.deepStrictEqual(yield* fs.readFile("/a"), new Uint8Array([1]))
    }).pipe(Effect.provide(Testing.layer({ volume: { maxBytes: ByteSize.bytes(1) } }))))

  it.effect("requires namespace authority and retains ordinary no-follow behavior", () =>
    Effect.gen(function*() {
      const root = yield* Vfs.Caller
      yield* root.mkdir("/sticky", { mode: 0o1777 })
      yield* root.chmod("/sticky", 0o1777)
      yield* root.symlink("missing", "/sticky/link")
      const other = yield* Testing.callerAs({ uid: 1, gid: 1, groups: [], privileged: false })
      const options = { access: "write", create: "ifMissing", truncate: true } as const
      assert.strictEqual(
        (yield* Effect.flip(other.writeFile("/sticky/link", new Uint8Array([1]), {
          ...options,
          replaceFinalSymlink: true
        }))).code,
        "NotPermitted"
      )
      assert.strictEqual(
        (yield* Effect.flip(root.writeFile("/sticky/link", new Uint8Array([1]), {
          ...options,
          followFinalSymlink: false
        }))).code,
        "SymlinkLoop"
      )
      assert.strictEqual(text(yield* root.readLink("/sticky/link")), "missing")
    }).pipe(Effect.provide(Testing.layer())))
  it.effect("rejects unauthorized final-mode changes before overwriting bytes", () =>
    Effect.gen(function*() {
      const root = yield* Vfs.Caller
      yield* root.writeFile("/file", new Uint8Array([42]), { access: "write", create: "exclusive" })
      yield* root.chmod("/file", 0o666)
      const before = yield* root.stat("/file")
      const other = yield* Testing.callerAs({ uid: 1, gid: 1, groups: [], privileged: false })
      assert.strictEqual(
        (yield* Effect.flip(other.writeFile("/file", new Uint8Array([9]), {
          access: "write",
          truncate: true,
          finalMode: 0o600
        }))).code,
        "NotPermitted"
      )
      assert.deepStrictEqual(yield* root.stat("/file"), before)
      assert.deepStrictEqual(yield* root.readFile("/file"), new Uint8Array([42]))
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("keeps the entry's position when a file replaces a symbolic link", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* fs.symlink("missing", "/link")
      yield* fs.mkdir("/z")
      yield* fs.writeFile("/link", new Uint8Array([1]), {
        access: "write",
        create: "ifMissing",
        truncate: true,
        replaceFinalSymlink: true,
        followFinalSymlink: false
      })
      assert.deepStrictEqual(entryNames(yield* fs.readDirectory("/")), ["link", "z"])
      assert.strictEqual((yield* fs.stat(Vfs.Target.Path({ path: "/link", followFinalSymlink: false }))).kind, "file")
    }).pipe(Effect.provide(Testing.layer())))
})
