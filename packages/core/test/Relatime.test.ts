import { assert, describe, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Testing, VirtualFileSystem as Vfs } from "../src/index.js"
import { withVolumeTestSeams } from "../src/internal/testSeams.js"

const DAY = Duration.hours(24)

const bytes = (...values: Array<number>) => new Uint8Array(values)

// Lets forked fibers make progress without waiting on any of them.
const settle = Effect.gen(function*() {
  for (let i = 0; i < 4; i++) yield* Effect.yieldNow
})

// Each read that relatime governs, as a function of the caller and a path to a file or directory.
const READS = [
  { name: "readFile", kind: "file", read: (fs: Vfs.Caller, path: string) => Effect.asVoid(fs.readFile(path)) },
  {
    name: "readDirectory",
    kind: "directory",
    read: (fs: Vfs.Caller, path: string) => Effect.asVoid(fs.readDirectory(path))
  },
  {
    name: "pread",
    kind: "file",
    read: (fs: Vfs.Caller, path: string) =>
      Effect.scoped(Effect.flatMap(fs.open(path, { access: "read" }), (file) => file.pread(1, 0n)))
  },
  {
    name: "read",
    kind: "file",
    read: (fs: Vfs.Caller, path: string) =>
      Effect.scoped(Effect.flatMap(fs.open(path, { access: "read" }), (file) => file.read(1)))
  }
] as const

const create = (fs: Vfs.Caller, kind: "file" | "directory", path: string) =>
  kind === "file"
    ? fs.writeFile(path, bytes(1), { access: "write", create: "exclusive" })
    : Effect.asVoid(fs.mkdir(path))

// Changes what the path names: a file's contents, or a directory's entries.
const modify = (fs: Vfs.Caller, kind: "file" | "directory", path: string) =>
  kind === "file"
    ? fs.writeFile(path, bytes(2), { access: "write", truncate: true })
    : Effect.asVoid(fs.mkdir(`${path}/child`))

const atime = (fs: Vfs.Caller, path: string) => Effect.map(fs.stat(path), (metadata) => metadata.atimeNs)

describe("relatime", () => {
  for (const { name, kind, read } of READS) {
    it.effect(`${name} refreshes an access time not newer than the last change`, () =>
      Effect.gen(function*() {
        const fs = yield* Vfs.Caller
        yield* create(fs, kind, "/target")
        yield* TestClock.adjust("1 second")

        yield* read(fs, "/target")
        const refreshed = yield* atime(fs, "/target")
        assert.strictEqual(refreshed, Duration.toNanosUnsafe(Duration.seconds(1)))

        // Newer than the last change and less than a day old: the time stays.
        yield* TestClock.adjust("1 second")
        yield* read(fs, "/target")
        assert.strictEqual(yield* atime(fs, "/target"), refreshed)

        yield* modify(fs, kind, "/target")
        yield* TestClock.adjust("1 second")
        yield* read(fs, "/target")
        assert.strictEqual(yield* atime(fs, "/target"), Duration.toNanosUnsafe(Duration.seconds(3)))
      }).pipe(Effect.provide(Testing.layer())))

    it.effect(`${name} refreshes an access time not newer than the last status change`, () =>
      Effect.gen(function*() {
        const fs = yield* Vfs.Caller
        yield* create(fs, kind, "/target")
        yield* TestClock.adjust("1 second")
        yield* read(fs, "/target")
        assert.strictEqual(yield* atime(fs, "/target"), Duration.toNanosUnsafe(Duration.seconds(1)))

        // A status change alone moves the change time and leaves the modification time where it was.
        yield* TestClock.adjust("1 second")
        yield* fs.chmod("/target", 0o700)
        const changed = yield* fs.stat("/target")
        assert.strictEqual(changed.ctimeNs, Duration.toNanosUnsafe(Duration.seconds(2)))
        assert.strictEqual(changed.mtimeNs, 0n)

        yield* TestClock.adjust("1 second")
        yield* read(fs, "/target")
        assert.strictEqual(yield* atime(fs, "/target"), Duration.toNanosUnsafe(Duration.seconds(3)))
      }).pipe(Effect.provide(Testing.layer())))

    it.effect(`${name} refreshes an access time once it is a day old`, () =>
      Effect.gen(function*() {
        const fs = yield* Vfs.Caller
        yield* create(fs, kind, "/target")
        yield* TestClock.adjust("1 second")
        yield* read(fs, "/target")
        const refreshed = yield* atime(fs, "/target")

        yield* TestClock.adjust(Duration.subtract(DAY, Duration.nanos(1n)))
        yield* read(fs, "/target")
        assert.strictEqual(yield* atime(fs, "/target"), refreshed)

        yield* TestClock.adjust(Duration.nanos(1n))
        yield* read(fs, "/target")
        assert.strictEqual(yield* atime(fs, "/target"), refreshed + Duration.toNanosUnsafe(DAY))
      }).pipe(Effect.provide(Testing.layer())))
  }

  it.effect("leaves the access time alone when a handle reads nothing", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* fs.writeFile("/f", bytes(1), { access: "write", create: "exclusive" })
      const file = yield* fs.open("/f", { access: "read" })
      yield* TestClock.adjust("1 second")

      assert.deepStrictEqual((yield* file.pread(0, 0n)).bytes, bytes())
      assert.deepStrictEqual(yield* file.read(0), bytes())
      assert.strictEqual(yield* atime(fs, "/f"), 0n)
    }).pipe(Effect.scoped, Effect.provide(Testing.layer())))

  it.effect("runs reads with a recent access time beside an observation, and waits for any other", () =>
    Effect.gen(function*() {
      // Both entries were accessed after their last change, so reading them refreshes nothing.
      const base = yield* (yield* Vfs.fromFixture({
        entries: [
          { kind: "file", path: "/recent", bytes: bytes(1, 2), metadata: { atimeNs: 5n } },
          { kind: "directory", path: "/dir", metadata: { atimeNs: 5n } },
          { kind: "file", path: "/stale", bytes: bytes(3) }
        ]
      })).snapshot

      // A second on, so the unread entry's access time is due.
      yield* TestClock.adjust("1 second")

      const overlay = yield* Vfs.makeOverlay(base)
      const fs = yield* overlay.caller()
      const file = yield* fs.open("/recent", { access: "read" })
      const held = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      // A capture held between its two halves keeps one permit, which a change must wait for.
      const capturing = yield* overlay.capture().pipe(
        withVolumeTestSeams({
          betweenSnapshotAndSummary: Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release)))
        }),
        Effect.forkChild({ startImmediately: true })
      )

      yield* Deferred.await(held)
      assert.deepStrictEqual(yield* fs.readFile("/recent"), bytes(1, 2))
      assert.strictEqual((yield* fs.readDirectory("/dir")).value.length, 0)
      assert.deepStrictEqual((yield* file.pread(2, 0n)).bytes, bytes(1, 2))

      // A due access time and a cursor read each need a change, so both wait for the capture.
      const stale = yield* fs.readFile("/stale").pipe(Effect.forkChild({ startImmediately: true }))
      const cursor = yield* file.read(2).pipe(Effect.forkChild({ startImmediately: true }))
      yield* settle
      assert.isUndefined(stale.pollUnsafe())
      assert.isUndefined(cursor.pollUnsafe())

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(capturing)
      assert.deepStrictEqual(yield* Fiber.join(stale), bytes(3))
      assert.deepStrictEqual(yield* Fiber.join(cursor), bytes(1, 2))
      assert.strictEqual(yield* atime(fs, "/recent"), 5n)
    }).pipe(Effect.scoped))
})
