import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Deferred, Effect, Exit, Fiber, Scheduler, Schema } from "effect"
import { VirtualFileSystem as Vfs } from "../../src/index.js"
import { KeySecret, VolumeEpoch } from "../../src/internal/hex128.js"
import * as LiveImage from "../../src/internal/liveImage.js"
import { LiveTreeNode } from "../../src/internal/tree.js"
import { makeVolume, VolumeSource } from "../../src/internal/virtualFileSystem.js"
import { VolumeIdentity } from "../../src/Volume.js"
import { readLines } from "../support/lines.js"

// The nodes a live image stores, read without restoring it: every line after the header.
const storedTree = (image: Uint8Array) =>
  Effect.map(Schema.decodeUnknownEffect(Schema.Array(LiveTreeNode))(readLines(image).slice(1)), (nodes) => ({ nodes }))

// Smaller budgets livelock the runtime: it counts an op before checking whether to yield.
const MIN_OP_BUDGET = 3

// Comfortably past the yields an mkdir needs to commit at MIN_OP_BUDGET (about 43).
const MAX_INTERRUPT_DELAY = 128

describe("staged volume state", () => {
  it.effect("should include open unlinked files in candidates when the final handle has not closed", () =>
    Effect.scoped(Effect.gen(function*() {
      const retained = new Array<ReadonlyArray<bigint>>()

      const { volume } = yield* makeVolume(VolumeSource.Empty(), undefined, {
        commit: (candidate) => {
          retained.push(LiveImage.retainedFiles(candidate).map((file) => file.metadata.ino))

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

  it.effect("should retain inode identity and open unlinked content when a commit image is encoded", () =>
    Effect.scoped(Effect.gen(function*() {
      const images: Array<Uint8Array> = []
      const identity = VolumeIdentity.make("0123456789abcdef0123456789abcdef")

      const naming = {
        identity,
        epoch: VolumeEpoch.make("fedcba9876543210fedcba9876543210"),
        keySecret: KeySecret.make("00112233445566778899aabbccddeeff")
      }

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
          LiveImage.encode(candidate, naming, limits).pipe(
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
      const retainedImage = yield* storedTree(images.at(-1)!)

      // The unlinked file stays in the image with no names while its handle is open.
      assert.deepEqual(retainedImage.nodes.map((node) => [node.ino, "links" in node ? node.links.length : 1]), [
        [1, 1],
        [Number(inode), 0]
      ])
      const retained = yield* LiveImage.decode(images.at(-1)!, ByteSize.bytes(4096))
      const { volume: recovered } = yield* makeVolume(VolumeSource.Live({ restored: retained }))
      assert.strictEqual(recovered.identity, identity)
      assert.notStrictEqual(recovered.incarnation, volume.incarnation)
      assert.deepEqual(yield* recovered.usage, { usedBytes: 0n, entries: 0 })
      assert.strictEqual((yield* Effect.flip((yield* recovered.caller()).stat("/file"))).code, "NotFound")
      yield* handle.close
      const released = yield* storedTree(images.at(-1)!)
      assert.deepEqual(released.nodes.map((node) => node.ino), [1])
    })))

  it.effect("should read path options before waiting when a commit is pending", () =>
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

  it.effect("should stop the volume when final handle cleanup is rejected", () =>
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

  it.effect("should expose no uncommitted change when a staged mutation is interrupted", () =>
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
