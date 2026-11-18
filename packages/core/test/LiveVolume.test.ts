/// <reference lib="es2024.arraybuffer" />

import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import {
  ByteSize,
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Predicate,
  Queue,
  Scheduler,
  Scope,
  Stream
} from "effect"
import * as TestClock from "effect/testing/TestClock"
import { LiveVolume, VirtualFileSystem as Vfs } from "../src/index.js"
import { readLines } from "./support/lines.js"
import { entryNames } from "./support/text.js"

// @ts-expect-error Exercise malformed reference keys received from JavaScript.
const malformedKey: Vfs.ReferenceKey = {}

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
  it.layer(BunCrypto.layer)((it) => {
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
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should persist final unlinked-file cleanup before reopening", () => {
      let image: Uint8Array | undefined
      let commits = 0

      const store = Layer.succeed(
        LiveVolume.LiveImageStore,
        LiveVolume.LiveImageStore.of({
          loadOrCreate: (initial) => Effect.succeed(image ?? initial),
          commit: (candidate) =>
            Effect.sync(() => {
              image = new Uint8Array(candidate)
              commits++

              return "committed" as const
            })
        })
      )

      return Effect.gen(function*() {
        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open(options)
          const caller = yield* volume.caller()
          const handle = yield* caller.open("/file", { access: "readWrite", create: "exclusive" })
          yield* handle.write(new Uint8Array([1]))
          yield* caller.unlink("/file")
          assert.strictEqual(readLines(image!).length, 3)

          const before = commits
          yield* handle.close
          assert.strictEqual(commits, before + 1)
          assert.strictEqual(readLines(image!).length, 2)
        }))

        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open(options)
          const caller = yield* volume.caller()
          assert.strictEqual((yield* Effect.flip(caller.stat("/file"))).code, "NotFound")
          yield* caller.mkdir("/after-reopen")
          assert.strictEqual((yield* caller.stat("/after-reopen")).kind, "directory")
        }))
      }).pipe(Effect.provide(store))
    })
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should keep a rejected change invisible when store commit rejects it",
      () =>
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
        )))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should leave path and handle state unchanged when a commit is rejected",
      () =>
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
        }))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should stop paths, observations, and watch registration when a commit outcome is unknown",
      () =>
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
            const key = yield* volume.referenceKey(yield* caller.root)
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

            for (
              const candidate of [
                key,
                malformedKey,
                { ...key, identity: key.identity.map((byte) => byte ^ 1) },
                { ...key, tag: key.tag.map((byte) => byte ^ 1) }
              ]
            ) {
              assert.strictEqual((yield* Effect.flip(volume.resolveReferenceKey(candidate))).code, "VolumeUnavailable")
            }

            assert.strictEqual((yield* Effect.flip(volume.watch())).code, "VolumeUnavailable")
            assert.strictEqual(commits, 1)
          }
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    for (const persisted of [false, true]) {
      const image = persisted ? "candidate" : "previous"
      it.effect(`should restore reference keys, revisions and allocation from the ${image} image after an unknown commit`, () =>
        Effect.gen(function*() {
          let stored = yield* LiveVolume.prepareEmptyImage()
          let uncertain = false

          const session = yield* LiveVolume.openImage(stored, options.maxImageBytes, (candidate) =>
            Effect.sync(() => {
              if (!uncertain || persisted) stored = candidate

              return uncertain ? "unknown" as const : "committed" as const
            }))

          const caller = yield* session.volume.caller()
          yield* caller.mkdir("/anchor")
          const anchor = yield* caller.stat("/anchor")
          const key = yield* session.volume.referenceKey(yield* caller.lookup("/anchor"))
          const before = yield* caller.stat("/")

          uncertain = true
          assert.strictEqual((yield* Effect.flip(caller.mkdir("/candidate"))).code, "OutcomeUnknown")
          yield* session.shutdown

          const reopened = yield* LiveVolume.openImage(
            stored,
            options.maxImageBytes,
            () => Effect.succeed("committed" as const)
          )

          const restored = yield* reopened.volume.caller()
          const reference = yield* reopened.volume.resolveReferenceKey(key)
          assert.strictEqual(reference, yield* restored.lookup("/anchor"))
          assert.deepEqual(yield* reopened.volume.referenceKey(reference), key)
          assert.strictEqual((yield* restored.stat(reference)).revision, anchor.revision)
          const revision = before.revision + (persisted ? 1n : 0n)
          assert.strictEqual((yield* restored.stat("/")).revision, revision)

          if (persisted) {
            const candidate = yield* restored.stat("/candidate")
            assert.strictEqual(candidate.ino, anchor.ino + 1n)
            assert.strictEqual(candidate.revision, revision)
          } else {
            assert.strictEqual((yield* Effect.flip(restored.lookup("/candidate"))).code, "NotFound")
          }

          yield* restored.mkdir("/next")
          const next = yield* restored.stat("/next")
          assert.strictEqual(next.ino, anchor.ino + (persisted ? 2n : 1n))
          assert.strictEqual(next.revision, revision + 1n)
          yield* reopened.shutdown
        }))
    }
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should retain open content until close when unlink succeeds after rejection",
      () =>
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
        }))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should preserve hard-link inode identity with a new incarnation when committed bytes reopen",
      () =>
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

          const reopened = (yield* LiveVolume.openImage(stored, bound, () =>
            Effect.succeed("committed" as const))).volume

          const restored = yield* reopened.caller()

          assert.strictEqual(reopened.identity, volume.identity)
          assert.notStrictEqual(reopened.incarnation, volume.incarnation)
          assert.strictEqual((yield* restored.stat("/file")).ino, original.ino)
          assert.strictEqual((yield* restored.stat("/alias")).ino, original.ino)
          assert.deepEqual(yield* restored.readFile("/alias"), new Uint8Array([1, 2, 3]))
          yield* session.shutdown
          assert.strictEqual((yield* Effect.flip(volume.usage)).code, "VolumeUnavailable")
        })
    )
  })
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
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should report NoSpace without disabling the volume when the inode limit is reached",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open(options)
          const caller = yield* volume.caller()

          yield* caller.mkdir("/last")
          const refused = yield* Effect.flip(caller.mkdir("/beyond"))

          assert.strictEqual(refused.code, "NoSpace")
          assert.strictEqual((yield* caller.stat("/last")).kind, "directory")
          assert.isTrue(Exit.isSuccess(yield* Effect.exit(caller.rmdir("/last"))))
        })).pipe(Effect.provide(nearlyExhausted))
    )
  })
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

// The store keeps its committed image across independently scoped opens.
const storedImages = () => {
  let image: Uint8Array | undefined
  let commit = (_candidate: Uint8Array): Effect.Effect<LiveVolume.CommitOutcome> => Effect.succeed("committed")

  const layer = Layer.succeed(
    LiveVolume.LiveImageStore,
    LiveVolume.LiveImageStore.of({
      loadOrCreate: (initial) => Effect.succeed(image ?? initial),
      commit: (candidate) =>
        commit(candidate).pipe(Effect.tap((outcome) =>
          Effect.sync(() => {
            if (outcome === "committed") image = new Uint8Array(candidate)
          })
        ))
    })
  )

  return {
    layer,
    setCommit: (next: typeof commit) => {
      commit = next
    }
  }
}

describe("live runtime limits", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect("should admit one waiter and release its slot when it is cancelled", () => {
      const store = storedImages()

      return Effect.scoped(Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let commits = 0
        store.setCommit(() =>
          Effect.gen(function*() {
            commits++

            if (commits === 1) {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            }

            return "committed" as const
          })
        )
        const volume = yield* LiveVolume.open({ ...options, volume: { ...options.volume, maxPendingOperations: 1 } })
        assert.strictEqual(volume.limits.maxPendingOperations, 1)
        const caller = yield* volume.caller()
        const key = yield* volume.referenceKey(yield* caller.root)
        const active = yield* caller.mkdir("/active").pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(entered)
        const cancelled = yield* caller.mkdir("/cancelled").pipe(Effect.forkChild({ startImmediately: true }))
        yield* settle
        assert.isUndefined(cancelled.pollUnsafe())

        for (
          const candidate of [
            key,
            malformedKey,
            { ...key, identity: key.identity.map((byte) => byte ^ 1) },
            { ...key, tag: key.tag.map((byte) => byte ^ 1) }
          ]
        ) {
          assert.strictEqual((yield* Effect.flip(volume.resolveReferenceKey(candidate))).code, "VolumeBusy")
        }

        const full = yield* caller.mkdir("/full").pipe(Effect.forkChild({ startImmediately: true }))
        yield* settle
        const completed = full.pollUnsafe()

        if (completed === undefined) yield* Deferred.succeed(release, undefined)
        assert.isDefined(completed)
        assert.strictEqual((yield* Effect.flip(Fiber.join(full))).code, "VolumeBusy")
        yield* Fiber.interrupt(cancelled)
        const replacement = yield* caller.mkdir("/replacement").pipe(Effect.forkChild({ startImmediately: true }))
        yield* settle
        assert.isUndefined(replacement.pollUnsafe())
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(active)
        yield* Fiber.join(replacement)
        assert.strictEqual(commits, 2)
        assert.deepEqual(entryNames(yield* caller.readDirectory("/")), ["active", "replacement"])
      })).pipe(Effect.provide(store.layer))
    })

    it.effect("should retune reopened watch buffers without losing stored files or overflowing fast subscribers", () => {
      const store = storedImages()

      return Effect.gen(function*() {
        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open({ ...options, volume: { ...options.volume, maxWatchEvents: 8 } })
          yield* (yield* volume.caller()).writeFile("/saved", bytes(7), { access: "write", create: "exclusive" })
        }))
        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open({
            ...options,
            volume: {
              ...options.volume,
              maxWatchEvents: 2,
              maxPendingOperations: 1
            }
          })

          assert.strictEqual(volume.limits.maxWatchEvents, 2)
          assert.strictEqual(volume.limits.maxPendingOperations, 1)
          const caller = yield* volume.caller()
          assert.deepEqual(yield* caller.readFile("/saved"), bytes(7))
          const slow = yield* volume.watch()
          const fast = yield* volume.watch()
          const received = yield* Queue.bounded<void>(3)

          const consumer = yield* Stream.runCollect(
            Stream.take(Stream.tap(fast, () => Queue.offer(received, undefined)), 3)
          )
            .pipe(Effect.forkChild({ startImmediately: true }))

          for (const path of ["/a", "/b", "/c"]) {
            yield* caller.mkdir(path)
            yield* Queue.take(received)
          }

          assert.deepEqual(Array.from(yield* Stream.runCollect(Stream.take(slow, 2)), (event) => event._tag), [
            "Create",
            "Rescan"
          ])
          assert.deepEqual(Array.from(yield* Fiber.join(consumer), (event) => event._tag), [
            "Create",
            "Create",
            "Create"
          ])
        }))
      }).pipe(Effect.provide(store.layer))
    })

    it.effect("should reopen omitted capacity limits using their effective defaults", () => {
      const store = storedImages()
      const defaults = { maxImageBytes: MAX_IMAGE_BYTES, volume: {} }

      return Effect.gen(function*() {
        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open(defaults)
          yield* (yield* volume.caller()).mkdir("/saved")
        }))
        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open(defaults)
          assert.strictEqual((yield* (yield* volume.caller()).stat("/saved")).kind, "directory")
        }))
      }).pipe(Effect.provide(store.layer))
    })

    it.effect("should compare capacity quantities and reject each capacity or identity mismatch", () => {
      const store = storedImages()
      const identity = Vfs.VolumeIdentity.make("0123456789abcdef0123456789abcdef")
      const original = { ...options, volume: { ...options.volume, identity } }

      return Effect.gen(function*() {
        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open(original)
          yield* (yield* volume.caller()).mkdir("/saved")
        }))
        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open({
            ...original,
            volume: { ...original.volume, maxBytes: ByteSize.bytes(32000) }
          })

          assert.strictEqual((yield* (yield* volume.caller()).stat("/saved")).kind, "directory")
        }))

        for (
          const changed of [
            { maxEntries: 101 },
            { maxBytes: ByteSize.bytes(32001) },
            { maxFileBytes: ByteSize.bytes(16001) },
            { maxPathBytes: ByteSize.bytes(1025) },
            { identity: Vfs.VolumeIdentity.make("ffffffffffffffffffffffffffffffff") }
          ]
        ) {
          const error = yield* Effect.scoped(
            Effect.flip(LiveVolume.open({ ...original, volume: { ...original.volume, ...changed } }))
          )

          assert.strictEqual(error.code, "IncompatibleStore")
          assert.strictEqual(error.operation, "LiveVolume.open")
        }
      }).pipe(Effect.provide(store.layer))
    })

    it.effect("should retain runtime defaults through the public four-argument image API", () =>
      Effect.gen(function*() {
        const session = yield* LiveVolume.openImage(
          yield* LiveVolume.prepareEmptyImage(),
          MAX_IMAGE_BYTES,
          () => Effect.succeed("committed"),
          "memory-only"
        )

        assert.strictEqual(session.volume.limits.maxPendingOperations, 64)
        assert.strictEqual(session.volume.limits.maxWatchEvents, 256)
        yield* session.shutdown
      }))
  })
})

describe("live commit", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should reject an oversized candidate without stopping the volume when the image limit is reached",
      () =>
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
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("reports the committed overwrite length when its input grows before storage acknowledges it", () =>
      Effect.gen(function*() {
        const { caller, pauseNext } = yield* pausable
        const handle = yield* caller.open("/file", { access: "readWrite", create: "exclusive" })
        yield* handle.write(bytes(1, 2, 3))
        const buffer = new ArrayBuffer(1, { maxByteLength: 3 })
        const input = new Uint8Array(buffer)
        input[0] = 9
        const { entered, release } = yield* pauseNext
        const writing = yield* handle.pwrite(input, 0n).pipe(Effect.forkChild({ startImmediately: true }))
        yield* entered
        buffer.resize(3)
        yield* release
        assert.strictEqual(yield* Fiber.join(writing), 1)
        assert.deepStrictEqual(yield* caller.readFile("/file"), bytes(9, 2, 3))
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
  })

  it.layer(BunCrypto.layer)((it) => {
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
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should show the original paths when a waiting rename commit is rejected",
      () =>
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
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should preserve identity and revisions when a rename commit is rejected",
      () =>
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
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
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
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should commit one refresh when two due reads wait behind the same change",
      () =>
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
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should avoid a commit when a change leaves state unchanged", () =>
      Effect.gen(function*() {
        const { caller, commits } = yield* answering(Effect.succeed("committed" as const))
        const file = yield* caller.open("/f", { access: "readWrite", create: "exclusive" })
        const before = commits()

        assert.strictEqual(yield* file.write(bytes()), 0)
        yield* caller.setattr("/f", {})
        assert.strictEqual(commits() - before, 0)
      }).pipe(Effect.scoped))
  })

  it.layer(BunCrypto.layer)((it) => {
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
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should read the committed state when an observation waits behind a commit",
      () =>
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
        })
    )
  })
})

describe("registry", () => {
  const options = {
    maxImageBytes: ByteSize.kilobytes(64),
    volume: { maxBytes: ByteSize.kilobytes(32), maxFileBytes: ByteSize.kilobytes(16) }
  }

  const stores = () => {
    const images = new Map<string, Uint8Array>()
    const active = new Set<string>()
    let opened = 0
    let closed = 0

    const layer = (key: string) =>
      Layer.effect(
        LiveVolume.LiveImageStore,
        Effect.gen(function*() {
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              assert.isFalse(active.has(key), "a store must have only one owner")
              active.add(key)
              opened++
            }),
            () =>
              Effect.sync(() => {
                active.delete(key)
                closed++
              })
          )

          return LiveVolume.LiveImageStore.of({
            loadOrCreate: (initial) => Effect.sync(() => images.get(key) ?? initial),
            commit: (image) =>
              Effect.sync(() => {
                images.set(key, new Uint8Array(image))

                return "committed" as const
              })
          })
        })
      )

    return { layer, active, images, opened: () => opened, closed: () => closed }
  }

  describe("live volume registry", () => {
    it.layer(BunCrypto.layer)((it) => {
      for (const idleTimeToLive of [0, 10]) {
        it.effect(`waits for store cleanup before reopening with idle duration ${idleTimeToLive}`, () =>
          Effect.gen(function*() {
            const closing = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            let opened = 0
            const fixture = stores()

            const registry = yield* LiveVolume.makeRegistry({
              volume: options,
              idleTimeToLive,
              store: (key: string) =>
                Layer.effect(
                  LiveVolume.LiveImageStore,
                  Effect.gen(function*() {
                    yield* Effect.acquireRelease(
                      Effect.sync(() => {
                        opened++
                      }),
                      () =>
                        opened === 1
                          ? Deferred.succeed(closing, undefined).pipe(Effect.andThen(Deferred.await(release)))
                          : Effect.void
                    )

                    return yield* LiveVolume.LiveImageStore.pipe(Effect.provide(fixture.layer(key)))
                  })
                )
            })

            const first = yield* Scope.make()
            yield* registry.get("a").pipe(Effect.provideService(Scope.Scope, first))
            const close = yield* Scope.close(first, Exit.void).pipe(Effect.forkChild)

            if (idleTimeToLive > 0) yield* TestClock.adjust(idleTimeToLive)
            yield* Deferred.await(closing)
            const abandoned = yield* registry.get("a").pipe(Effect.forkChild)
            yield* Effect.yieldNow
            yield* Fiber.interrupt(abandoned)
            const second = yield* registry.get("a").pipe(Effect.forkChild)
            yield* Effect.yieldNow
            const openedWhileRetiring = opened
            // A retiring key must not block unrelated stores.
            yield* registry.get("b")
            const openedWithOtherKey = opened
            yield* Deferred.succeed(release, undefined)
            yield* Fiber.join(close)
            yield* Fiber.join(second)
            assert.strictEqual(openedWhileRetiring, 1)
            assert.strictEqual(openedWithOtherKey, 2)
            assert.strictEqual(opened, 3)
          }))
      }

      for (const capacity of [0, -1, 1.5, NaN, Infinity]) {
        it.effect(`rejects capacity ${capacity} before acquiring storage`, () =>
          Effect.gen(function*() {
            const fixture = stores()

            const error = yield* Effect.flip(
              LiveVolume.makeRegistry({ store: fixture.layer, volume: options, capacity })
            )

            assert.strictEqual(error.code, "InvalidArgument")
            assert.strictEqual(error.operation, "LiveVolume.makeRegistry")
            assert.strictEqual(error.field, "capacity")
            assert.strictEqual(fixture.opened(), 0)
          }))
      }

      it.effect("rejects an invalid idle duration as a typed argument failure", () =>
        Effect.gen(function*() {
          const fixture = stores()

          const error = yield* Effect.flip(LiveVolume.makeRegistry({
            store: fixture.layer,
            volume: options,
            // @ts-expect-error Exercise an invalid value supplied by an untyped caller.
            idleTimeToLive: "invalid"
          }))

          assert.strictEqual(error.code, "InvalidArgument")
          assert.strictEqual(error.field, "idleTimeToLive")
          assert.strictEqual(fixture.opened(), 0)
        }))

      it.effect("captures the same volume configuration for every key when the registry is created", () =>
        Effect.gen(function*() {
          const fixture = stores()
          const volume = { ...options.volume, maxEntries: 1 }
          const registry = yield* LiveVolume.makeRegistry({ store: fixture.layer, volume: { ...options, volume } })
          volume.maxEntries = 10

          for (const key of ["a", "b"]) {
            const caller = yield* (yield* registry.get(key)).caller()
            yield* caller.mkdir("/first")
            assert.strictEqual((yield* Effect.flip(caller.mkdir("/second"))).code, "NoSpace")
          }
        }))

      it.effect("builds independent store state even when its Layer is already provided by the parent", () => {
        let built = 0
        let closed = 0

        const sharedLayer = Layer.effect(
          LiveVolume.LiveImageStore,
          Effect.gen(function*() {
            let image: Uint8Array | undefined
            yield* Effect.acquireRelease(Effect.sync(() => built++), () => Effect.sync(() => closed++))

            return LiveVolume.LiveImageStore.of({
              loadOrCreate: (initial) => Effect.sync(() => image ?? initial),
              commit: (candidate) =>
                Effect.sync(() => {
                  image = new Uint8Array(candidate)

                  return "committed" as const
                })
            })
          })
        )

        return Effect.gen(function*() {
          const registry = yield* LiveVolume.makeRegistry({ store: (_key: string) => sharedLayer, volume: options })
          const aScope = yield* Scope.make()
          const a = yield* registry.get("a").pipe(Effect.provideService(Scope.Scope, aScope))
          const b = yield* registry.get("b")
          const callerA = yield* a.caller()
          yield* callerA.mkdir("/only-a")
          assert.strictEqual((yield* Effect.flip((yield* b.caller()).stat("/only-a"))).code, "NotFound")
          assert.strictEqual(built, 3)
          yield* Scope.close(aScope, Exit.void)
          assert.strictEqual(closed, 1)
          yield* b.snapshot
        }).pipe(Effect.provide(sharedLayer))
      })

      it.effect("shares one acquisition while concurrent borrowers wait for storage", () =>
        Effect.gen(function*() {
          const entered = yield* Deferred.make<void>()
          const proceed = yield* Deferred.make<void>()
          const fixture = stores()

          const registry = yield* LiveVolume.makeRegistry({
            volume: options,
            store: (key: string) =>
              fixture.layer(key).pipe(
                Layer.tap(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(proceed))))
              )
          })

          const a = yield* Scope.make()
          const b = yield* Scope.make()
          const first = yield* registry.get("a").pipe(Effect.provideService(Scope.Scope, a), Effect.forkChild)
          yield* Deferred.await(entered)
          const second = yield* registry.get("a").pipe(Effect.provideService(Scope.Scope, b), Effect.forkChild)
          yield* Deferred.succeed(proceed, undefined)
          const volume = yield* Fiber.join(first)
          assert.strictEqual(yield* Fiber.join(second), volume)
          assert.strictEqual(fixture.opened(), 1)
          yield* Scope.close(a, Exit.void)
          assert.strictEqual(fixture.closed(), 0)
          yield* (yield* volume.caller()).mkdir("/still-open")
          yield* Scope.close(b, Exit.void)
          assert.strictEqual(fixture.closed(), 1)
          assert.strictEqual((yield* Effect.flip(volume.snapshot)).code, "VolumeUnavailable")
        }))

      it.effect("reopens committed content after the final borrower releases storage", () =>
        Effect.gen(function*() {
          const fixture = stores()
          const registry = yield* LiveVolume.makeRegistry({ store: fixture.layer, volume: options })

          const first = yield* Effect.scoped(Effect.gen(function*() {
            const volume = yield* registry.get("a")
            yield* (yield* volume.caller()).writeFile("/saved", new Uint8Array([4, 5]), {
              access: "write",
              create: "exclusive"
            })

            return volume
          }))

          assert.strictEqual(fixture.closed(), 1)
          yield* Effect.scoped(Effect.gen(function*() {
            const second = yield* registry.get("a")
            assert.notStrictEqual(second, first)
            assert.deepStrictEqual(yield* (yield* second.caller()).readFile("/saved"), new Uint8Array([4, 5]))
          }))
          assert.strictEqual(fixture.opened(), 2)
          assert.strictEqual(fixture.closed(), 2)
        }))

      it.effect("keeps different storage keys isolated", () =>
        Effect.gen(function*() {
          const fixture = stores()
          const registry = yield* LiveVolume.makeRegistry({ store: fixture.layer, volume: options })
          const a = yield* registry.get("a")
          const b = yield* registry.get("b")
          assert.notStrictEqual(a, b)
          yield* (yield* a.caller()).mkdir("/only-a")
          assert.strictEqual((yield* Effect.flip((yield* b.caller()).stat("/only-a"))).code, "NotFound")
          assert.deepStrictEqual([...fixture.active].sort(), ["a", "b"])
        }))

      it.effect("reuses an idle volume until its timeout and then closes storage", () =>
        Effect.gen(function*() {
          const fixture = stores()

          const registry = yield* LiveVolume.makeRegistry({
            store: fixture.layer,
            volume: options,
            idleTimeToLive: "1 second"
          })

          const first = yield* Effect.scoped(registry.get("a"))
          yield* TestClock.adjust("500 millis")
          assert.strictEqual(yield* Effect.scoped(registry.get("a")), first)
          yield* TestClock.adjust("600 millis")
          assert.strictEqual(fixture.closed(), 0)
          yield* TestClock.adjust("400 millis")
          assert.strictEqual(fixture.closed(), 1)
          const second = yield* registry.get("a")
          assert.notStrictEqual(second, first)
        }))

      it.effect("counts distinct and idle volumes toward capacity without closing active borrowers", () =>
        Effect.gen(function*() {
          const fixture = stores()

          const registry = yield* LiveVolume.makeRegistry({
            store: fixture.layer,
            volume: options,
            capacity: 1,
            idleTimeToLive: "1 second"
          })

          const a = yield* Effect.scoped(registry.get("a"))
          const error = yield* Effect.flip(registry.get("b"))
          assert.strictEqual(error._tag, "ExceededCapacityError")
          assert.strictEqual(yield* Effect.scoped(registry.get("a")), a)
          yield* TestClock.adjust("1 second")
          yield* registry.get("b")
          assert.deepStrictEqual([...fixture.active], ["b"])
        }))

      it.effect("releases a failed acquisition and permits a later retry", () =>
        Effect.gen(function*() {
          const fixture = stores()
          let attempts = 0

          const registry = yield* LiveVolume.makeRegistry({
            volume: options,
            store: (key: string) =>
              fixture.layer(key).pipe(
                Layer.tap(() => Effect.suspend(() => ++attempts === 1 ? Effect.fail("opening failed") : Effect.void))
              )
          })

          assert.strictEqual(yield* Effect.scoped(Effect.flip(registry.get("a"))), "opening failed")
          assert.strictEqual(fixture.closed(), 1)
          yield* registry.get("a")
          assert.strictEqual(attempts, 2)
        }))

      it.effect("keeps a shared acquisition alive when one waiting borrower is interrupted", () =>
        Effect.gen(function*() {
          const entered = yield* Deferred.make<void>()
          const proceed = yield* Deferred.make<void>()
          const fixture = stores()

          const registry = yield* LiveVolume.makeRegistry({
            volume: options,
            store: (key: string) =>
              fixture.layer(key).pipe(
                Layer.tap(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(proceed))))
              )
          })

          const retained = yield* Scope.make()
          const first = yield* registry.get("a").pipe(Effect.provideService(Scope.Scope, retained), Effect.forkChild)
          yield* Deferred.await(entered)
          const cancelled = yield* Effect.scoped(registry.get("a")).pipe(Effect.forkChild)
          yield* Fiber.interrupt(cancelled)
          yield* Deferred.succeed(proceed, undefined)
          yield* (yield* Fiber.join(first)).snapshot
          assert.strictEqual(fixture.closed(), 0)
          yield* Scope.close(retained, Exit.void)
          assert.strictEqual(fixture.closed(), 1)
        }))

      it.effect("releases storage when opening a corrupt image fails", () =>
        Effect.gen(function*() {
          const fixture = stores()
          fixture.images.set("a", new Uint8Array([255]))
          const registry = yield* LiveVolume.makeRegistry({ store: fixture.layer, volume: options })
          const error = yield* Effect.scoped(Effect.flip(registry.get("a")))
          assert.strictEqual("code" in error ? error.code : error._tag, "CorruptStore")
          assert.strictEqual(fixture.closed(), 1)
          fixture.images.delete("a")
          yield* registry.get("a")
          assert.strictEqual(fixture.opened(), 2)
        }))

      it.effect("shuts down the volume before storage even when its owner closes with a borrower alive", () =>
        Effect.gen(function*() {
          let volume: Vfs.Volume | undefined
          let shutdownObserved = false
          const fixture = stores()
          const owner = yield* Scope.make()
          const borrower = yield* Scope.make()

          const registry = yield* LiveVolume.makeRegistry({
            volume: options,
            store: (key: string) =>
              fixture.layer(key).pipe(Layer.tap(() =>
                Effect.addFinalizer(() =>
                  Effect.gen(function*() {
                    assert.strictEqual(
                      (yield* Effect.flip(volume!.snapshot).pipe(Effect.orDie)).code,
                      "VolumeUnavailable"
                    )
                    shutdownObserved = true
                  })
                )
              ))
          }).pipe(Effect.provideService(Scope.Scope, owner))

          volume = yield* registry.get("a").pipe(Effect.provideService(Scope.Scope, borrower))
          yield* Scope.close(owner, Exit.void)
          assert.isTrue(shutdownObserved)
          assert.strictEqual(fixture.closed(), 1)
          const exit = yield* Effect.exit(registry.get("a"))
          assert.isTrue(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))
          yield* Scope.close(borrower, Exit.void)
          assert.strictEqual(fixture.closed(), 1)
        }))

      it.effect("closes storage when the sole borrower cancels an unfinished acquisition", () =>
        Effect.gen(function*() {
          const entered = yield* Deferred.make<void>()
          const proceed = yield* Deferred.make<void>()
          const fixture = stores()

          const registry = yield* LiveVolume.makeRegistry({
            volume: options,
            store: (key: string) =>
              fixture.layer(key).pipe(
                Layer.tap(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(proceed))))
              )
          })

          const opening = yield* Effect.scoped(registry.get("a")).pipe(Effect.forkChild)
          yield* Deferred.await(entered)
          yield* Fiber.interrupt(opening)
          assert.strictEqual(fixture.closed(), 1)
          assert.strictEqual(fixture.active.size, 0)
          yield* Deferred.succeed(proceed, undefined)
          yield* registry.get("a")
          assert.strictEqual(fixture.opened(), 2)
        }))

      it.effect("keeps handles independent and reclaims unlinked content only after both close", () =>
        Effect.gen(function*() {
          const fixture = stores()
          const registry = yield* LiveVolume.makeRegistry({ store: fixture.layer, volume: options })
          const volume = yield* registry.get("a")
          const a = yield* (yield* volume.caller()).open("/file", { access: "readWrite", create: "exclusive" })
          yield* a.write(new Uint8Array([7, 8]))
          const other = yield* registry.get("a")
          const caller = yield* other.caller()
          const b = yield* caller.open("/file", { access: "read" })
          assert.deepStrictEqual(yield* b.read(1), new Uint8Array([7]))
          assert.strictEqual(yield* a.seek(0n, "current"), 2n)
          yield* caller.unlink("/file")
          assert.deepStrictEqual(yield* volume.usage, { usedBytes: 2n, entries: 0 })
          yield* a.close
          assert.deepStrictEqual(yield* volume.usage, { usedBytes: 2n, entries: 0 })
          assert.deepStrictEqual(yield* b.read(1), new Uint8Array([8]))
          yield* b.close
          assert.deepStrictEqual(yield* volume.usage, { usedBytes: 0n, entries: 0 })
          assert.strictEqual((yield* Effect.flip(b.read(1))).code, "InvalidHandle")
        }))
    })
  })
})

describe("storage images", () => {
  const BOUND = ByteSize.kilobytes(64)

  const LIMITS = { maxEntries: 50, maxBytes: ByteSize.kilobytes(8), maxPathBytes: ByteSize.bytes(64) }

  // Every image a volume opened from `initial` commits, newest last.
  const committing = Effect.fnUntraced(function*(initial: Uint8Array) {
    const images = [initial]

    const session = yield* LiveVolume.openImage(initial, BOUND, (bytes) =>
      Effect.sync(() => {
        images.push(new Uint8Array(bytes))

        return "committed" as const
      }))

    return { session, images }
  })

  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

  const runtimeFields = (image: Uint8Array): { readonly epoch: string; readonly keySecret: string } =>
    JSON.parse(text(image).split("\n")[0]!).runtime

  const edited = (image: Uint8Array, from: string, to: string) => {
    const source = text(image)
    assert.include(source, from)

    return new TextEncoder().encode(source.replace(from, to))
  }

  const open = (image: Uint8Array, bound = BOUND) =>
    LiveVolume.openImage(image, bound, () => Effect.succeed("committed"))

  const failure = (image: Uint8Array) =>
    Effect.map(Effect.flip(open(image)), (error) => [error.code, error.field] as const)

  describe("live image compatibility", () => {
    // Captured from the version 1 encoder before the direct empty-state refactor.
    const legacy = new TextEncoder().encode(
      "{\"format\":\"effect-vfs-live\",\"version\":1,\"runtime\":{\"identity\":\"0123456789abcdef0123456789abcdef\",\"epoch\":\"de369d4cca173d6066a0185f7e1284fe\",\"keySecret\":\"f8b0cbdf68fb9c18a79531b05811090b\",\"nextInode\":2,\"revision\":\"1\",\"limits\":{\"maxFileBytes\":\"4294967295\"},\"usage\":{\"entries\":0,\"usedBytes\":\"0\"}}}\n" +
        "{\"_tag\":\"directory\",\"ino\":1,\"parent\":1,\"name\":\"\",\"metadata\":{\"uid\":0,\"gid\":0,\"mode\":493,\"atimeNs\":\"1790851950589000000\",\"mtimeNs\":\"1790851950589000000\",\"ctimeNs\":\"1790851950589000000\",\"birthtimeNs\":\"1790851950589000000\"},\"rev\":\"1\"}\n"
    )

    it.layer(BunCrypto.layer)((it) => {
      const constructors = [
        ["memory volume", (options: Vfs.VolumeOptions) => Effect.map(Vfs.make(options), (volume) => volume.identity)],
        ["empty image", (options: Vfs.VolumeOptions) =>
          LiveVolume.prepareEmptyImage(options).pipe(
            Effect.flatMap((image) => open(image)),
            Effect.map((restored) => restored.volume.identity)
          )],
        [
          "durable volume",
          (options: Vfs.VolumeOptions) =>
            LiveVolume.open({ maxImageBytes: BOUND, volume: options }).pipe(
              Effect.map((volume) => volume.identity),
              Effect.provideService(LiveVolume.LiveImageStore, {
                loadOrCreate: Effect.succeed,
                commit: () => Effect.succeed("committed")
              })
            )
        ]
      ] as const

      for (const [name, construct] of constructors) {
        it.effect(`should retain the validated identity when constructing ${name} from changing options`, () =>
          Effect.gen(function*() {
            const identity = Vfs.VolumeIdentity.make("0123456789abcdef0123456789abcdef")
            let reads = 0

            const options = Object.defineProperty({}, "identity", {
              enumerable: true,
              get: () => ++reads === 1 ? identity : "invalid"
            })

            assert.strictEqual(yield* construct(options), identity)
            assert.strictEqual(reads, 1)
          }))

        it.effect(`should reject an initially invalid identity when constructing ${name} from changing options`, () =>
          Effect.gen(function*() {
            let reads = 0

            const options = Object.defineProperty({}, "identity", {
              enumerable: true,
              get: () => ++reads === 1 ? "invalid" : "0123456789abcdef0123456789abcdef"
            })

            const error = yield* Effect.flip(construct(options))

            assert.strictEqual(error.code, "InvalidArgument")
            assert.strictEqual(error.field, name === "durable volume" ? "volume.identity" : "identity")
          }))
      }

      it.effect("should reopen an existing version 1 document with its naming and root metadata intact", () =>
        Effect.gen(function*() {
          const session = yield* LiveVolume.openImage(legacy, BOUND, () => Effect.succeed("committed"))
          assert.strictEqual(session.volume.identity, "0123456789abcdef0123456789abcdef")
          const root = yield* (yield* session.volume.caller()).stat("/")
          assert.deepEqual([root.uid, root.gid, root.mode, root.birthtimeNs], [0, 0, 0o755, 1790851950589000000n])
          yield* session.shutdown
        }))

      it.effect("should reject version 1 capacity values that exceed the supported file size", () =>
        Effect.gen(function*() {
          const error = yield* Effect.flip(LiveVolume.openImage(
            edited(legacy, "\"maxFileBytes\":\"4294967295\"", "\"maxFileBytes\":\"4294967296\""),
            BOUND,
            () => Effect.succeed("committed")
          ))

          assert.deepEqual([error.code, error.field], ["InvalidArgument", "maxFileBytes"])
        }))

      it.effect("should attribute an unsupported clock sample to empty-image preparation", () =>
        Effect.gen(function*() {
          const original = yield* Clock.clockWith(Effect.succeed)
          const now = () => 10n ** 128n

          const clock: Clock.Clock = {
            currentTimeMillisUnsafe: () => original.currentTimeMillisUnsafe(),
            currentTimeMillis: original.currentTimeMillis,
            currentTimeNanosUnsafe: now,
            currentTimeNanos: Effect.sync(now),
            monotonicTimeNanosUnsafe: () => original.monotonicTimeNanosUnsafe(),
            monotonicTimeNanos: original.monotonicTimeNanos,
            sleep: (duration) => original.sleep(duration)
          }

          const error = yield* Effect.flip(
            LiveVolume.prepareEmptyImage().pipe(Effect.provideService(Clock.Clock, clock))
          )

          assert.deepEqual([error.code, error.operation, error.field], [
            "InvalidArgument",
            "LiveVolume.prepareEmptyImage",
            "clock.currentTimeNanos"
          ])
        }))

      it.effect("should prepare an empty root at the current time and attribute invalid options to preparation", () =>
        Effect.gen(function*() {
          yield* TestClock.setTime(1234)

          const image = yield* LiveVolume.prepareEmptyImage({
            identity: Vfs.VolumeIdentity.make("0123456789abcdef0123456789abcdef"),
            ...LIMITS
          })

          const session = yield* LiveVolume.openImage(image, BOUND, () => Effect.succeed("committed"))
          const root = yield* (yield* session.volume.caller()).stat("/")
          assert.strictEqual(session.volume.identity, "0123456789abcdef0123456789abcdef")
          assert.deepEqual(
            [root.uid, root.gid, root.mode, root.atimeNs, root.mtimeNs, root.ctimeNs, root.birthtimeNs],
            [
              0,
              0,
              0o755,
              1_234_000_000n,
              1_234_000_000n,
              1_234_000_000n,
              1_234_000_000n
            ]
          )
          assert.deepEqual(yield* session.volume.usage, { entries: 0, usedBytes: 0n })
          const error = yield* Effect.flip(LiveVolume.prepareEmptyImage({ maxPendingOperations: 0 }))
          assert.deepEqual([error.code, error.operation, error.field], [
            "InvalidArgument",
            "LiveVolume.prepareEmptyImage",
            "maxPendingOperations"
          ])
          yield* session.shutdown
        }))
    })

    // Reopening reclaims unlinked files a handle held, so only an image without any re-encodes unchanged.
    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "restores raw names, hard links, symbolic links and modes from committed bytes",
        () =>
          Effect.scoped(Effect.gen(function*() {
            const { session, images } = yield* committing(yield* LiveVolume.prepareEmptyImage(LIMITS))
            const caller = yield* session.volume.caller()
            const raw = yield* Vfs.pathFromBytes(new Uint8Array([47, 0xff]))
            yield* caller.mkdir("/d")
            yield* caller.writeFile("/d/f", new Uint8Array([1, 2, 3]), { access: "write", create: "exclusive" })
            yield* caller.link("/d/f", raw)
            yield* caller.symlink("d/f", "/s")
            yield* caller.rename("/d/f", "/d/g")
            yield* caller.chmod("/d", 0o700)

            const image = images.at(-1)!

            const reopened = yield* open(image)
            const reader = yield* reopened.volume.caller()
            assert.deepStrictEqual(yield* reader.readFile(raw), Uint8Array.of(1, 2, 3))
            assert.strictEqual((yield* reader.stat(raw)).ino, (yield* reader.stat("/d/g")).ino)
            assert.strictEqual((yield* reader.stat("/d")).mode, 0o700)
            assert.deepStrictEqual(yield* reader.readLink("/s"), new TextEncoder().encode("d/f"))
            yield* reopened.shutdown
            yield* session.shutdown
          }))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should reject an image when its encoded bytes exceed the bound", () =>
        Effect.gen(function*() {
          const image = yield* LiveVolume.prepareEmptyImage()
          assert.strictEqual(
            (yield* Effect.flip(open(image, ByteSize.bytes(image.length - 1)))).code,
            "LimitExceeded"
          )
        }))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should report InvalidStructure when a live image document is incomplete",
        () =>
          Effect.gen(function*() {
            assert.deepStrictEqual(
              yield* failure(new TextEncoder().encode("{\"format\":\"effect-vfs-live\",\"version\":2}\n")),
              ["InvalidStructure", "liveImage"]
            )
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should report InvalidEncoding when live image bytes are not UTF-8", () =>
        Effect.gen(function*() {
          assert.deepStrictEqual(yield* failure(new Uint8Array([0xff])), ["InvalidEncoding", "liveImage"])
        }))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should reject an image when its inode allocator exceeds the largest safe integer",
        () =>
          Effect.gen(function*() {
            const image = yield* LiveVolume.prepareEmptyImage()
            const atLimit = edited(image, "\"nextInode\":2,", `"nextInode":${Number.MAX_SAFE_INTEGER},`)
            const pastLimit = edited(image, "\"nextInode\":2,", `"nextInode":${Number.MAX_SAFE_INTEGER + 1},`)

            const session = yield* open(atLimit)
            yield* session.shutdown
            assert.deepStrictEqual(yield* failure(pastLimit), ["InvalidStructure", "liveImage"])
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should name the invalid field when runtime state contradicts image nodes",
        () =>
          Effect.gen(function*() {
            const image = yield* LiveVolume.prepareEmptyImage(LIMITS)

            for (
              const [from, to, field] of [
                ["\"entries\":0", "\"entries\":1", "runtime.usage.entries"],
                ["\"usedBytes\":\"0\"", "\"usedBytes\":\"1\"", "runtime.usage.usedBytes"],
                ["\"revision\":\"1\"", "\"revision\":\"0\"", "runtime.revision"],
                ["\"rev\":\"1\"", "\"rev\":\"2\"", "nodes.0.rev"],
                ["\"nextInode\":2,", "\"nextInode\":1,", "liveImage"],
                ["\"parent\":1,", "\"parent\":2,", "nodes.0"]
              ] as const
            ) assert.deepStrictEqual(yield* failure(edited(image, from, to)), ["InvalidStructure", field], field)
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("resolves a reference key issued before the image committed after reopening", () =>
        Effect.gen(function*() {
          const { session, images } = yield* committing(yield* LiveVolume.prepareEmptyImage(LIMITS))
          const caller = yield* session.volume.caller()
          const key = yield* session.volume.referenceKey(yield* caller.root)
          yield* caller.mkdir("/d")
          yield* session.shutdown

          const reopened = yield* open(images.at(-1)!)
          const reader = yield* reopened.volume.caller()
          assert.strictEqual(yield* reopened.volume.resolveReferenceKey(key), yield* reader.root)
          assert.strictEqual((yield* reader.stat("/d")).kind, "directory")
          yield* reopened.shutdown
        }))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should reject malformed runtime secrets when decoding a committed image",
        () =>
          Effect.gen(function*() {
            const { session, images } = yield* committing(yield* LiveVolume.prepareEmptyImage(LIMITS))
            yield* (yield* session.volume.caller()).mkdir("/d")
            const committed = images.at(-1)!
            const { epoch, keySecret } = runtimeFields(images[0]!)

            for (const [field, value] of [["epoch", epoch], ["keySecret", keySecret]] as const) {
              assert.deepStrictEqual(
                yield* failure(edited(committed, `"${field}":"${value}"`, `"${field}":"${value.toUpperCase()}"`)),
                ["InvalidStructure", "liveImage"],
                field
              )
            }

            yield* session.shutdown
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should reclaim unlinked files but reject unlinked symlinks when reopening an image",
        () =>
          Effect.scoped(Effect.gen(function*() {
            const { session, images } = yield* committing(yield* LiveVolume.prepareEmptyImage(LIMITS))
            const caller = yield* session.volume.caller()
            yield* caller.symlink("target", "/s")
            const held = yield* caller.open("/f", { access: "write", create: "exclusive" })
            yield* held.write(new Uint8Array([7]))
            yield* caller.unlink("/f")
            const image = images.at(-1)!

            const reopened = yield* open(image)
            assert.strictEqual((yield* reopened.volume.usage).usedBytes, 6n)
            yield* reopened.shutdown
            assert.include(text(image), "\"usedBytes\":\"7\"")

            const [code, field] = yield* failure(
              edited(image, "\"links\":[{\"parent\":1,\"name\":\"cw==\"}]", "\"links\":[]")
            )

            assert.strictEqual(code, "InvalidStructure")
            assert.match(field ?? "", /^nodes\.\d+\.links$/)
            yield* held.close
            yield* session.shutdown
          }))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should reject a stored path when it exceeds the volume path limit", () =>
        Effect.gen(function*() {
          const { session, images } = yield* committing(yield* LiveVolume.prepareEmptyImage(LIMITS))
          const caller = yield* session.volume.caller()
          yield* caller.mkdir("/abc")
          yield* caller.writeFile("/abc/de", new Uint8Array(), { access: "write", create: "exclusive" })
          const image = images.at(-1)!

          // "/abc/de" is seven bytes; the tightest limit that holds it is seven.
          const reopened = yield* open(edited(image, "\"maxPathBytes\":\"64\"", "\"maxPathBytes\":\"7\""))
          yield* reopened.shutdown
          const [code, field] = yield* failure(edited(image, "\"maxPathBytes\":\"64\"", "\"maxPathBytes\":\"6\""))
          assert.strictEqual(code, "InvalidStructure")
          assert.match(field ?? "", /^nodes\.\d+\.links\.0\.name$/)
          yield* session.shutdown
        }))
    })
  })

  const live = Effect.fnUntraced(function*(commit: Parameters<typeof LiveVolume.openImage>[2]) {
    const session = yield* LiveVolume.openImage(yield* LiveVolume.prepareEmptyImage(), BOUND, commit)
    yield* Effect.addFinalizer(() => session.shutdown)

    return session
  })

  // Smaller budgets livelock the runtime: it counts an op before checking whether to yield.
  const MIN_OP_BUDGET = 3

  // Comfortably past the yields an mkdir needs to commit at MIN_OP_BUDGET (about 43).
  const MAX_INTERRUPT_DELAY = 128

  describe("live mutation and cleanup", () => {
    it.layer(BunCrypto.layer)((it) => {
      it.effect("should offer directory reclamation once when a detached directory scope closes", () =>
        Effect.gen(function*() {
          let commits = 0

          const { volume } = yield* live(() =>
            Effect.sync(() => {
              commits++

              return "committed" as const
            })
          )

          const caller = yield* volume.caller()
          yield* caller.mkdir("/directory")
          const scope = yield* Scope.make()
          const directory = yield* caller.openDirectory("/directory").pipe(Scope.provide(scope))
          const inode = (yield* directory.stat).ino
          yield* caller.rmdir("/directory")
          assert.strictEqual((yield* directory.stat).ino, inode)
          const before = commits
          yield* Scope.close(scope, Exit.void)
          assert.strictEqual(commits - before, 1)
          assert.strictEqual((yield* Effect.flip(directory.stat)).code, "InvalidHandle")
          assert.deepEqual(yield* volume.usage, { entries: 0, usedBytes: 0n })
          yield* caller.mkdir("/after")
          assert.strictEqual((yield* caller.stat("/after")).kind, "directory")
        }))

      it.effect("should close a detached directory and disable access when its cleanup commit is rejected", () =>
        Effect.gen(function*() {
          let reject = false
          let commits = 0

          const { volume } = yield* live(() =>
            Effect.sync(() => {
              commits++

              return reject ? "rejected" as const : "committed" as const
            })
          )

          const caller = yield* volume.caller()
          yield* caller.mkdir("/directory")
          const scope = yield* Scope.make()
          const directory = yield* caller.openDirectory("/directory").pipe(Scope.provide(scope))
          yield* caller.rmdir("/directory")
          reject = true
          const before = commits
          assert.strictEqual((yield* Effect.flip(directory.close)).code, "StorageRejected")
          assert.strictEqual((yield* Effect.flip(directory.close)).code, "InvalidHandle")
          assert.strictEqual((yield* Effect.flip(caller.stat("/"))).code, "VolumeUnavailable")
          yield* Scope.close(scope, Exit.void)
          assert.strictEqual(commits - before, 1)
        }))

      for (const decision of ["committed", "rejected"] as const) {
        it.effect(`reclaims a detached cwd when the caller closes and storage answers ${decision}`, () =>
          Effect.gen(function*() {
            let closing = false
            let cleanups = 0

            const { volume } = yield* live(() =>
              Effect.sync(() => {
                if (!closing) return "committed" as const
                cleanups++

                return decision
              })
            )

            const admin = yield* volume.caller()
            yield* admin.mkdir("/cwd")
            const scope = yield* Scope.make()
            yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
            yield* admin.withDirectory("/cwd").pipe(Scope.provide(scope))
            yield* admin.rmdir("/cwd")
            closing = true
            yield* Scope.close(scope, Exit.void)
            assert.strictEqual(cleanups, 1)

            if (decision === "rejected") {
              assert.strictEqual((yield* Effect.flip(admin.stat("/"))).code, "VolumeUnavailable")
            } else {
              assert.strictEqual((yield* admin.stat("/")).kind, "directory")
            }
          }))
      }

      const cleanupFailures = [
        ["rejected", Effect.succeed("rejected" as const)],
        ["unknown", Effect.succeed("unknown" as const)]
      ] as const

      for (const [condition, failure] of cleanupFailures) {
        it.effect(`should release handles and disable the volume when cleanup is ${condition}`, () =>
          Effect.gen(function*() {
            let failCleanup = false
            let commits = 0

            const { volume } = yield* live(() =>
              Effect.suspend(() => {
                commits++

                return failCleanup ? failure : Effect.succeed("committed" as const)
              })
            )

            const caller = yield* volume.caller()
            const firstScope = yield* Scope.make()
            const secondScope = yield* Scope.make()

            const first = yield* caller.open("/first", { access: "readWrite", create: "exclusive" })
              .pipe(Scope.provide(firstScope))

            const second = yield* caller.open("/second", { access: "readWrite", create: "exclusive" })
              .pipe(Scope.provide(secondScope))

            yield* first.write(new Uint8Array([1]))
            yield* second.write(new Uint8Array([2]))
            yield* caller.unlink("/first")
            yield* caller.unlink("/second")
            failCleanup = true
            const before = commits
            yield* Scope.close(firstScope, Exit.void)
            assert.strictEqual(commits - before, 1)
            assert.strictEqual((yield* Effect.flip(volume.usage)).code, "VolumeUnavailable")
            assert.strictEqual((yield* Effect.flip(caller.stat("/"))).code, "VolumeUnavailable")
            assert.strictEqual((yield* Effect.flip(volume.watch())).code, "VolumeUnavailable")
            assert.strictEqual((yield* Effect.flip(first.read(1))).code, "VolumeUnavailable")
            yield* Scope.close(secondScope, Exit.void)
            yield* Scope.close(firstScope, Exit.void)
            assert.strictEqual(commits - before, 1)
            assert.strictEqual((yield* Effect.flip(second.read(1))).code, "VolumeUnavailable")
          }))
      }
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should read path options before waiting when a commit is pending", () =>
        Effect.gen(function*() {
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let pause = false

          const { volume } = yield* live(() =>
            pause
              ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as("committed" as const)
              )
              : Effect.succeed("committed" as const)
          )

          const caller = yield* volume.caller()
          yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
          const root = yield* caller.openDirectory("/")
          const reads: Array<string> = []

          // A path target whose base is read lazily, to observe when the operation reads it.
          const target = (label: string) =>
            Vfs.Target.Path({
              path: "/file",
              get relativeTo() {
                reads.push(label)

                return root
              }
            })

          assert.strictEqual((yield* Effect.flip(caller.access(target("invalid"), 8))).code, "InvalidArgument")
          pause = true
          const writer = yield* caller.mkdir("/new").pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(entered)

          const access = yield* caller.access(target("access"), 4).pipe(
            Effect.forkChild({ startImmediately: true })
          )

          const truncate = yield* caller.truncate(target("truncate"), 0n).pipe(
            Effect.forkChild({ startImmediately: true })
          )

          yield* Effect.yieldNow
          assert.deepStrictEqual(reads, ["invalid", "access", "truncate"])
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(writer)
          yield* Fiber.join(access)
          yield* Fiber.join(truncate)
        }))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should stop the volume when final handle cleanup is rejected",
        () =>
          Effect.scoped(Effect.gen(function*() {
            let outcome: "committed" | "rejected" = "committed"

            const { volume } = yield* live(() => Effect.succeed(outcome))

            const caller = yield* volume.caller()
            const handle = yield* caller.open("/file", { access: "readWrite", create: "exclusive" })
            yield* handle.write(new Uint8Array([1]))
            yield* caller.unlink("/file")
            outcome = "rejected"

            assert.strictEqual((yield* Effect.flip(handle.close)).code, "StorageRejected")
            assert.strictEqual((yield* Effect.flip(volume.usage)).code, "VolumeUnavailable")
          }))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should expose no uncommitted change when a staged mutation is interrupted",
        () =>
          Effect.gen(function*() {
            let commits = 0

            const { volume } = yield* live(() =>
              Effect.sync(() => {
                commits++

                return "committed" as const
              })
            )

            const caller = yield* volume.caller()
            const handle = yield* caller.open("/handle", { access: "readWrite", create: "exclusive" })

            const exists = (path: string) =>
              Effect.exit(caller.stat(Vfs.Target.Path({ path: path, followFinalSymlink: false }))).pipe(
                Effect.map(Exit.isSuccess)
              )

            // Path, content, and handle mutations each swap engine state, so each is swept separately.
            const mutations: ReadonlyArray<{
              readonly name: string
              readonly run: (path: string, delay: number) => Effect.Effect<unknown, Vfs.FsFailure>
              readonly visible: (path: string, delay: number) => Effect.Effect<boolean, Vfs.FsFailure>
            }> = [
              { name: "mkdir", run: (path: string) => caller.mkdir(path), visible: exists },
              {
                name: "writeFile",
                run: (path: string) =>
                  caller.writeFile(path, new Uint8Array([1]), { access: "write", create: "exclusive" }),
                visible: exists
              },
              { name: "symlink", run: (path: string) => caller.symlink("/target", path), visible: exists },
              {
                name: "pwrite",
                run: (_path: string, delay: number) => handle.pwrite(new Uint8Array([1]), BigInt(delay)),
                visible: (_path: string, delay: number) =>
                  handle.stat.pipe(Effect.map(({ size }) => size > BigInt(delay)))
              }
            ]

            // A tiny op budget makes the mutation yield often, so sweeping the interrupt point lands it
            // inside the mutation body at some delay.
            for (const mutation of mutations) {
              for (let delay = 0; delay < MAX_INTERRUPT_DELAY; delay++) {
                const before = commits
                const path = `/${mutation.name}-${delay}`

                const fiber = yield* mutation.run(path, delay).pipe(
                  Effect.provideService(Scheduler.MaxOpsBeforeYield, MIN_OP_BUDGET),
                  Effect.forkChild({ startImmediately: true })
                )

                for (let step = 0; step < delay; step++) yield* Effect.yieldNow
                yield* Fiber.interrupt(fiber)

                const visible = yield* mutation.visible(path, delay)
                assert.strictEqual(visible, commits > before, `${mutation.name} interrupted after ${delay} yields`)
              }
            }

            yield* caller.mkdir("/still-available")
            assert.strictEqual((yield* caller.stat("/still-available")).kind, "directory")
          })
      )
    })
  })
})
