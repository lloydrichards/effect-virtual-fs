import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Deferred, Effect, Exit, Fiber, Predicate, Scheduler, Stream } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"
import * as LiveImage from "../src/internal/liveImage.js"
import {
  captureLiveImage,
  makeVolume,
  openImageVolume,
  prepareEmptyLiveImage,
  retainedFiles,
  VolumeSource
} from "../src/internal/virtualFileSystem.js"
import { VolumeIdentity } from "../src/Volume.js"
import { entryNames } from "./support/text.js"

// Smaller budgets livelock the runtime: it counts an op before checking whether to yield.
const MIN_OP_BUDGET = 3

// Comfortably past the yields an mkdir needs to commit at MIN_OP_BUDGET (about 43).
const MAX_INTERRUPT_DELAY = 128

describe("live volume staging", () => {
  it.effect("does not commit when a failed open scope closes", () =>
    Effect.gen(function*() {
      let commits = 0

      const { volume } = yield* makeVolume(VolumeSource.Empty(), undefined, {
        commit: () =>
          Effect.sync(() => {
            commits++

            return "committed" as const
          })
      })

      const caller = yield* volume.caller()

      yield* Effect.scoped(Effect.flip(caller.open("/missing", { access: "read" })))
      assert.strictEqual(commits, 0)
      yield* caller.mkdir("/still-available")
      assert.strictEqual(commits, 1)
    }))

  it.effect("keeps rejected path and handle changes invisible", () =>
    Effect.scoped(Effect.gen(function*() {
      let outcome: "committed" | "rejected" = "committed"
      const { volume } = yield* makeVolume(VolumeSource.Empty(), undefined, { commit: () => Effect.succeed(outcome) })
      const caller = yield* volume.caller()
      const handle = yield* caller.open("/file", { access: "readWrite", create: "exclusive" })
      yield* handle.write(new Uint8Array([1]))
      const before = yield* handle.stat
      const stream = yield* volume.watch
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

  it.effect("stops paths, observations, and watch registration after an unknown outcome", () =>
    Effect.gen(function*() {
      const { volume } = yield* makeVolume(VolumeSource.Empty(), undefined, {
        commit: () => Effect.succeed("unknown" as const)
      })

      const caller = yield* volume.caller()

      assert.strictEqual((yield* Effect.flip(caller.mkdir("/dir"))).code, "OutcomeUnknown")
      assert.strictEqual((yield* Effect.flip(caller.stat("/"))).code, "VolumeUnavailable")
      assert.strictEqual((yield* Effect.flip(volume.usage)).code, "VolumeUnavailable")
      assert.strictEqual((yield* Effect.flip(volume.snapshot)).code, "VolumeUnavailable")
      const callerFailure = yield* Effect.flip(volume.caller())
      assert.strictEqual(callerFailure._tag, "VfsError")

      if (Predicate.isTagged("VfsError")(callerFailure)) {
        assert.strictEqual(callerFailure.code, "VolumeUnavailable")
      }

      assert.strictEqual((yield* Effect.flip(volume.watch)).code, "VolumeUnavailable")
    }))

  it.effect("preserves a reference after rejected unlink and retains its open file after committed unlink", () =>
    Effect.scoped(Effect.gen(function*() {
      let outcome: "committed" | "rejected" = "committed"
      const { volume } = yield* makeVolume(VolumeSource.Empty(), undefined, { commit: () => Effect.succeed(outcome) })
      const caller = yield* volume.caller()
      const handle = yield* caller.open("/file", { access: "readWrite", create: "exclusive" })
      yield* handle.write(new Uint8Array([1]))
      const root = yield* caller.root
      const reference = yield* caller.lookup(Vfs.Entry(root, new TextEncoder().encode("file")))

      outcome = "rejected"
      assert.strictEqual((yield* Effect.flip(caller.unlink("/file"))).code, "StorageRejected")
      outcome = "committed"
      assert.strictEqual((yield* caller.stat(reference)).nlink, 1)
      assert.deepEqual(yield* caller.readFile("/file"), new Uint8Array([1]))

      yield* caller.unlink("/file")
      assert.strictEqual((yield* Effect.flip(caller.open(reference, { access: "read" }))).code, "StaleReference")
      yield* handle.write(new Uint8Array([2]))
      assert.deepEqual((yield* handle.pread(2, 0n)).bytes, new Uint8Array([1, 2]))
      assert.deepEqual(yield* volume.usage, { usedBytes: 2n, entries: 0 })
      yield* handle.close
      assert.deepEqual(yield* volume.usage, { usedBytes: 0n, entries: 0 })
    })))

  it.effect("includes open unlinked files in each candidate until final close", () =>
    Effect.scoped(Effect.gen(function*() {
      const retained = new Array<ReadonlyArray<bigint>>()

      const { volume } = yield* makeVolume(VolumeSource.Empty(), undefined, {
        commit: (candidate) => {
          retained.push(retainedFiles(candidate).map((file) => file.metadata.ino))

          return Effect.succeed("committed" as const)
        }
      })

      const caller = yield* volume.caller()
      const handle = yield* caller.open("/file", { access: "readWrite", create: "exclusive" })
      const inode = (yield* handle.stat).ino

      yield* caller.unlink("/file")
      assert.deepEqual(retained.at(-1), [inode])
      yield* handle.write(new Uint8Array([1]))
      assert.deepEqual(retained.at(-1), [inode])
      yield* handle.close
      assert.deepEqual(retained.at(-1), [])
    })))

  it.effect("captures inode identity and unlinked content in private commit images", () =>
    Effect.scoped(Effect.gen(function*() {
      const images: Array<Uint8Array> = []
      const identity = VolumeIdentity.make("0123456789abcdef0123456789abcdef")

      const limits = {
        maxBytes: undefined,
        maxFileBytes: ByteSize.bytes(0xffffffff),
        maxEntries: undefined,
        maxPathBytes: undefined,
        maxPendingOperations: 64,
        maxWatchEvents: 256
      }

      const { volume } = yield* makeVolume(VolumeSource.Empty(), undefined, {
        commit: (candidate) =>
          captureLiveImage(candidate, identity, limits).pipe(
            Effect.tap((bytes) => Effect.sync(() => images.push(bytes))),
            Effect.as("committed" as const),
            Effect.orDie
          )
      })

      const caller = yield* volume.caller()
      const handle = yield* caller.open("/file", { access: "readWrite", create: "exclusive" })
      const inode = (yield* handle.stat).ino
      yield* handle.write(new Uint8Array([1]))
      yield* caller.unlink("/file")
      const retained = yield* LiveImage.decode(images.at(-1)!, ByteSize.bytes(4096))

      assert.deepEqual(retained.retainedFiles, [inode])
      assert.deepEqual(retained.records.map((record) => record.ino), [1n, inode])
      const { volume: recovered } = yield* makeVolume(VolumeSource.Live({ document: retained }))
      assert.strictEqual(recovered.identity, identity)
      assert.notStrictEqual(recovered.incarnation, volume.incarnation)
      assert.deepEqual(yield* recovered.usage, { usedBytes: 0n, entries: 0 })
      assert.strictEqual((yield* Effect.flip((yield* recovered.caller()).stat("/file"))).code, "NotFound")
      yield* handle.close
      const released = yield* LiveImage.decode(images.at(-1)!, ByteSize.bytes(4096))
      assert.deepEqual(released.retainedFiles, [])
      assert.deepEqual(released.records.map((record) => record.ino), [1n])
    })))

  it.effect("reopens committed bytes with the same hard-link inode and a fresh incarnation", () =>
    Effect.gen(function*() {
      let stored = yield* prepareEmptyLiveImage()
      const bound = ByteSize.bytes(64 * 1024)

      const session = yield* openImageVolume(stored, bound, (bytes) =>
        Effect.sync(() => {
          stored = new Uint8Array(bytes)

          return "committed" as const
        }))

      const volume = session.volume

      const caller = yield* volume.caller()
      yield* caller.writeFile("/file", new Uint8Array([1, 2, 3]), { access: "write", create: "exclusive" })
      yield* caller.link("/file", "/alias")
      const original = yield* caller.stat("/file")
      const reopened = (yield* openImageVolume(stored, bound, () => Effect.succeed("committed" as const))).volume
      const restored = yield* reopened.caller()

      assert.strictEqual(reopened.identity, volume.identity)
      assert.notStrictEqual(reopened.incarnation, volume.incarnation)
      assert.strictEqual((yield* restored.stat("/file")).ino, original.ino)
      assert.strictEqual((yield* restored.stat("/alias")).ino, original.ino)
      assert.deepEqual(yield* restored.readFile("/alias"), new Uint8Array([1, 2, 3]))
      yield* session.shutdown
      assert.strictEqual((yield* Effect.flip(volume.usage)).code, "VolumeUnavailable")
    }))

  it.effect("keeps hard-link identity and directory revisions across a rejected rename", () =>
    Effect.gen(function*() {
      let outcome: "committed" | "rejected" = "committed"
      const { volume } = yield* makeVolume(VolumeSource.Empty(), undefined, { commit: () => Effect.succeed(outcome) })
      const caller = yield* volume.caller()
      yield* caller.mkdir("/from")
      yield* caller.mkdir("/to")
      yield* caller.writeFile("/from/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      yield* caller.link("/from/file", "/alias")

      const root = yield* caller.root
      const from = yield* caller.lookup(Vfs.Entry(root, new TextEncoder().encode("from")))
      const file = yield* caller.lookup(Vfs.Entry(from, new TextEncoder().encode("file")))
      const before = (yield* caller.stat(from)).revision
      outcome = "rejected"

      assert.strictEqual((yield* Effect.flip(caller.rename("/from/file", "/to/file"))).code, "StorageRejected")
      outcome = "committed"
      assert.strictEqual((yield* caller.stat(from)).revision, before)
      assert.strictEqual(yield* caller.lookup(Vfs.Entry(from, new TextEncoder().encode("file"))), file)
      assert.strictEqual(yield* caller.lookup(Vfs.Entry(root, new TextEncoder().encode("alias"))), file)
      assert.strictEqual((yield* Effect.flip(caller.stat("/to/file"))).code, "NotFound")

      yield* caller.rename("/from/file", "/to/file")
      const to = yield* caller.lookup(Vfs.Entry(root, new TextEncoder().encode("to")))
      assert.strictEqual(yield* caller.lookup(Vfs.Entry(to, new TextEncoder().encode("file"))), file)
      assert.strictEqual(yield* caller.lookup(Vfs.Entry(root, new TextEncoder().encode("alias"))), file)
    }))

  it.effect("holds observers behind a pending commit", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let pause = false

      const { volume } = yield* makeVolume(VolumeSource.Empty(), undefined, {
        commit: () =>
          pause
            ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as("committed" as const)
            )
            : Effect.succeed("committed" as const)
      })

      const caller = yield* volume.caller()
      pause = true

      const writer = yield* caller.mkdir("/new").pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      const observed = yield* Deferred.make<void>()

      const reader = yield* volume.usage.pipe(
        Effect.tap(() => Deferred.succeed(observed, undefined)),
        Effect.forkChild({ startImmediately: true })
      )

      yield* Effect.yieldNow
      assert.isFalse(yield* Deferred.isDone(observed))
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(writer)
      assert.deepEqual(yield* Fiber.join(reader), { usedBytes: 0n, entries: 1 })
    }))

  it.effect("reads path options before waiting behind a pending commit", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let pause = false

      const { volume } = yield* makeVolume(VolumeSource.Empty(), undefined, {
        commit: () =>
          pause
            ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as("committed" as const)
            )
            : Effect.succeed("committed" as const)
      })

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

  it.effect("closes a handle and stops service when final cleanup is rejected", () =>
    Effect.scoped(Effect.gen(function*() {
      let outcome: "committed" | "rejected" = "committed"
      const { volume } = yield* makeVolume(VolumeSource.Empty(), undefined, { commit: () => Effect.succeed(outcome) })
      const caller = yield* volume.caller()
      const handle = yield* caller.open("/file", { access: "readWrite", create: "exclusive" })
      yield* handle.write(new Uint8Array([1]))
      yield* caller.unlink("/file")
      outcome = "rejected"

      assert.strictEqual((yield* Effect.flip(handle.close)).code, "StorageRejected")
      assert.strictEqual((yield* Effect.flip(volume.usage)).code, "VolumeUnavailable")
    })))

  it.effect("leaves no uncommitted change visible when a staged mutation is interrupted", () =>
    Effect.gen(function*() {
      let commits = 0

      const { volume } = yield* makeVolume(VolumeSource.Empty(), undefined, {
        commit: () =>
          Effect.sync(() => {
            commits++

            return "committed" as const
          })
      })

      const caller = yield* volume.caller()
      const handle = yield* caller.open("/handle", { access: "readWrite", create: "exclusive" })

      const exists = (path: string) =>
        Effect.exit(caller.stat(Vfs.Target.Path({ path: path, followFinalSymlink: false }))).pipe(
          Effect.map(Exit.isSuccess)
        )

      // Path, content, and handle mutations each swap engine state, so each is swept separately.
      const mutations = [
        { name: "mkdir", run: (path: string) => caller.mkdir(path), visible: exists },
        {
          name: "writeFile",
          run: (path: string) => caller.writeFile(path, new Uint8Array([1]), { access: "write", create: "exclusive" }),
          visible: exists
        },
        { name: "symlink", run: (path: string) => caller.symlink("/target", path), visible: exists },
        {
          name: "pwrite",
          run: (_path: string, delay: number) => handle.pwrite(new Uint8Array([1]), BigInt(delay)),
          visible: (_path: string, delay: number) => handle.stat.pipe(Effect.map(({ size }) => size > BigInt(delay)))
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
    }))
})
