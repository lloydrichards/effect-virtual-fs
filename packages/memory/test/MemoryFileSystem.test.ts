import { Testing, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, describe, it } from "@effect/vitest"
import {
  ByteSize,
  Cause,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PlatformError,
  Result,
  Schema,
  Scope,
  Stream
} from "effect"
import { TestClock } from "effect/testing"
import * as MemoryFileSystem from "../src/MemoryFileSystem.js"
import * as FileSystemTest from "./FileSystemTest.js"

const encoder = new TextEncoder()

const watchEvents = Effect.fnUntraced(function*(
  path: string,
  count: number,
  mutation: Effect.Effect<void, PlatformError.PlatformError>,
  options?: FileSystem.WatchOptions
) {
  const fs = yield* FileSystem.FileSystem

  const events = yield* fs.watch(path, options).pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.forkChild({ startImmediately: true })
  )

  yield* mutation

  return Array.from(yield* Fiber.join(events))
})

// The test layer supplies platform Crypto to each volume it constructs.
const memoryLayer = MemoryFileSystem.layer.pipe(Layer.provideMerge(NodeCrypto.layer))

FileSystemTest.suite("memory", memoryLayer)

it.layer(memoryLayer)("FileSystem (memory-specific)", (it) => {
  describe("POSIX filesystem profile", () => {
    it.effect("should accept the existing root when creating directories recursively", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem

        yield* fs.makeDirectory("/", { recursive: true })

        assert.strictEqual((yield* fs.stat("/")).type, "Directory")
      }))

    it.effect("should resolve normalized paths when they contain dot segments or repeated separators", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory("/paths/child", { recursive: true })
        yield* fs.writeFileString("/paths/parent.txt", "parent")
        yield* fs.writeFileString("/paths/child/./file.txt", "child")

        assert.strictEqual(
          yield* fs.realPath("/paths/child/../parent.txt"),
          "/paths/parent.txt"
        )
        assert.strictEqual(
          yield* fs.realPath("/paths//child//file.txt"),
          "/paths/child/file.txt"
        )
      }))

    it.effect("should operate on a final symbolic link itself when removing or renaming it", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString("/target.txt", "target")
        yield* fs.symlink("target.txt", "/link.txt")

        yield* fs.rename("/link.txt", "/renamed-link.txt")
        assert.strictEqual(yield* fs.readLink("/renamed-link.txt"), "target.txt")
        assert.strictEqual(yield* fs.readFileString("/target.txt"), "target")

        yield* fs.remove("/renamed-link.txt")
        assert.strictEqual(yield* fs.readFileString("/target.txt"), "target")
      }))

    it.effect("should reject exclusive creation when a dangling symbolic link exists", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        yield* fs.symlink("missing.txt", "/dangling-link.txt")

        const result = yield* Effect.result(fs.writeFileString("/dangling-link.txt", "content", { flag: "wx" }))

        assert.isTrue(Result.isFailure(result))
        assert.strictEqual(yield* fs.readLink("/dangling-link.txt"), "missing.txt")
        assert.isFalse(yield* fs.exists("/missing.txt"))
      }))

    it.effect("should leave both names unchanged when renaming one hard link over another", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString("/source.txt", "content")
        yield* fs.link("/source.txt", "/destination.txt")

        yield* fs.rename("/source.txt", "/destination.txt")

        assert.strictEqual(yield* fs.readFileString("/source.txt"), "content")
        assert.strictEqual(yield* fs.readFileString("/destination.txt"), "content")
      }))
  })

  it.effect("should isolate virtual volumes when each layer is fresh", () =>
    Effect.gen(function*() {
      const writeInFirstVolume = Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString("/shared.txt", "shared")
        assert.strictEqual(yield* fs.readFileString("/shared.txt"), "shared")
      }).pipe(Effect.provide(Layer.fresh(memoryLayer)))

      yield* writeInFirstVolume

      const existsInFreshVolume = yield* Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem

        return yield* fs.exists("/shared.txt")
      }).pipe(Effect.provide(Layer.fresh(memoryLayer)))

      assert.isFalse(existsInFreshVolume)
    }))

  it.effect("should preserve both writes when separate handles append concurrently", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const appendPath = "/concurrent-append.txt"
      yield* fs.writeFileString(appendPath, "")
      const first = yield* fs.open(appendPath, { flag: "a" })
      const second = yield* fs.open(appendPath, { flag: "a" })

      yield* Effect.all([
        first.writeAll(encoder.encode("A")),
        second.writeAll(encoder.encode("B"))
      ], { concurrency: "unbounded", discard: true })

      const contents = yield* fs.readFileString(appendPath)
      assert.isTrue(contents === "AB" || contents === "BA")
    }))

  it.effect("should allow one writer when exclusive creates race", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const createPath = "/exclusive-create.txt"

      const creates = yield* Effect.all([
        fs.writeFileString(createPath, "first", { flag: "wx" }).pipe(Effect.result),
        fs.writeFileString(createPath, "second", { flag: "wx" }).pipe(Effect.result)
      ], { concurrency: "unbounded" })

      assert.strictEqual(creates.filter(Result.isSuccess).length, 1)
      assert.strictEqual(creates.filter(Result.isFailure).length, 1)
      assert.include(["first", "second"], yield* fs.readFileString(createPath))
    }))

  it.effect("should leave bytes unchanged when file-size mutations are invalid", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = "/invalid-size.txt"
      yield* fs.writeFileString(path, "content")
      const file = yield* fs.open(path, { flag: "r+" })

      yield* file.seek(BigInt(Number.MAX_SAFE_INTEGER), "start")
      assert.isTrue(Result.isFailure(yield* Effect.result(file.writeAll(new Uint8Array([1])))))

      for (const size of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        const result = yield* Effect.result(file.truncate(size))
        assert.isTrue(Result.isFailure(result))

        if (Result.isFailure(result)) {
          assert.strictEqual(result.failure.reason._tag, "BadArgument")
          assert.strictEqual(result.failure.reason.method, "truncate")
        }
      }

      assert.strictEqual(yield* fs.readFileString(path), "content")
    }))

  it.effect("should retain POSIX metadata when no virtual user identity is enforced", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* TestClock.setTime(1_000)
      yield* fs.writeFileString("/metadata.txt", "content")
      yield* fs.chmod("/metadata.txt", 0o000)
      yield* fs.chown("/metadata.txt", 42, 84)
      yield* fs.utimes("/metadata.txt", 1, 2)

      const info = yield* fs.stat("/metadata.txt")
      assert.strictEqual(info.mode & 0o7777, 0o000)
      assert.strictEqual(Option.getOrThrow(info.uid), 42)
      assert.strictEqual(Option.getOrThrow(info.gid), 84)
      assert.strictEqual(Option.getOrThrow(info.atime).getTime(), 1_000)
      assert.strictEqual(Option.getOrThrow(info.mtime).getTime(), 2_000)

      yield* fs.access("/metadata.txt", { readable: true, writable: true })
    }))

  it.effect("should report a typed st_mode with zero dev and rdev when stat describes a memory file", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory("/typed")
      yield* fs.writeFileString("/typed/file", "content")
      yield* fs.chmod("/typed", 0o750)
      // A stat-style mode is accepted: its type bits are ignored, as Node does.
      yield* fs.chmod("/typed/file", 0o100640)

      const directory = yield* fs.stat("/typed")
      const file = yield* fs.stat("/typed/file")

      assert.strictEqual(directory.mode, 0o40750)
      assert.strictEqual(file.mode, 0o100640)

      for (const info of [directory, file]) {
        assert.strictEqual(info.dev, 0)
        assert.deepStrictEqual(info.rdev, Option.some(0))
      }
    }))

  it.effect("should skip directory symbolic links when globbing recursively", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory("/glob/real", { recursive: true })
      yield* fs.writeFileString("/glob/real/file.ts", "content")
      yield* fs.symlink("real", "/glob/linked")

      assert.deepStrictEqual(
        yield* fs.glob("**/*.ts", { root: "/glob" }),
        ["real/file.ts"]
      )
    }))

  for (const recursive of [undefined, false, true]) {
    it.effect(`should watch ${recursive === true ? "nested changes" : "only direct children"} when recursive is ${recursive}`, () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const root = `/watch-recursive-${recursive}`
        yield* fs.makeDirectory(`${root}/child`, { recursive: true })

        const events = yield* watchEvents(
          root,
          recursive === true ? 2 : 1,
          Effect.gen(function*() {
            yield* fs.writeFileString(`${root}/child/nested.txt`, "nested")
            yield* fs.writeFileString(`${root}/direct.txt`, "direct")
          }),
          recursive === undefined ? undefined : { recursive }
        )

        assert.deepStrictEqual(
          events,
          recursive === true
            ? [
              { _tag: "Create", path: `${root}/child/nested.txt` },
              { _tag: "Create", path: `${root}/direct.txt` }
            ]
            : [{ _tag: "Create", path: `${root}/direct.txt` }]
        )
      }))
  }

  it.effect(
    "should complete filesystem operations when directory depth exceeds the call stack",
    () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.make
        yield* fs.writeFileString("/file.txt", "before")
        const file = yield* fs.open("/file.txt", { flag: "r+" })
        // This depth exercises traversal beyond the JavaScript call stack through public operations.
        yield* fs.makeDirectory("/d".repeat(6_000), { recursive: true })

        const written = yield* Effect.exit(file.writeAll(encoder.encode("AFTER!")))

        const withoutWatchers = {
          succeeded: Exit.isSuccess(written),
          contents: yield* fs.readFileString("/file.txt"),
          position: yield* file.seek(0n, "current")
        }

        const watcher = yield* fs.watch("/file.txt").pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true })
        )

        yield* file.seek(0n, "start")
        const watchedWrite = yield* Effect.exit(file.writeAll(encoder.encode("second")))

        const withWatcher = {
          succeeded: Exit.isSuccess(watchedWrite),
          contents: yield* fs.readFileString("/file.txt"),
          position: yield* file.seek(0n, "current")
        }

        assert.deepStrictEqual({ withoutWatchers, withWatcher }, {
          withoutWatchers: { succeeded: true, contents: "AFTER!", position: 6n },
          withWatcher: { succeeded: true, contents: "second", position: 6n }
        })
        const events = yield* Fiber.join(watcher)
        assert.deepStrictEqual(events, [{ _tag: "Update", path: "/file.txt" }])

        const listed = yield* Effect.exit(fs.readDirectory("/d", { recursive: true }))
        const copied = yield* Effect.exit(fs.copy("/d", "/copy"))
        const moved = yield* Effect.exit(fs.rename("/d", "/moved"))

        assert.deepStrictEqual({
          listing: Exit.isFailure(listed) ? Cause.pretty(listed.cause) : undefined,
          copy: Exit.isFailure(copied) ? Cause.pretty(copied.cause) : undefined,
          rename: Exit.isFailure(moved) ? Cause.pretty(moved.cause) : undefined
        }, { listing: undefined, copy: undefined, rename: undefined })

        if (Exit.isSuccess(listed)) {
          assert.strictEqual(listed.value.length, 5_999)
          assert.strictEqual(listed.value[5_998], Array(5_999).fill("d").join("/"))
        }

        assert.isFalse(yield* fs.exists("/d"))
        assert.strictEqual((yield* fs.stat(`/copy${"/d".repeat(5_999)}`)).type, "Directory")
        assert.strictEqual((yield* fs.stat(`/moved${"/d".repeat(5_999)}`)).type, "Directory")
      }),
    120_000
  )

  for (const suffix of [".", ".."]) {
    it.effect(`should publish directory creation when recursive mkdir ends in ${suffix}`, () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.make

        const events = yield* watchEvents(
          "/",
          1,
          Effect.gen(function*() {
            yield* fs.makeDirectory(`/new/${suffix}`, { recursive: true })
            yield* fs.writeFileString("/sentinel", "done")
          })
        ).pipe(Effect.provideService(FileSystem.FileSystem, fs))

        assert.isTrue(yield* fs.exists("/new"))
        assert.deepStrictEqual(events, [{ _tag: "Create", path: "/new" }])
      }))
  }

  it.effect("should publish normalized events in commit order when memory paths mutate", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory("/watch-events")

      const events = yield* watchEvents(
        "/watch-events",
        6,
        Effect.gen(function*() {
          yield* fs.writeFileString("/watch-events/file.txt", "content")
          yield* fs.writeFileString("/watch-events/file.txt", "updated")
          yield* fs.remove("/watch-events/file.txt")
          yield* fs.writeFileString("/watch-events/old.txt", "content")
          yield* fs.rename("/watch-events/old.txt", "/watch-events/new.txt")
        })
      )

      assert.deepStrictEqual(events, [
        { _tag: "Create", path: "/watch-events/file.txt" },
        { _tag: "Update", path: "/watch-events/file.txt" },
        { _tag: "Remove", path: "/watch-events/file.txt" },
        { _tag: "Create", path: "/watch-events/old.txt" },
        { _tag: "Remove", path: "/watch-events/old.txt" },
        { _tag: "Create", path: "/watch-events/new.txt" }
      ])
    }))

  it.effect("should publish an update through an alias when its hard-linked file changes", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString("/original.txt", "content")
      yield* fs.link("/original.txt", "/alias.txt")

      const events = yield* watchEvents(
        "/alias.txt",
        1,
        fs.writeFileString("/original.txt", "updated")
      )

      assert.deepStrictEqual(events, [{ _tag: "Update", path: "/alias.txt" }])
    }))
})

describe("memory adapter compatibility", () => {
  for (const root of ["/", "//", ".", "/directory/..", "/alias/../"]) {
    it.layer(NodeCrypto.layer)((it) => {
      it.effect(`should reject recursive removal without changing the tree when the target is ${root}`, () =>
        Effect.gen(function*() {
          const fs = yield* MemoryFileSystem.make
          yield* fs.makeDirectory("/directory")
          yield* fs.symlink("/directory", "/alias")
          yield* fs.writeFileString("/directory/sentinel", "keep")
          const before = yield* fs.readDirectory("/", { recursive: true })
          const error = yield* Effect.flip(fs.remove(root, { recursive: true }))
          assert.deepStrictEqual(yield* fs.readDirectory("/", { recursive: true }), before)
          assert.strictEqual(error.reason._tag, "BadResource")
          assert.strictEqual(yield* fs.readFileString("/directory/sentinel"), "keep")
        }))
    })
  }

  for (const nested of [false, true]) {
    it.layer(NodeCrypto.layer)((it) => {
      it.effect(`should replace a destination symlink without changing its target when copying a ${nested ? "directory" : "file"}`, () =>
        Effect.gen(function*() {
          const fs = yield* MemoryFileSystem.make
          yield* fs.makeDirectory("/source")
          yield* fs.makeDirectory("/destination")
          yield* fs.writeFileString("/source/file", "copied")
          yield* fs.writeFileString("/external", "untouched")
          yield* fs.symlink("/external", "/destination/file")

          if (nested) yield* fs.copy("/source", "/destination", { overwrite: true })
          else yield* fs.copy("/source/file", "/destination/file", { overwrite: true })
          assert.strictEqual(yield* fs.readFileString("/external"), "untouched")
          assert.strictEqual(yield* fs.readFileString("/destination/file"), "copied")
          yield* Effect.flip(fs.readLink("/destination/file"))
        }))
    })
  }

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should preserve a destination directory symlink when copying a tree over it", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.make
        yield* fs.makeDirectory("/source/child", { recursive: true })
        yield* fs.makeDirectory("/destination")
        yield* fs.makeDirectory("/outside")
        yield* fs.writeFileString("/source/child/file", "copied")
        yield* fs.symlink("/outside", "/destination/child")

        const error = yield* Effect.flip(fs.copy("/source", "/destination", { overwrite: true }))

        assert.strictEqual(error.reason._tag, "BadResource")
        assert.strictEqual(yield* fs.readLink("/destination/child"), "/outside")
        assert.deepStrictEqual(yield* fs.readDirectory("/outside"), [])
      }))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should leave the destination absent when copying root into its descendant is rejected", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.make
        yield* fs.makeDirectory("/parent")
        yield* fs.writeFileString("/parent/file", "keep")

        const error = yield* Effect.flip(fs.copy("/", "/parent/copy"))

        assert.strictEqual(error.reason._tag, "BadArgument")
        assert.deepStrictEqual(yield* fs.readDirectory("/parent"), ["file"])
        assert.strictEqual(yield* fs.readFileString("/parent/file"), "keep")
      }))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should preserve a destination symlink and its target when replacement exceeds capacity", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.bind(yield* Vfs.Volume)
        yield* fs.writeFileString("/source", "x".repeat(32))
        yield* fs.writeFileString("/external", "safe")
        yield* fs.symlink("/external", "/destination")

        const watched = yield* Testing.collectChanges(fs.watch("/"), 1)

        const error = yield* Effect.flip(fs.copy("/source", "/destination", { overwrite: true }))
        assert.strictEqual(error.reason._tag, "Unknown")
        assert.strictEqual(yield* fs.readLink("/destination"), "/external")
        assert.strictEqual(yield* fs.readFileString("/external"), "safe")
        assert.deepStrictEqual(yield* fs.readDirectory("/"), ["destination", "external", "source"])
        yield* fs.makeDirectory("/sentinel")
        assert.deepStrictEqual(yield* watched, [{ _tag: "Create", path: "/sentinel" }])
      }).pipe(Effect.provide(Testing.layer({ volume: { maxBytes: ByteSize.bytes(45) } }))))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should replace a symlink within capacity when its storage can be reused", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.bind(yield* Vfs.Volume)
        yield* fs.writeFileString("/source", "copied")
        yield* fs.writeFileString("/external", "safe")
        yield* fs.symlink("/external", "/destination")

        const watched = yield* Testing.collectChanges(fs.watch("/"), 1)

        yield* fs.copy("/source", "/destination", { overwrite: true })
        assert.strictEqual(yield* fs.readFileString("/destination"), "copied")
        assert.strictEqual(yield* fs.readFileString("/external"), "safe")
        const events = yield* watched
        assert.strictEqual(events.length, 1)
        assert.strictEqual(events[0]?.path, "/destination")
        assert.deepStrictEqual(yield* fs.readDirectory("/"), ["destination", "external", "source"])
      }).pipe(Effect.provide(Testing.layer({ volume: { maxBytes: ByteSize.bytes(19), maxEntries: 3 } }))))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should copy source mode and contents to existing destination aliases when copying a file", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.make
        yield* fs.writeFileString("/source", "copied", { mode: 0o600 })
        yield* fs.writeFileString("/destination", "old", { mode: 0o777 })
        yield* fs.link("/destination", "/alias")
        const handle = yield* fs.open("/destination")
        const before = yield* fs.stat("/destination")

        const watched = yield* Testing.collectChanges(fs.watch("/"), 3)

        yield* fs.copyFile("/source", "/destination")
        const after = yield* fs.stat("/destination")
        assert.strictEqual(after.mode & 0o7777, 0o600)
        assert.deepStrictEqual(after.ino, before.ino)
        assert.strictEqual((yield* fs.stat("/alias")).mode & 0o7777, 0o600)
        assert.strictEqual(new TextDecoder().decode(Option.getOrThrow(yield* handle.readAlloc(6))), "copied")
        yield* fs.makeDirectory("/sentinel")
        assert.deepStrictEqual(yield* watched, [
          { _tag: "Update", path: "/destination" },
          { _tag: "Update", path: "/alias" },
          { _tag: "Create", path: "/sentinel" }
        ])
      }))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should preserve destination bytes and metadata when copying mode is denied", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const owner = yield* MemoryFileSystem.bind(volume)

        const guest = yield* MemoryFileSystem.bind(volume, {
          identity: { uid: 1, gid: 1, groups: [], privileged: false }
        })

        yield* owner.writeFileString("/source", "copied", { mode: 0o644 })
        yield* owner.writeFileString("/destination", "keep", { mode: 0o666 })
        const before = yield* owner.stat("/destination")

        const watched = yield* Testing.collectChanges(owner.watch("/"), 1)

        const error = yield* Effect.flip(guest.copyFile("/source", "/destination"))
        assert.strictEqual(error.reason._tag, "PermissionDenied")
        assert.deepStrictEqual(yield* owner.stat("/destination"), before)
        assert.strictEqual(yield* owner.readFileString("/destination"), "keep")
        yield* owner.makeDirectory("/sentinel")
        assert.deepStrictEqual(yield* watched, [{ _tag: "Create", path: "/sentinel" }])
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should leave a file unchanged when copied to itself or a hard-link alias", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.make
        yield* fs.writeFileString("/source", "unchanged", { mode: 0o600 })
        yield* fs.link("/source", "/alias")
        const before = yield* fs.stat("/source")

        const watched = yield* Testing.collectChanges(fs.watch("/"), 1)

        yield* fs.copyFile("/source", "/source")
        yield* fs.copyFile("/source", "/alias")
        assert.deepStrictEqual(yield* fs.stat("/source"), before)
        yield* fs.makeDirectory("/sentinel")
        assert.deepStrictEqual(yield* watched, [{ _tag: "Create", path: "/sentinel" }])
      }))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should keep special mode bits when copying a directory tree", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.make
        yield* fs.makeDirectory("/source")
        yield* fs.writeFileString("/source/tool", "run")
        yield* fs.chmod("/source/tool", 0o4755)

        yield* fs.copy("/source", "/copy")

        assert.strictEqual((yield* fs.stat("/copy/tool")).mode & 0o7777, 0o4755)
      }))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should report out of space when a copy exceeds volume capacity", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.bind(yield* Vfs.Volume)
        yield* fs.makeDirectory("/source")
        yield* fs.writeFileString("/source/a", "0123456789")

        const error = yield* Effect.flip(fs.copy("/source", "/copy"))

        assert.deepStrictEqual([error.reason._tag, error.reason.description], ["Unknown", "NoSpace"])
        assert.isFalse(yield* fs.exists("/copy"))
      }).pipe(Effect.provide(Testing.layer({ volume: { maxBytes: ByteSize.bytes(16) } }))))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should reject copying a file when the destination is its hard link", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.make
        yield* fs.writeFileString("/source", "keep")
        yield* fs.link("/source", "/alias")

        const error = yield* Effect.flip(fs.copy("/source", "/alias", { overwrite: true }))

        assert.strictEqual(error.reason._tag, "BadArgument")
        assert.strictEqual(yield* fs.readFileString("/alias"), "keep")
      }))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should create no directory when a recursive makeDirectory fails partway", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.bind(yield* Vfs.Volume)

        // The third directory is past the volume's entry limit, so the first two are not created either.
        const error = yield* Effect.flip(fs.makeDirectory("/a/b/c", { recursive: true }))

        assert.deepStrictEqual([error.reason._tag, error.reason.description], ["Unknown", "NoSpace"])
        assert.isFalse(yield* fs.exists("/a"))
      }).pipe(Effect.provide(Testing.layer({ volume: { maxEntries: 2 } }))))
  })

  // As Node does, a recursive listing reads a directory it may read but not search and fails below it.
  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should fail a recursive listing when the caller cannot search a directory", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const owner = yield* MemoryFileSystem.bind(volume)
        yield* owner.makeDirectory("/listed/inner", { recursive: true })
        yield* owner.writeFileString("/listed/inner/file", "x")
        yield* owner.chmod("/listed", 0o444)

        const guest = yield* MemoryFileSystem.bind(volume, {
          identity: { uid: 1, gid: 1, groups: [], privileged: false }
        })

        assert.deepStrictEqual(yield* guest.readDirectory("/listed"), ["inner"])
        const error = yield* Effect.flip(guest.readDirectory("/listed", { recursive: true }))
        assert.strictEqual(error.reason._tag, "PermissionDenied")
      }).pipe(Effect.provide(Testing.layer())))
  })
})

// A caller-supplied service stands in for a platform implementation such as
// `NodeCrypto` or `BunCrypto`.
const suppliedCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size).fill(7),
    digest: (_algorithm, data) => Effect.succeed(data)
  })
)

it.layer(NodeCrypto.layer)((it) => {
  it.effect("should mint a usable filesystem when crypto is absent or supplied", () =>
    Effect.gen(function*() {
      const withoutCrypto = yield* MemoryFileSystem.make

      yield* withoutCrypto.writeFileString("/tmp/greeting.txt", "hello")
      assert.strictEqual(yield* withoutCrypto.readFileString("/tmp/greeting.txt"), "hello")

      const withCrypto = yield* Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString("/tmp/greeting.txt", "hello")

        return yield* fs.readFileString("/tmp/greeting.txt")
      }).pipe(Effect.provide(MemoryFileSystem.layer.pipe(Layer.provide(suppliedCrypto))))

      assert.strictEqual(withCrypto, "hello")
    }))
})

it.layer(NodeCrypto.layer)((it) => {
  it.effect("should give each core volume a distinct identity and incarnation when no crypto service is provided", () =>
    Effect.gen(function*() {
      const first = yield* Vfs.make()
      const second = yield* Vfs.make()

      assert.notStrictEqual(first.identity, second.identity)
      assert.notStrictEqual(first.incarnation, second.incarnation)
      assert.notStrictEqual(String(first.identity), String(first.incarnation))
    }))
})

it.layer(NodeCrypto.layer)((it) => {
  it.effect("should draw identities from a supplied crypto service when one is in context", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()

      assert.strictEqual(volume.identity, "07".repeat(16))
      assert.strictEqual(volume.incarnation, "07".repeat(16))
    }).pipe(Effect.provide(suppliedCrypto)))
})

const GUEST = { uid: 1, gid: 1, groups: [], privileged: false } as const

// A guest bound to a volume with a guest-owned /work, so permission checks apply as they do to an unprivileged
// Node process. Each expectation matches what Node does on a real filesystem.
const guest = Effect.gen(function*() {
  const volume = yield* Vfs.Volume
  const owner = yield* MemoryFileSystem.bind(volume)
  yield* owner.makeDirectory("/work")
  yield* owner.chown("/work", GUEST.uid, GUEST.gid)

  return yield* MemoryFileSystem.bind(volume, { identity: GUEST })
}).pipe(Effect.provide(Testing.layer()))

describe("permission parity with Node", () => {
  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should create a recursive directory when its mode lacks owner search", () =>
      Effect.gen(function*() {
        const fs = yield* guest
        const outcome = yield* Effect.result(fs.makeDirectory("/work/sealed", { recursive: true, mode: 0o600 }))

        assert.isTrue(Result.isSuccess(outcome))
        assert.isTrue(yield* fs.exists("/work/sealed"))
      }))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should refuse recursive directory creation when a file already exists", () =>
      Effect.gen(function*() {
        const fs = yield* guest
        yield* fs.writeFileString("/work/file", "x")
        const error = yield* Effect.flip(fs.makeDirectory("/work/file", { recursive: true }))

        assert.strictEqual(error.reason._tag, "AlreadyExists")
      }))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should remove a tree when a sealed child directory is empty", () =>
      Effect.gen(function*() {
        const fs = yield* guest
        yield* fs.makeDirectory("/work/tree/sealed", { recursive: true })
        yield* fs.writeFileString("/work/tree/file", "x")
        yield* fs.chmod("/work/tree/sealed", 0o000)
        yield* fs.remove("/work/tree", { recursive: true })

        assert.isFalse(yield* fs.exists("/work/tree"))
      }))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should refuse to remove a tree when a sealed child contains entries", () =>
      Effect.gen(function*() {
        const fs = yield* guest
        yield* fs.makeDirectory("/work/tree/sealed", { recursive: true })
        yield* fs.writeFileString("/work/tree/sealed/file", "x")
        yield* fs.chmod("/work/tree/sealed", 0o000)
        const error = yield* Effect.flip(fs.remove("/work/tree", { recursive: true }))

        assert.strictEqual(error.reason._tag, "PermissionDenied")
      }))
  })
})

describe("adapter glob compatibility", () => {
  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should match UTF-16 units and require explicit dots in hidden names", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.make
        yield* fs.makeDirectory("/glob/.hidden", { recursive: true })

        for (const name of ["a.ts", "😀.ts", ".dot.ts", ".hidden/child.ts"]) {
          yield* fs.writeFileString(`/glob/${name}`, "x")
        }

        assert.deepStrictEqual(yield* fs.glob("?.ts", { root: "/glob" }), ["a.ts"])
        assert.deepStrictEqual(yield* fs.glob("??.ts", { root: "/glob" }), ["😀.ts"])
        assert.deepStrictEqual(yield* fs.glob("**/*.ts", { root: "/glob" }), ["a.ts", "😀.ts"])
        assert.deepStrictEqual(yield* fs.glob(".*.ts", { root: "/glob" }), [".dot.ts"])
        assert.deepStrictEqual(yield* fs.glob(".hidden/*.ts", { root: "/glob" }), [".hidden/child.ts"])
      }))

    it.effect("should return sorted relative strings and the root dot while excluding directory descendants", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.bind(
          yield* Vfs.fromFixture({
            entries: [
              { kind: "file", path: "/z", bytes: encoder.encode("z") },
              { kind: "directory", path: "/a" },
              { kind: "file", path: "/a/child", bytes: encoder.encode("a") },
              { kind: "symlink", path: "/link", target: "a" }
            ]
          })
        )

        assert.deepStrictEqual(yield* fs.glob("**"), [".", "a", "a/child", "link", "z"])
        assert.deepStrictEqual(yield* fs.glob("**/"), [".", "a"])
        assert.deepStrictEqual(yield* fs.glob("**", { exclude: ["a/"] }), [".", "link", "z"])
        assert.deepStrictEqual(yield* fs.glob("**", { exclude: ["**/"] }), [])
        assert.deepStrictEqual(yield* fs.glob("**", { root: "/link" }), [".", "child"])
        assert.deepStrictEqual(yield* fs.readDirectory("/", { recursive: true }), ["a", "a/child", "link", "z"])
      }))

    it.effect("should reject malformed include and exclude patterns before resolving the root", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.make

        for (const pattern of ["", "/absolute", "a//b", "../a", "[", "a\\"]) {
          for (
            const operation of [
              fs.glob(pattern, { root: "/missing" }),
              fs.glob("**", { root: "/missing", exclude: [pattern] })
            ]
          ) {
            const error = yield* Effect.flip(operation)
            assert.strictEqual(error.reason._tag, "BadArgument")
            assert.strictEqual(error.reason.method, "glob")
          }
        }
      }))

    it.effect("should retain glob method and root context for missing and non-directory roots", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.make
        yield* fs.writeFileString("/file", "x")

        for (
          const [root, tag, description] of [
            ["/missing", "NotFound", "NotFound"],
            ["/file", "BadResource", "NotDirectory"]
          ]
        ) {
          const reason = systemReason(yield* Effect.flip(fs.glob("**", { root })))
          assert.deepStrictEqual([reason._tag, reason.method, reason.pathOrDescriptor, reason.description], [
            tag,
            "glob",
            root,
            description
          ])
        }
      }))

    it.effect("should fail strict filename decoding even when the subtree or root is excluded", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.fromFixture({ entries: [{ kind: "directory", path: "/excluded" }] })
        const caller = yield* volume.caller()
        yield* caller.writeFile(
          yield* Vfs.pathFromBytes(new Uint8Array([...encoder.encode("/excluded/"), 255])),
          encoder.encode("x"),
          { access: "write", create: "exclusive" }
        )
        const fs = yield* MemoryFileSystem.bind(volume)

        for (const exclude of [["excluded/"], ["**/"]]) {
          const reason = systemReason(yield* Effect.flip(fs.glob("**", { exclude })))
          assert.deepStrictEqual([reason._tag, reason.method, reason.pathOrDescriptor, reason.description], [
            "InvalidData",
            "glob",
            "/",
            "UnrepresentableName"
          ])
          assert.strictEqual(Schema.is(Vfs.VfsError)(reason.cause) && reason.cause.operation, "readDirectory")
        }

        const reason = systemReason(yield* Effect.flip(fs.readDirectory("/", { recursive: true })))
        assert.strictEqual(reason.description, "UnrepresentableName")
      }))

    it.effect("should fail traversal of an excluded unreadable subtree", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.fromFixture({
          entries: [
            { kind: "directory", path: "/excluded", metadata: { mode: 0o000 } },
            { kind: "file", path: "/excluded/child", bytes: encoder.encode("x") }
          ]
        })

        const fs = yield* MemoryFileSystem.bind(volume, {
          identity: { uid: 1, gid: 1, groups: [], privileged: false }
        })

        for (const exclude of [["excluded/"], ["**/"]]) {
          const reason = systemReason(yield* Effect.flip(fs.glob("**", { exclude })))
          assert.deepStrictEqual([reason._tag, reason.method, reason.pathOrDescriptor, reason.description], [
            "PermissionDenied",
            "glob",
            "/",
            "AccessDenied"
          ])
        }
      }))
  })
})

const MAXIMUM_MS = 8_640_000_000_000_000
const MAXIMUM_NS = BigInt(MAXIMUM_MS) * 1_000_000n

const overflowingFixture = (field: "atimeNs" | "mtimeNs" | "birthtimeNs", timestamp: bigint): Vfs.Fixture => ({
  entries: [{ kind: "file", path: "/file", bytes: new Uint8Array([42]), metadata: { [field]: timestamp } }]
})

const BOUNDARY_FIXTURE: Vfs.Fixture = {
  entries: [{
    kind: "file",
    path: "/file",
    bytes: new Uint8Array(),
    metadata: { atimeNs: -MAXIMUM_NS, mtimeNs: MAXIMUM_NS, birthtimeNs: -1_999_999n, ctimeNs: 10n ** 100n }
  }]
}

describe("adapter timestamp conversion", () => {
  for (const field of ["atimeNs", "mtimeNs", "birthtimeNs"] as const) {
    for (const sign of [-1n, 1n]) {
      it.layer(NodeCrypto.layer)((it) => {
        it.effect(`should fail stat with InvalidData when ${field} exceeds the Date range with sign ${sign}`, () =>
          Effect.gen(function*() {
            const caller = yield* Vfs.Caller
            const before = yield* caller.stat("/file")
            const fs = yield* MemoryFileSystem.bind(yield* Vfs.Volume)
            const file = yield* fs.open("/file")
            const pathError = yield* Effect.flip(fs.stat("/file"))
            const handleError = yield* Effect.flip(file.stat)

            for (const error of [pathError, handleError]) {
              assert.strictEqual(error.reason._tag, "InvalidData")
              assert.strictEqual(error.reason.method, "stat")
              assert.include(error.reason.description ?? "", field)
            }

            assert.instanceOf(pathError.reason, PlatformError.SystemError)
            assert.instanceOf(handleError.reason, PlatformError.SystemError)
            assert.strictEqual(pathError.reason.pathOrDescriptor, "/file")
            assert.isNumber(handleError.reason.pathOrDescriptor)
            assert.deepStrictEqual(yield* caller.stat("/file"), before)
          }).pipe(Effect.provide(Testing.layer({ fixture: overflowingFixture(field, sign * 10n ** 100n) }))))
      })
    }
  }

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should return independent valid dates when timestamps reach Date boundaries", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.bind(yield* Vfs.Volume)
        const file = yield* fs.open("/file")

        for (const info of [yield* fs.stat("/file"), yield* file.stat]) {
          assert.strictEqual(Option.getOrThrow(info.atime).getTime(), -MAXIMUM_MS)
          assert.strictEqual(Option.getOrThrow(info.mtime).getTime(), MAXIMUM_MS)
          assert.strictEqual(Option.getOrThrow(info.birthtime).getTime(), -1)
          Option.getOrThrow(info.atime).setTime(0)
        }

        assert.strictEqual(Option.getOrThrow((yield* fs.stat("/file")).atime).getTime(), -MAXIMUM_MS)
      }).pipe(Effect.provide(Testing.layer({ fixture: BOUNDARY_FIXTURE }))))
  })
})

const systemReason = (error: PlatformError.PlatformError): PlatformError.SystemError =>
  error.reason instanceof PlatformError.SystemError ? error.reason : assert.fail("Expected a system error")

const bytes = new TextEncoder()

describe("core-backed memory bindings", () => {
  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should share file contents and keep cursors independent when bindings use one volume", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const core = yield* Vfs.Caller
        const a = yield* MemoryFileSystem.bind(volume)
        const b = yield* MemoryFileSystem.bind(volume)
        yield* core.writeFile("/f", bytes.encode("abc"), { access: "write", create: "exclusive" })
        const af = yield* a.open("/f")
        const bf = yield* b.open("/f")
        const read = yield* af.readAlloc(1)
        assert.isTrue(Option.isSome(read))
        assert.strictEqual(yield* bf.seek(0n, "current"), 0n)
        yield* b.writeFileString("/f", "xyz")
        assert.strictEqual(new TextDecoder().decode(Option.getOrThrow(yield* bf.readAlloc(3))), "xyz")
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should leave the volume namespace unchanged when binding an adapter", () =>
      Effect.gen(function*() {
        const adapter = yield* MemoryFileSystem.bind(yield* Vfs.Volume)
        assert.isFalse(yield* adapter.exists("/tmp"))
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should close only the handle owned by a binding when its scope closes", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const a = yield* MemoryFileSystem.bind(volume)
        const b = yield* MemoryFileSystem.bind(volume)
        yield* b.writeFileString("/f", "xyz")
        const scope = yield* Scope.make()
        const closed = yield* a.open("/f").pipe(Scope.provide(scope))
        yield* Scope.close(scope, Exit.void)
        yield* Effect.flip(closed.readAlloc(1))
        assert.strictEqual(yield* closed.seek(10n, "start"), 0n)
        assert.strictEqual(yield* b.readFileString("/f"), "xyz")
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should deliver direct core and alias writes in commit order when an adapter watches", () =>
      Effect.gen(function*() {
        const core = yield* Vfs.Caller
        const adapter = yield* MemoryFileSystem.bind(yield* Vfs.Volume)
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
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should recover subtree changes when a watch overflows during rescan", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const core = yield* Vfs.Caller
        yield* core.mkdir("/sub")
        const adapter = yield* MemoryFileSystem.bind(volume)
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
        assert.isTrue(MemoryFileSystem.isWatchOverflow(error))

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
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should preserve the old file and publish no update when a whole-file write exceeds quota", () =>
      Effect.gen(function*() {
        const core = yield* Vfs.Caller
        const adapter = yield* MemoryFileSystem.bind(yield* Vfs.Volume)
        yield* adapter.writeFileString("/f", "old")
        const before = yield* core.stat("/f")
        const changes = yield* Testing.collectChanges(adapter.watch("/"), 1)

        yield* Effect.flip(adapter.writeFileString("/f", "too long"))
        assert.deepStrictEqual(yield* core.stat("/f"), before)
        assert.strictEqual(yield* adapter.readFileString("/f"), "old")
        yield* core.mkdir("/sentinel")
        assert.deepStrictEqual(yield* changes, [{ _tag: "Create", path: "/sentinel" }])
      }).pipe(Effect.provide(Testing.layer({ volume: { maxBytes: ByteSize.bytes(3) } }))))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should filter unrelated byte names when converting watched paths to strings", () =>
      Effect.gen(function*() {
        const core = yield* Vfs.Caller
        const adapter = yield* MemoryFileSystem.bind(yield* Vfs.Volume)
        yield* core.mkdir("/watched")
        const changes = yield* Testing.collectChanges(adapter.watch("/watched"), 1)

        yield* core.mkdir(yield* Vfs.pathFromBytes(new Uint8Array([47, 255])))
        yield* core.mkdir("/watched/child")
        assert.deepStrictEqual(yield* changes, [{ _tag: "Create", path: "/watched/child" }])
        const invalid = yield* Effect.flip(adapter.readDirectory("/"))
        assert.strictEqual(invalid.reason._tag, "InvalidData")
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should keep delivering a watched directory's changes when an ancestor is renamed", () =>
      Effect.gen(function*() {
        const core = yield* Vfs.Caller
        const adapter = yield* MemoryFileSystem.bind(yield* Vfs.Volume)
        yield* core.mkdir("/project")
        yield* core.mkdir("/project/watched")
        const changes = yield* Testing.collectChanges(adapter.watch("/project/watched"), 1)

        yield* core.rename("/project", "/renamed")
        yield* core.mkdir("/renamed/watched/child")
        assert.deepStrictEqual(yield* changes, [{ _tag: "Create", path: "/renamed/watched/child" }])
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should keep delivering a watched file's updates at its new name when it is renamed", () =>
      Effect.gen(function*() {
        const core = yield* Vfs.Caller
        const adapter = yield* MemoryFileSystem.bind(yield* Vfs.Volume)
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
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should keep delivering a watched file's updates when an ancestor is renamed", () =>
      Effect.gen(function*() {
        const core = yield* Vfs.Caller
        const adapter = yield* MemoryFileSystem.bind(yield* Vfs.Volume)
        yield* core.mkdir("/d")
        yield* core.writeFile("/d/a", bytes.encode("one"), { access: "write", create: "exclusive" })
        const changes = yield* Testing.collectChanges(adapter.watch("/d/a"), 1)

        yield* core.rename("/d", "/e")
        yield* core.writeFile("/e/a", bytes.encode("two"), { access: "write" })
        assert.deepStrictEqual(yield* changes, [{ _tag: "Update", path: "/e/a" }])
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should not deliver watched file updates when writes use another hard link", () =>
      Effect.gen(function*() {
        const core = yield* Vfs.Caller
        const adapter = yield* MemoryFileSystem.bind(yield* Vfs.Volume)
        yield* core.writeFile("/a", bytes.encode("one"), { access: "write", create: "exclusive" })
        yield* core.link("/a", "/alias")
        const changes = yield* Testing.collectChanges(adapter.watch("/a"), 1)

        yield* core.writeFile("/alias", bytes.encode("two"), { access: "write" })
        yield* core.writeFile("/a", bytes.encode("three"), { access: "write" })
        assert.deepStrictEqual(yield* changes, [{ _tag: "Update", path: "/a" }])
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should end a watch when the watched directory is removed", () =>
      Effect.gen(function*() {
        const core = yield* Vfs.Caller
        const adapter = yield* MemoryFileSystem.bind(yield* Vfs.Volume)
        yield* core.mkdir("/watched")
        // Asks for more changes than arrive, so it completes only because the stream ends.
        const changes = yield* Testing.collectChanges(adapter.watch("/watched"), 2)

        yield* core.rmdir("/watched")
        assert.deepStrictEqual(yield* changes, [{ _tag: "Remove", path: "/watched" }])
      }).pipe(Effect.provide(Testing.layer())))
  })

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

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should watch the object a path names once the watch is active when a rename lands as it opens", () =>
      Effect.gen(function*() {
        const core = yield* Vfs.Caller
        yield* core.mkdir("/w")
        yield* core.mkdir("/x")

        const volume = changedBeforeFirstWatch(
          yield* Vfs.Volume,
          Effect.andThen(core.rename("/w", "/x/w"), core.mkdir("/w"))
        )

        const adapter = yield* MemoryFileSystem.bind(volume)
        const changes = yield* Testing.collectChanges(adapter.watch("/w"), 1)

        yield* core.mkdir("/x/w/other")
        yield* core.mkdir("/w/child")
        assert.deepStrictEqual(yield* changes, [{ _tag: "Create", path: "/w/child" }])
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should fail a watch with NotFound when its path is removed as the watch opens", () =>
      Effect.gen(function*() {
        const core = yield* Vfs.Caller
        yield* core.mkdir("/w")
        const adapter = yield* MemoryFileSystem.bind(changedBeforeFirstWatch(yield* Vfs.Volume, core.rmdir("/w")))

        const error = yield* Effect.flip(Stream.runCollect(adapter.watch("/w")))
        assert.strictEqual(error._tag, "PlatformError")
        assert.strictEqual(error.reason._tag, "NotFound")
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should preserve hard-link topology when copying a directory", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.make
        yield* fs.makeDirectory("/source/nested", { recursive: true })
        yield* fs.writeFileString("/source/nested/a", "content")
        yield* fs.link("/source/nested/a", "/source/nested/b")
        yield* fs.utimes("/source/nested", 100, 200)
        yield* fs.copy("/source", "/copy", { preserveTimestamps: true })
        assert.deepStrictEqual((yield* fs.stat("/copy/nested/a")).ino, (yield* fs.stat("/copy/nested/b")).ino)
      }))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should preserve directory timestamps when copying with metadata preservation", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.make
        yield* fs.makeDirectory("/source/nested", { recursive: true })
        yield* fs.utimes("/source/nested", 100, 200)
        yield* fs.copy("/source", "/copy", { preserveTimestamps: true })
        assert.strictEqual(Option.getOrThrow((yield* fs.stat("/copy/nested")).mtime).getTime(), 200_000)
      }))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should retain an append handle cursor when its file is truncated", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.make
        yield* fs.writeFileString("/f", "abcd")
        const f = yield* fs.open("/f", { flag: "a+" })
        yield* f.seek(4n, "start")
        yield* f.truncate(1)
        assert.strictEqual(yield* f.seek(0n, "current"), 4n)
      }))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should retain an open cursor when its path is truncated", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.make
        yield* fs.writeFileString("/f", "abcd")
        const g = yield* fs.open("/f", { flag: "r+" })
        yield* g.seek(3n, "start")
        yield* fs.truncate("/f", 0)
        assert.strictEqual(yield* g.seek(0n, "current"), 3n)
      }))
  })
})

describe("overlay memory binding", () => {
  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should expose direct and adapter writes when bound to an overlay volume", () =>
      Effect.gen(function*() {
        const base = yield* (yield* Vfs.fromFixture({
          entries: [{ kind: "file", path: "/f", bytes: bytes.encode("base") }]
        })).snapshot

        const overlay = yield* Vfs.makeOverlay(base)
        const core = yield* overlay.caller()
        const adapter = yield* MemoryFileSystem.bind(overlay)

        yield* adapter.writeFileString("/f", "adapter")
        assert.strictEqual(new TextDecoder().decode(yield* core.readFile("/f")), "adapter")
        yield* core.writeFile("/f", bytes.encode("core"), { access: "write", truncate: true })
        assert.strictEqual(yield* adapter.readFileString("/f"), "core")
        assert.strictEqual((yield* overlay.changes()).length, 1)
      }))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should keep sibling overlay bindings isolated when writes have the same size", () =>
      Effect.gen(function*() {
        const base = yield* (yield* Vfs.fromFixture({
          entries: [{ kind: "file", path: "/f", bytes: bytes.encode("same") }]
        })).snapshot

        const a = yield* MemoryFileSystem.bind(yield* Vfs.makeOverlay(base))
        const b = yield* MemoryFileSystem.bind(yield* Vfs.makeOverlay(base))
        yield* a.writeFileString("/f", "edit")
        assert.strictEqual(yield* a.readFileString("/f"), "edit")
        assert.strictEqual(yield* b.readFileString("/f"), "same")
      }))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should publish direct and adapter rename events in commit order when a destination is replaced", () =>
      Effect.gen(function*() {
        const base = yield* (yield* Vfs.fromFixture({
          entries: [
            { kind: "file", path: "/direct", bytes: bytes.encode("direct") },
            { kind: "file", path: "/source", bytes: bytes.encode("source") },
            { kind: "file", path: "/destination", bytes: bytes.encode("destination") }
          ]
        })).snapshot

        const overlay = yield* Vfs.makeOverlay(base)
        const core = yield* overlay.caller()
        const adapter = yield* MemoryFileSystem.bind(overlay)

        const watched = yield* Testing.collectChanges(adapter.watch("/"), 4)

        yield* core.rename("/direct", "/renamed")
        yield* adapter.rename("/source", "/destination")

        assert.deepStrictEqual(yield* watched, [
          { _tag: "Remove", path: "/direct" },
          { _tag: "Create", path: "/renamed" },
          { _tag: "Remove", path: "/source" },
          { _tag: "Create", path: "/destination" }
        ])
        assert.strictEqual(yield* adapter.readFileString("/destination"), "source")
      }))
  })
})

describe("memory adapter error mapping", () => {
  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should report NoSpace when a write exceeds capacity", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.bind(yield* Vfs.Volume)

        const error = yield* Effect.flip(fs.writeFileString("/file", "too large"))

        const reason = systemReason(error)
        assert.strictEqual(reason._tag, "Unknown")
        assert.strictEqual(reason.method, "writeFile")
        assert.strictEqual(reason.pathOrDescriptor, "/file")
        assert.strictEqual(reason.description, "NoSpace")
      }).pipe(Effect.provide(Testing.layer({ volume: { maxBytes: ByteSize.bytes(1) } }))))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should report PermissionDenied with EPERM when ownership denies an operation", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const owner = yield* MemoryFileSystem.bind(volume)
        yield* owner.writeFileString("/file", "x")

        const guest = yield* MemoryFileSystem.bind(volume, {
          identity: { uid: 1, gid: 1, groups: [], privileged: false }
        })

        const error = yield* Effect.flip(guest.chmod("/file", 0o600))

        const reason = systemReason(error)
        assert.strictEqual(reason._tag, "PermissionDenied")
        assert.strictEqual(reason.method, "chmod")
        assert.strictEqual(reason.description, "NotPermitted (EPERM)")
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should attribute a missing path to watch when watch subscription fails", () =>
      Effect.gen(function*() {
        const fs = yield* MemoryFileSystem.make
        const error = yield* Effect.flip(fs.watch("/missing").pipe(Stream.runDrain))

        const reason = systemReason(error)
        assert.strictEqual(reason._tag, "NotFound")
        assert.strictEqual(reason.method, "watch")
        assert.strictEqual(reason.pathOrDescriptor, "/missing")
      }))
  })
})
