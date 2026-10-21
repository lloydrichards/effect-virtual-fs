import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, FileSystem, Option, PlatformError, Stream } from "effect"
import { FileSystemTesting, MemoryFileSystem, TreeTransfer } from "../src/index.js"
import { makeDirectoryEntries } from "../src/internal/directoryEntries.js"
import { makeGlob } from "../src/internal/glob.js"

const encode = new TextEncoder()

const decode = new TextDecoder()

describe("filesystem adapter compatibility", () => {
  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should include hidden entries only when the local glob dot option is enabled", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.make
        yield* fs.writeFileString("/.hidden", "x")
        assert.deepStrictEqual(yield* makeGlob(fs)("*", { dot: true }), [".hidden", "tmp"])
        assert.deepStrictEqual(yield* makeGlob(fs)("*"), ["tmp"])
      }))
    it.effect("should keep positioned reads independent of the sequential cursor", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.make
        yield* fs.writeFileString("/file", "abcdef")
        const file = yield* fs.open("/file")
        const buffer = new Uint8Array(2)
        yield* file.read(buffer)
        assert.strictEqual(decode.decode(buffer), "ab")
        yield* file.read(buffer, { position: 3n })
        assert.strictEqual(decode.decode(buffer), "de")
        const explicit = yield* file.readAlloc(1, { position: 0n })
        assert.strictEqual(decode.decode(Option.getOrThrow(explicit)), "a")
        assert.strictEqual(yield* file.seek(0n, "current"), 2n)
        yield* file.read(buffer)
        assert.strictEqual(decode.decode(buffer), "cd")
        const invalid = yield* Effect.flip(file.read(buffer, { position: -1n }))
        assert.strictEqual(invalid.reason._tag, "BadArgument")
        assert.strictEqual(yield* file.seek(0n, "current"), 4n)
      }))
    it.effect("should report link kinds and reject final links while following parent links", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make()
        const caller = yield* volume.caller()
        const fs = yield* MemoryFileSystem.bind(volume)
        yield* fs.makeDirectory("/directory")
        yield* fs.writeFileString("/directory/file", "original")
        yield* fs.symlink("directory", "/parent")
        yield* fs.symlink("directory/file", "/link")
        yield* fs.symlink("missing", "/dangling")
        assert.strictEqual((yield* fs.stat("/link")).type, "File")
        const entries = yield* makeDirectoryEntries(caller)("/")
        assert.strictEqual(entries.find((e) => e.name === "link")?.type, "SymbolicLink")
        assert.strictEqual(entries.find((e) => e.name === "dangling")?.type, "SymbolicLink")
        assert.strictEqual(entries.find((e) => e.name === "directory")?.type, "Directory")
        yield* Effect.flip(fs.open("/link", { flag: "w", noFollow: true }))
        yield* Effect.flip(fs.open("/dangling", { flag: "w", noFollow: true }))
        assert.strictEqual(yield* fs.readFileString("/directory/file"), "original")
        assert.isFalse(yield* fs.exists("/missing"))
        const handle = yield* fs.open("/parent/file", { noFollow: true })
        assert.strictEqual((yield* handle.stat).type, "File")
      }))
    it.effect("should enforce all requested access permissions for a nonprivileged caller", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.fromFixture({
          entries: [{ kind: "file", path: "/file", bytes: encode.encode("x"), metadata: { mode: 0o444 } }]
        })

        const fs = yield* MemoryFileSystem.bind(volume, { identity: { uid: 1, gid: 1, groups: [], privileged: false } })
        yield* fs.access("/file")
        yield* fs.access("/file", { readable: true })

        for (const options of [{ writable: true }, { readable: true, writable: true }]) {
          const error = yield* Effect.flip(fs.access("/file", options))
          assert.strictEqual(error.reason._tag, "PermissionDenied")
        }

        yield* fs.access("/file", { readable: false, writable: false })
        const missing = yield* Effect.flip(fs.access("/missing"))
        assert.strictEqual(missing.reason._tag, "NotFound")
      }))
    it.effect("should signal readiness after registration and buffer immediate mutations", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.make
        const ready = yield* Deferred.make<void>()
        let called = 0

        const watch = fs.watch("/", {
          onReady: () => {
            called++
            Deferred.doneUnsafe(ready, Effect.void)
          }
        })

        assert.strictEqual(called, 0)
        const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(watch, 1)))
        yield* Deferred.await(ready)
        yield* fs.writeFileString("/new", "x")
        const events = yield* Fiber.join(fiber)
        assert.deepStrictEqual(events, [{ _tag: "Create", path: "/new" }])
        assert.strictEqual(called, 1)

        const error = yield* Effect.flip(Stream.runDrain(fs.watch("/absent", {
          onReady: () => {
            called++
          }
        })))

        assert.strictEqual(error.reason._tag, "NotFound")
        assert.strictEqual(called, 1)
      }))
    it.effect("should preserve distinct large host identities and bigint hard-link counts", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.make
        yield* fs.makeDirectory("/source")

        for (const [name, data] of [["a", "first"], ["b", "second"], ["c", "first"]] as const) {
          yield* fs.writeFileString(`/source/${name}`, data)
        }

        const host = {
          ...fs,
          stat: (path: string) =>
            Effect.map(fs.stat(path), (value) =>
              value.type !== "File" ? value : ({
                ...value,
                dev: 9007199254740993n,
                ino: Option.some(path.endsWith("/b") ? 9007199254740993n : 9007199254740992n),
                nlink: Option.some(9007199254740999n)
              }))
        }

        const entries = yield* Stream.runCollect(TreeTransfer.fromFileSystem(host, "/source"))
        assert.deepStrictEqual(entries.map((entry) => [entry.kind, entry.path]), [["directory", "/"], ["file", "/a"], [
          "file",
          "/b"
        ], ["hardLink", "/c"]])
        const linked = entries.find((entry) => entry.kind === "hardLink")
        assert.strictEqual(linked?.target, "/a")
      }))
    it.effect("should preserve recursive glob results through an empty decorator without following globstar links", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.make
        yield* fs.makeDirectory("/dir/nested", { recursive: true })
        yield* fs.writeFileString("/dir/file", "x")
        yield* fs.writeFileString("/dir/nested/deep", "x")
        yield* fs.symlink("dir", "/alias")
        yield* fs.symlink("missing", "/dangling")

        const { fileSystem } = yield* FileSystemTesting.make(
          fs,
          () => Effect.succeed({ state: undefined, handlers: {} })
        )

        const expected = ["alias", "dangling", "dir", "dir/file", "dir/nested", "dir/nested/deep", "tmp"]

        assert.deepStrictEqual(yield* fs.glob("**"), expected)
        assert.deepStrictEqual(yield* fileSystem.glob("**"), expected)
        assert.deepStrictEqual(yield* fileSystem.glob("alias/*"), ["alias/file", "alias/nested"])
      }))

    for (const kind of ["directory", "symlink"] as const) {
      for (const unknown of [false, true]) {
        it.effect(`should propagate ${unknown ? "Unknown" : "BadArgument"} readLink failures on a ${kind}`, () =>
          Effect.gen(function*() {
            const fs = yield* MemoryFileSystem.make
            yield* fs.makeDirectory("/dir")

            if (kind === "symlink") yield* fs.symlink("/dir", "/alias")

            const fields = {
              module: "FileSystem" as const,
              method: "readLink",
              description: "Injected provider failure"
            }

            const failure = unknown
              ? PlatformError.systemError({ ...fields, _tag: "Unknown" })
              : PlatformError.badArgument(fields)

            const { fileSystem } = yield* FileSystemTesting.make(
              fs,
              () => Effect.succeed({ state: undefined, handlers: { readLink: () => Effect.fail(failure) } })
            )

            assert.strictEqual(yield* Effect.flip(fileSystem.glob("**")), failure)
          }))
      }
    }

    it.effect("should preserve explicit glob handlers and derive traversal from decorated primitives", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.make
        yield* fs.writeFileString("/file", "x")
        const calls: Array<string> = []

        const { fileSystem } = yield* FileSystemTesting.make(fs, () =>
          Effect.succeed({
            state: undefined,
            handlers: {
              glob: () =>
                Effect.sync(() => {
                  calls.push("glob")
                }),
              readDirectory: () =>
                Effect.sync(() => {
                  calls.push("entries")
                }),
              stat: () =>
                Effect.sync(() => {
                  calls.push("stat")
                })
            }
          }))

        assert.deepStrictEqual(yield* fileSystem.glob("*"), ["file", "tmp"])
        assert.strictEqual(calls.filter((c) => c === "glob").length, 1)
        assert.include(calls, "entries")
        yield* fileSystem.glob("file")
        assert.include(calls, "stat")
      }))
  })
})

it.effect("should recognize native non-link errors during fallback glob traversal", () =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped()
    yield* fs.makeDirectory(`${root}/dir`)
    yield* fs.writeFileString(`${root}/dir/file`, "kept")
    yield* fs.symlink(`${root}/dir`, `${root}/alias`)
    assert.deepStrictEqual(yield* makeGlob(fs)("**", { root }), ["alias", "dir", "dir/file"])
  }).pipe(Effect.provide(NodeFileSystem.layer)))
