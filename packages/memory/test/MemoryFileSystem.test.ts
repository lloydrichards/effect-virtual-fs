import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, FileSystem, Layer, Option, type PlatformError, Result, Stream } from "effect"
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

// The layer needs no platform service: the volume mints its own identity.
const memoryLayer = MemoryFileSystem.layer

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

  it.effect("should report a typed st_mode with zero dev and rdev", () =>
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
    it.effect(`should watch ${recursive === true ? "nested changes with recursion enabled" : `only direct children with recursive ${recursive}`}`, () =>
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
    60_000
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
