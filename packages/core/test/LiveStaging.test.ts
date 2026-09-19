import { assert, describe } from "@effect/vitest"
import { ByteSize, Deferred, Effect, Fiber, Predicate, Stream } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"
import * as LiveImage from "../src/internal/liveImage.js"
import { captureLiveImage, makeVolume, VolumeIdentity, VolumeSource } from "../src/internal/virtualFileSystem.js"
import { it } from "./TestEffect.js"

describe("live volume staging", () => {
  it.effect("does not commit when a failed open scope closes", () =>
    Effect.gen(function*() {
      let commits = 0

      const volume = yield* makeVolume(VolumeSource.Empty(), undefined, {
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
      const volume = yield* makeVolume(VolumeSource.Empty(), undefined, { commit: () => Effect.succeed(outcome) })
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

      assert.deepEqual(yield* handle.pread(2, 0n), new Uint8Array([1]))
      assert.strictEqual(yield* handle.seek(0n, "current"), 1n)
      assert.deepEqual(yield* volume.usage, { usedBytes: 1n, entries: 1 })
      assert.strictEqual((yield* Effect.flip(caller.stat("/rejected"))).code, "NotFound")
      assert.deepEqual(yield* handle.stat, before)

      yield* caller.mkdir("/visible")
      const event = yield* Fiber.join(nextEvent)
      assert.strictEqual(event._tag, "Some")

      if (Predicate.isTagged("Some")(event)) {
        assert.deepEqual(yield* caller.readDirectory("/"), ["file", "visible"])
        assert.deepEqual(yield* Vfs.pathToBytes(event.value.path), new TextEncoder().encode("/visible"))
      }
    })))

  it.effect("stops paths, observations, and watch registration after an unknown outcome", () =>
    Effect.gen(function*() {
      const volume = yield* makeVolume(VolumeSource.Empty(), undefined, {
        commit: () => Effect.succeed("unknown" as const)
      })

      const caller = yield* volume.caller()

      assert.strictEqual((yield* Effect.flip(caller.mkdir("/dir"))).code, "OutcomeUnknown")
      assert.strictEqual((yield* Effect.flip(caller.stat("/"))).code, "VolumeUnavailable")
      assert.strictEqual((yield* Effect.flip(volume.usage)).code, "VolumeUnavailable")
      assert.strictEqual((yield* Effect.flip(volume.snapshot)).code, "VolumeUnavailable")
      const callerFailure = yield* Effect.flip(volume.caller())
      assert.strictEqual(callerFailure._tag, "FsError")

      if (Predicate.isTagged("FsError")(callerFailure)) {
        assert.strictEqual(callerFailure.code, "VolumeUnavailable")
      }

      assert.strictEqual((yield* Effect.flip(volume.watch)).code, "VolumeUnavailable")
    }))

  it.effect("preserves a reference after rejected unlink and retains its open file after committed unlink", () =>
    Effect.scoped(Effect.gen(function*() {
      let outcome: "committed" | "rejected" = "committed"
      const volume = yield* makeVolume(VolumeSource.Empty(), undefined, { commit: () => Effect.succeed(outcome) })
      const caller = yield* volume.caller()
      const handle = yield* caller.open("/file", { access: "readWrite", create: "exclusive" })
      yield* handle.write(new Uint8Array([1]))
      const root = yield* caller.rootReference
      const reference = yield* caller.lookupReference(root, new TextEncoder().encode("file"))

      outcome = "rejected"
      assert.strictEqual((yield* Effect.flip(caller.unlink("/file"))).code, "StorageRejected")
      outcome = "committed"
      assert.strictEqual((yield* caller.observeMetadata(reference)).value.nlink, 1)
      assert.deepEqual(yield* caller.readFile("/file"), new Uint8Array([1]))

      yield* caller.unlink("/file")
      assert.strictEqual((yield* Effect.flip(caller.openReference(reference))).code, "StaleReference")
      yield* handle.write(new Uint8Array([2]))
      assert.deepEqual(yield* handle.pread(2, 0n), new Uint8Array([1, 2]))
      assert.deepEqual(yield* volume.usage, { usedBytes: 2n, entries: 0 })
      yield* handle.close
      assert.deepEqual(yield* volume.usage, { usedBytes: 0n, entries: 0 })
    })))

  it.effect("includes open unlinked files in each candidate until final close", () =>
    Effect.scoped(Effect.gen(function*() {
      const retained = new Array<ReadonlyArray<bigint>>()

      const volume = yield* makeVolume(VolumeSource.Empty(), undefined, {
        commit: (candidate) => {
          retained.push([...candidate.retainedFiles.keys()])

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
        maxPathBytes: undefined
      }
      const volume = yield* makeVolume(VolumeSource.Empty(), undefined, {
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
      const recovered = yield* makeVolume(VolumeSource.Live({ document: retained }))
      assert.strictEqual(recovered.identity, identity)
      assert.notStrictEqual(recovered.incarnation, volume.incarnation)
      assert.deepEqual(yield* recovered.usage, { usedBytes: 0n, entries: 0 })
      assert.strictEqual((yield* Effect.flip((yield* recovered.caller()).stat("/file"))).code, "NotFound")
      yield* handle.close
      const released = yield* LiveImage.decode(images.at(-1)!, ByteSize.bytes(4096))
      assert.deepEqual(released.retainedFiles, [])
      assert.deepEqual(released.records.map((record) => record.ino), [1n])
    })))

  it.effect("keeps hard-link identity and directory revisions across a rejected rename", () =>
    Effect.gen(function*() {
      let outcome: "committed" | "rejected" = "committed"
      const volume = yield* makeVolume(VolumeSource.Empty(), undefined, { commit: () => Effect.succeed(outcome) })
      const caller = yield* volume.caller()
      yield* caller.mkdir("/from")
      yield* caller.mkdir("/to")
      yield* caller.writeFile("/from/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      yield* caller.link("/from/file", "/alias")

      const root = yield* caller.rootReference
      const from = yield* caller.lookupReference(root, new TextEncoder().encode("from"))
      const file = yield* caller.lookupReference(from, new TextEncoder().encode("file"))
      const before = (yield* caller.observeMetadata(from)).revision
      outcome = "rejected"

      assert.strictEqual((yield* Effect.flip(caller.rename("/from/file", "/to/file"))).code, "StorageRejected")
      outcome = "committed"
      assert.strictEqual((yield* caller.observeMetadata(from)).revision, before)
      assert.strictEqual(yield* caller.lookupReference(from, new TextEncoder().encode("file")), file)
      assert.strictEqual(yield* caller.lookupReference(root, new TextEncoder().encode("alias")), file)
      assert.strictEqual((yield* Effect.flip(caller.stat("/to/file"))).code, "NotFound")

      yield* caller.rename("/from/file", "/to/file")
      const to = yield* caller.lookupReference(root, new TextEncoder().encode("to"))
      assert.strictEqual(yield* caller.lookupReference(to, new TextEncoder().encode("file")), file)
      assert.strictEqual(yield* caller.lookupReference(root, new TextEncoder().encode("alias")), file)
    }))

  it.effect("holds observers behind a pending commit", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let pause = false

      const volume = yield* makeVolume(VolumeSource.Empty(), undefined, {
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

  it.effect("closes a handle and stops service when final cleanup is rejected", () =>
    Effect.scoped(Effect.gen(function*() {
      let outcome: "committed" | "rejected" = "committed"
      const volume = yield* makeVolume(VolumeSource.Empty(), undefined, { commit: () => Effect.succeed(outcome) })
      const caller = yield* volume.caller()
      const handle = yield* caller.open("/file", { access: "readWrite", create: "exclusive" })
      yield* handle.write(new Uint8Array([1]))
      yield* caller.unlink("/file")
      outcome = "rejected"

      assert.strictEqual((yield* Effect.flip(handle.close)).code, "StorageRejected")
      assert.strictEqual((yield* Effect.flip(volume.usage)).code, "VolumeUnavailable")
    })))
})
