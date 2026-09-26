import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Deferred, Effect, Exit, Fiber, Layer, Predicate, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { LiveVolume, VirtualFileSystem as Vfs } from "../src/index.js"
import { entryNames } from "./support/text.js"

const options = {
  maxImageBytes: ByteSize.kilobytes(64),
  volume: {
    maxEntries: 100,
    maxBytes: ByteSize.kilobytes(32),
    maxFileBytes: ByteSize.kilobytes(16),
    maxPathBytes: ByteSize.bytes(1024)
  }
}

describe("live image store service", () => {
  it.effect("should reopen committed bytes when a store Layer is injected", () => {
    let image: Uint8Array | undefined

    const store = Layer.succeed(
      LiveVolume.LiveImageStore,
      LiveVolume.LiveImageStore.of({
        loadOrCreate: (initial) => Effect.succeed(image ?? initial),
        commit: (candidate) =>
          Effect.sync(() => {
            image = candidate

            return "committed" as const
          })
      })
    )

    return Effect.gen(function*() {
      yield* Effect.scoped(Effect.gen(function*() {
        const volume = yield* LiveVolume.open(options)
        yield* (yield* volume.caller()).writeFile("/saved", new Uint8Array([4, 5]), {
          access: "write",
          create: "exclusive"
        })
      }))

      yield* Effect.scoped(Effect.gen(function*() {
        const volume = yield* LiveVolume.open(options)
        assert.deepEqual(yield* (yield* volume.caller()).readFile("/saved"), new Uint8Array([4, 5]))
      }))
    }).pipe(Effect.provide(store))
  })

  it.effect("should keep a rejected change invisible when store commit rejects it", () =>
    Effect.scoped(Effect.gen(function*() {
      const volume = yield* LiveVolume.open(options)
      const caller = yield* volume.caller()
      assert.strictEqual((yield* Effect.flip(caller.mkdir("/rejected"))).code, "StorageRejected")
      assert.strictEqual((yield* Effect.flip(caller.stat("/rejected"))).code, "NotFound")
    })).pipe(Effect.provide(Layer.succeed(
      LiveVolume.LiveImageStore,
      LiveVolume.LiveImageStore.of({
        loadOrCreate: (initial) => Effect.succeed(initial),
        commit: () => Effect.succeed("rejected" as const)
      })
    ))))

  it.effect("should leave path and handle state unchanged when a commit is rejected", () =>
    Effect.scoped(Effect.gen(function*() {
      let outcome: "committed" | "rejected" = "committed"

      const { volume } = yield* LiveVolume.openImage(
        yield* LiveVolume.prepareEmptyImage(),
        ByteSize.kilobytes(64),
        () => Effect.succeed(outcome)
      )

      const caller = yield* volume.caller()
      const handle = yield* caller.open("/file", { access: "readWrite", create: "exclusive" })
      yield* handle.write(new Uint8Array([1]))
      const before = yield* handle.stat
      const stream = yield* volume.watch()
      const nextEvent = yield* Stream.runHead(stream).pipe(Effect.forkChild({ startImmediately: true }))

      outcome = "rejected"
      assert.strictEqual((yield* Effect.flip(handle.write(new Uint8Array([2])))).code, "StorageRejected")
      assert.strictEqual((yield* Effect.flip(caller.mkdir("/rejected"))).code, "StorageRejected")
      outcome = "committed"

      assert.deepEqual((yield* handle.pread(2, 0n)).bytes, new Uint8Array([1]))
      assert.strictEqual(yield* handle.seek(0n, "current"), 1n)
      assert.deepEqual(yield* volume.usage, { usedBytes: 1n, entries: 1 })
      assert.strictEqual((yield* Effect.flip(caller.stat("/rejected"))).code, "NotFound")
      assert.deepEqual(yield* handle.stat, before)

      yield* caller.mkdir("/visible")
      const event = yield* Fiber.join(nextEvent)
      assert.strictEqual(event._tag, "Some")

      if (Predicate.isTagged("Some")(event)) {
        assert.deepEqual(entryNames(yield* caller.readDirectory("/")), ["file", "visible"])
        assert.deepEqual(yield* Vfs.pathToBytes(event.value.path), new TextEncoder().encode("/visible"))
      }
    })))

  it.effect("should stop paths, observations, and watch registration when a commit outcome is unknown", () =>
    Effect.gen(function*() {
      const outcomes: ReadonlyArray<Effect.Effect<LiveVolume.CommitOutcome>> = [
        Effect.sync(() => {
          throw new Error("storage exploded")
        }),
        Effect.die("storage died"),
        Effect.succeed("unknown" as const)
      ]

      for (const outcome of outcomes) {
        let commits = 0

        const { volume } = yield* LiveVolume.openImage(
          yield* LiveVolume.prepareEmptyImage(),
          ByteSize.kilobytes(64),
          () =>
            Effect.suspend(() => {
              commits++

              return outcome
            })
        )

        const caller = yield* volume.caller()
        const failure = yield* Effect.flip(caller.mkdir("/dir"))

        assert.strictEqual(failure.code, "OutcomeUnknown")
        assert.strictEqual(failure.operation, "mkdir")
        assert.strictEqual((yield* Effect.flip(caller.stat("/"))).code, "VolumeUnavailable")
        assert.strictEqual((yield* Effect.flip(caller.mkdir("/later"))).code, "VolumeUnavailable")
        assert.strictEqual((yield* Effect.flip(volume.usage)).code, "VolumeUnavailable")
        assert.strictEqual((yield* Effect.flip(volume.snapshot)).code, "VolumeUnavailable")
        const callerFailure = yield* Effect.flip(volume.caller())
        assert.strictEqual(callerFailure._tag, "VfsError")

        if (Predicate.isTagged("VfsError")(callerFailure)) {
          assert.strictEqual(callerFailure.code, "VolumeUnavailable")
        }

        assert.strictEqual((yield* Effect.flip(volume.watch())).code, "VolumeUnavailable")
        assert.strictEqual(commits, 1)
      }
    }))

  it.effect("should retain open content until close when unlink succeeds after rejection", () =>
    Effect.scoped(Effect.gen(function*() {
      let outcome: "committed" | "rejected" = "committed"

      const { volume } = yield* LiveVolume.openImage(
        yield* LiveVolume.prepareEmptyImage(),
        ByteSize.kilobytes(64),
        () => Effect.succeed(outcome)
      )

      const caller = yield* volume.caller()
      const handle = yield* caller.open("/file", { access: "readWrite", create: "exclusive" })
      yield* handle.write(new Uint8Array([1]))
      const root = yield* caller.root
      const reference = yield* caller.lookup(Vfs.Entry(root, new TextEncoder().encode("file")))

      outcome = "rejected"
      assert.strictEqual((yield* Effect.flip(caller.unlink("/file"))).code, "StorageRejected")
      assert.strictEqual((yield* caller.stat(reference)).nlink, 1)
      yield* TestClock.adjust("1 second")
      assert.strictEqual((yield* Effect.flip(caller.readFile("/file"))).code, "StorageRejected")
      outcome = "committed"
      assert.deepEqual(yield* caller.readFile("/file"), new Uint8Array([1]))
      yield* caller.unlink("/file")
      assert.strictEqual((yield* Effect.flip(caller.open(reference, { access: "read" }))).code, "StaleReference")
      yield* handle.write(new Uint8Array([2]))
      assert.deepEqual((yield* handle.pread(2, 0n)).bytes, new Uint8Array([1, 2]))
      assert.deepEqual(yield* volume.usage, { usedBytes: 2n, entries: 0 })
      yield* handle.close
      assert.deepEqual(yield* volume.usage, { usedBytes: 0n, entries: 0 })
      yield* caller.mkdir("/after-rejection")
      assert.strictEqual((yield* caller.stat("/after-rejection")).kind, "directory")
    })))

  it.effect("should preserve hard-link inode identity with a new incarnation when committed bytes reopen", () =>
    Effect.gen(function*() {
      let stored = yield* LiveVolume.prepareEmptyImage()
      const bound = ByteSize.bytes(64 * 1024)

      const session = yield* LiveVolume.openImage(stored, bound, (bytes) =>
        Effect.sync(() => {
          stored = new Uint8Array(bytes)

          return "committed" as const
        }))

      const volume = session.volume

      const caller = yield* volume.caller()
      yield* caller.writeFile("/file", new Uint8Array([1, 2, 3]), { access: "write", create: "exclusive" })
      yield* caller.link("/file", "/alias")
      const original = yield* caller.stat("/file")
      const reopened = (yield* LiveVolume.openImage(stored, bound, () => Effect.succeed("committed" as const))).volume
      const restored = yield* reopened.caller()

      assert.strictEqual(reopened.identity, volume.identity)
      assert.notStrictEqual(reopened.incarnation, volume.incarnation)
      assert.strictEqual((yield* restored.stat("/file")).ino, original.ino)
      assert.strictEqual((yield* restored.stat("/alias")).ino, original.ino)
      assert.deepEqual(yield* restored.readFile("/alias"), new Uint8Array([1, 2, 3]))
      yield* session.shutdown
      assert.strictEqual((yield* Effect.flip(volume.usage)).code, "VolumeUnavailable")
    }))
})

// A store whose empty image starts its inode allocator one below the largest safe integer.
const nearlyExhausted = Layer.succeed(
  LiveVolume.LiveImageStore,
  LiveVolume.LiveImageStore.of({
    loadOrCreate: (initial) =>
      Effect.sync(() =>
        new TextEncoder().encode(
          new TextDecoder().decode(initial).replace(
            /"nextInode":2,/,
            `"nextInode":${Number.MAX_SAFE_INTEGER - 1},`
          )
        )
      ),
    commit: () => Effect.succeed("committed" as const)
  })
)

describe("the inode allocator", () => {
  it.effect("should report NoSpace without disabling the volume when the inode limit is reached", () =>
    Effect.scoped(Effect.gen(function*() {
      const volume = yield* LiveVolume.open(options)
      const caller = yield* volume.caller()

      yield* caller.mkdir("/last")
      const refused = yield* Effect.flip(caller.mkdir("/beyond"))

      assert.strictEqual(refused.code, "NoSpace")
      assert.strictEqual((yield* caller.stat("/last")).kind, "directory")
      assert.isTrue(Exit.isSuccess(yield* Effect.exit(caller.rmdir("/last"))))
    })).pipe(Effect.provide(nearlyExhausted)))
})

const bytes = (...values: Array<number>) => new Uint8Array(values)

const name = (value: string) => new TextEncoder().encode(value)

const MAX_IMAGE_BYTES = ByteSize.kilobytes(256)

interface Pause {
  readonly entered: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
}

// A live volume opened through the public image boundary whose next commit can be paused or given a fixed outcome.
const pausable = Effect.gen(function*() {
  let pause: Pause | undefined
  let outcome: LiveVolume.CommitOutcome = "committed"
  let commits = 0
  let lastImage: Uint8Array | undefined
  const record = { commits: () => commits, lastImage: () => lastImage }

  const image = yield* LiveVolume.prepareEmptyImage()

  const session = yield* LiveVolume.openImage(image, MAX_IMAGE_BYTES, (committed) =>
    Effect.suspend(() => {
      commits++
      lastImage = committed
      const paused = pause

      if (paused === undefined) return Effect.succeed(outcome)
      pause = undefined

      return Deferred.succeed(paused.entered, undefined).pipe(
        Effect.andThen(Deferred.await(paused.release)),
        Effect.map(() => outcome)
      )
    }))

  const caller = yield* session.volume.caller()

  // Pauses the next commit, returning the effects that await its start and release it.
  const pauseNext = Effect.gen(function*() {
    const paused: Pause = { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
    pause = paused

    return { entered: Deferred.await(paused.entered), release: Deferred.succeed(paused.release, undefined) }
  })

  const setOutcome = (next: LiveVolume.CommitOutcome) =>
    Effect.sync(() => {
      outcome = next
    })

  return { volume: session.volume, caller, pauseNext, setOutcome, record }
})

// Lets forked fibers make progress without waiting on any of them.
const settle = Effect.gen(function*() {
  for (let i = 0; i < 4; i++) yield* Effect.yieldNow
})

const renameFixture = Effect.gen(function*() {
  const live = yield* pausable
  yield* live.caller.mkdir("/a")
  yield* live.caller.mkdir("/b")
  yield* live.caller.writeFile("/a/f", bytes(1), { access: "write", create: "exclusive" })

  return live
})

// A live volume whose store answers every commit with the given effect.
const answering = Effect.fnUntraced(
  function*(commit: Effect.Effect<LiveVolume.CommitOutcome>, maxImageBytes = MAX_IMAGE_BYTES) {
    let commits = 0
    const image = yield* LiveVolume.prepareEmptyImage()

    const session = yield* LiveVolume.openImage(image, maxImageBytes, () =>
      Effect.suspend(() => {
        commits++

        return commit
      }))

    return { volume: session.volume, caller: yield* session.volume.caller(), commits: () => commits }
  }
)

describe("live commit", () => {
  it.effect("should reject an oversized candidate without stopping the volume when the image limit is reached", () =>
    Effect.gen(function*() {
      const image = yield* LiveVolume.prepareEmptyImage()
      const live = yield* answering(Effect.succeed("committed" as const), ByteSize.bytes(image.length + 1024))

      const failed = yield* Effect.flip(
        live.caller.writeFile("/big", new Uint8Array(8192), { access: "write", create: "exclusive" })
      )

      assert.strictEqual(failed.code, "StorageRejected")
      assert.strictEqual(failed.operation, "commit")
      assert.strictEqual(live.commits(), 0)
      assert.strictEqual((yield* Effect.flip(live.caller.stat("/big"))).code, "NotFound")
      yield* live.caller.mkdir("/ok")
      assert.strictEqual(live.commits(), 1)
    }))

  it.effect("should settle a pending commit when its worker is interrupted", () =>
    Effect.gen(function*() {
      const live = yield* pausable
      const { entered, release } = yield* live.pauseNext
      const worker = yield* live.caller.mkdir("/new").pipe(Effect.forkChild({ startImmediately: true }))
      yield* entered
      const interrupting = yield* Fiber.interrupt(worker).pipe(Effect.forkChild({ startImmediately: true }))
      yield* settle
      assert.isUndefined(interrupting.pollUnsafe())
      yield* release
      yield* Fiber.join(interrupting)
      assert.strictEqual((yield* live.caller.stat("/new")).kind, "directory")
      assert.strictEqual(live.record.commits(), 1)
    }))

  it.effect("should hide a partial rename when reads wait behind a pending commit", () =>
    Effect.gen(function*() {
      const { caller, pauseNext } = yield* renameFixture
      const { entered, release } = yield* pauseNext
      const rename = yield* caller.rename("/a/f", "/b/f").pipe(Effect.forkChild({ startImmediately: true }))
      yield* entered

      const source = yield* caller.stat("/a/f").pipe(Effect.forkChild({ startImmediately: true }))
      const target = yield* caller.stat("/b/f").pipe(Effect.forkChild({ startImmediately: true }))
      yield* settle
      assert.isUndefined(source.pollUnsafe())
      assert.isUndefined(target.pollUnsafe())

      yield* release
      yield* Fiber.join(rename)
      assert.strictEqual((yield* Effect.flip(Fiber.join(source))).code, "NotFound")
      assert.strictEqual((yield* Fiber.join(target)).kind, "file")
    }))

  it.effect("should show the original paths when a waiting rename commit is rejected", () =>
    Effect.gen(function*() {
      const { caller, pauseNext, setOutcome } = yield* renameFixture
      const root = yield* caller.root
      const a = yield* caller.lookup(Vfs.Entry(root, name("a")))
      const b = yield* caller.lookup(Vfs.Entry(root, name("b")))
      const file = yield* caller.lookup(Vfs.Entry(a, name("f")))
      const aBefore = (yield* caller.readDirectory(a)).revision
      const bBefore = (yield* caller.readDirectory(b)).revision

      const { entered, release } = yield* pauseNext
      const rename = yield* caller.rename("/a/f", "/b/f").pipe(Effect.forkChild({ startImmediately: true }))
      yield* entered

      const source = yield* caller.stat("/a/f").pipe(Effect.forkChild({ startImmediately: true }))
      const target = yield* caller.stat("/b/f").pipe(Effect.forkChild({ startImmediately: true }))
      yield* settle
      assert.isUndefined(source.pollUnsafe())
      assert.isUndefined(target.pollUnsafe())

      yield* setOutcome("rejected")
      yield* release
      assert.strictEqual((yield* Effect.flip(Fiber.join(rename))).code, "StorageRejected")
      yield* setOutcome("committed")

      assert.strictEqual((yield* Fiber.join(source)).kind, "file")
      assert.strictEqual((yield* Effect.flip(Fiber.join(target))).code, "NotFound")
      assert.strictEqual((yield* caller.readDirectory(a)).revision, aBefore)
      assert.strictEqual((yield* caller.readDirectory(b)).revision, bBefore)
      assert.strictEqual(yield* caller.lookup(Vfs.Entry(a, name("f"))), file)
    }))

  it.effect("should preserve identity and revisions when a rename commit is rejected", () =>
    Effect.gen(function*() {
      const { caller, setOutcome } = yield* pausable
      yield* caller.mkdir("/from")
      yield* caller.mkdir("/to")
      yield* caller.writeFile("/from/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      yield* caller.link("/from/file", "/alias")

      const root = yield* caller.root
      const from = yield* caller.lookup(Vfs.Entry(root, name("from")))
      const file = yield* caller.lookup(Vfs.Entry(from, name("file")))
      const before = (yield* caller.stat(from)).revision
      yield* setOutcome("rejected")

      assert.strictEqual((yield* Effect.flip(caller.rename("/from/file", "/to/file"))).code, "StorageRejected")
      yield* setOutcome("committed")
      assert.strictEqual((yield* caller.stat(from)).revision, before)
      assert.strictEqual(yield* caller.lookup(Vfs.Entry(from, name("file"))), file)
      assert.strictEqual(yield* caller.lookup(Vfs.Entry(root, name("alias"))), file)
      assert.strictEqual((yield* Effect.flip(caller.stat("/to/file"))).code, "NotFound")

      yield* caller.rename("/from/file", "/to/file")
      const to = yield* caller.lookup(Vfs.Entry(root, name("to")))
      assert.strictEqual(yield* caller.lookup(Vfs.Entry(to, name("file"))), file)
      assert.strictEqual(yield* caller.lookup(Vfs.Entry(root, name("alias"))), file)
    }))

  it.effect("should commit an access-time refresh only when a read changes it", () =>
    Effect.gen(function*() {
      const { caller, commits } = yield* answering(Effect.succeed("committed" as const))
      yield* caller.writeFile("/f", bytes(1), { access: "write", create: "exclusive" })
      const file = yield* caller.open("/f", { access: "read" })
      const before = commits()
      // The clock has not moved since the write, so access time already equals now.
      yield* caller.readFile("/f")
      yield* caller.readDirectory("/")
      assert.strictEqual(commits() - before, 0)
      yield* TestClock.adjust("1 second")

      // Each first read after the change refreshes an access time; the root was changed by the create.
      yield* caller.readFile("/f")
      yield* caller.readDirectory("/")
      assert.strictEqual(commits() - before, 2)

      yield* caller.readFile("/f")
      yield* caller.readDirectory("/")
      yield* file.pread(1, 0n)
      yield* file.read(1)
      assert.strictEqual(commits() - before, 2)
    }).pipe(Effect.scoped))

  it.effect("should commit one refresh when two due reads wait behind the same change", () =>
    Effect.gen(function*() {
      const { caller, pauseNext, record } = yield* pausable
      yield* caller.writeFile("/f", bytes(1), { access: "write", create: "exclusive" })
      yield* TestClock.adjust("1 second")

      const { entered, release } = yield* pauseNext
      const change = yield* caller.mkdir("/x").pipe(Effect.forkChild({ startImmediately: true }))
      yield* entered

      // Both reads are queued behind the paused change with a due access time; once it is released, the second
      // refresh sees the first one's and stores nothing.
      const first = yield* caller.readFile("/f").pipe(Effect.forkChild({ startImmediately: true }))
      const second = yield* caller.readFile("/f").pipe(Effect.forkChild({ startImmediately: true }))
      yield* settle
      assert.isUndefined(first.pollUnsafe())
      assert.isUndefined(second.pollUnsafe())
      const before = record.commits()

      yield* release
      yield* Fiber.join(change)
      assert.deepStrictEqual(yield* Fiber.join(first), bytes(1))
      assert.deepStrictEqual(yield* Fiber.join(second), bytes(1))
      assert.strictEqual(record.commits() - before, 1)
      assert.strictEqual((yield* caller.stat("/f")).atimeNs, 1_000_000_000n)
    }))

  it.effect("should avoid a commit when a change leaves state unchanged", () =>
    Effect.gen(function*() {
      const { caller, commits } = yield* answering(Effect.succeed("committed" as const))
      const file = yield* caller.open("/f", { access: "readWrite", create: "exclusive" })
      const before = commits()

      assert.strictEqual(yield* file.write(bytes()), 0)
      yield* caller.setattr("/f", {})
      assert.strictEqual(commits() - before, 0)
    }).pipe(Effect.scoped))

  it.effect("should avoid a commit when a failed open scope closes", () =>
    Effect.gen(function*() {
      const { caller, record } = yield* pausable
      const opened = record.commits()

      yield* Effect.scoped(Effect.flip(caller.open("/missing", { access: "read" })))
      assert.strictEqual(record.commits() - opened, 0)
      yield* caller.mkdir("/x")
      assert.strictEqual(record.commits() - opened, 1)
      assert.isDefined(record.lastImage())
    }))

  it.effect("should read the committed state when an observation waits behind a commit", () =>
    Effect.gen(function*() {
      const { caller, volume, pauseNext } = yield* pausable
      const { usedBytes, entries } = yield* volume.usage
      const { entered, release } = yield* pauseNext
      const writer = yield* caller.mkdir("/held").pipe(Effect.forkChild({ startImmediately: true }))
      yield* entered

      const usage = yield* volume.usage.pipe(Effect.forkChild({ startImmediately: true }))
      const stat = yield* caller.stat("/held").pipe(Effect.forkChild({ startImmediately: true }))
      yield* settle
      assert.isUndefined(usage.pollUnsafe())
      assert.isUndefined(stat.pollUnsafe())

      yield* release
      yield* Fiber.join(writer)
      assert.strictEqual((yield* Fiber.join(stat)).kind, "directory")
      assert.deepStrictEqual(yield* Fiber.join(usage), { usedBytes, entries: entries + 1 })
    }))
})
