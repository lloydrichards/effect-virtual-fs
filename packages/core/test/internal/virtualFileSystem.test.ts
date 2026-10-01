import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Cause, Deferred, Effect, Exit, Fiber, Scheduler, Schema, Scope } from "effect"
import { VirtualFileSystem as Vfs } from "../../src/index.js"
import { KeySecret, VolumeEpoch } from "../../src/internal/hex128.js"
import * as InodeTable from "../../src/internal/inodeTable.js"
import * as LiveImage from "../../src/internal/liveImage.js"
import { LiveTreeNode } from "../../src/internal/tree.js"
import { makeVolume, memoryCommitProvider, VolumeSource } from "../../src/internal/virtualFileSystem.js"
import type { VolumeState } from "../../src/internal/volumeState.js"
import { make as makeError } from "../../src/VfsError.js"
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
  it.layer(BunCrypto.layer)((it) => {
    it.effect("should offer directory reclamation once when a detached directory scope closes", () =>
      Effect.gen(function*() {
        let commits = 0
        let candidate: VolumeState | undefined

        const { volume } = yield* makeVolume(VolumeSource.Empty(), {
          mode: "durable",
          shutdown: Effect.void,
          commit: (next) =>
            Effect.sync(() => {
              commits++
              candidate = next

              return "committed" as const
            })
        })

        const caller = yield* volume.caller()
        yield* caller.mkdir("/directory")
        const scope = yield* Scope.make()
        const directory = yield* caller.openDirectory("/directory").pipe(Scope.provide(scope))
        const inode = Number((yield* directory.stat).ino)
        yield* caller.rmdir("/directory")
        assert.isDefined(InodeTable.get(candidate!.inodes, inode))
        const before = commits
        yield* Scope.close(scope, Exit.void)
        assert.strictEqual(commits - before, 1)
        assert.isUndefined(InodeTable.get(candidate!.inodes, inode))
        assert.strictEqual((yield* Effect.flip(directory.stat)).code, "InvalidHandle")
        assert.deepEqual(yield* volume.usage, { entries: 0, usedBytes: 0n })
        yield* caller.mkdir("/after")
        assert.strictEqual((yield* caller.stat("/after")).kind, "directory")
      }))

    it.effect("should close a detached directory and disable access when its cleanup commit is rejected", () =>
      Effect.gen(function*() {
        let reject = false
        let commits = 0

        const { volume } = yield* makeVolume(VolumeSource.Empty(), {
          mode: "durable",
          shutdown: Effect.void,
          commit: () =>
            Effect.sync(() => {
              commits++

              return reject ? "rejected" as const : "committed" as const
            })
        })

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

    const preparationError = makeError({ code: "StorageRejected", operation: "commit" })

    const mixedFailures = [
      ["a defect", Effect.fail(preparationError).pipe(Effect.ensuring(Effect.die("commit finalizer failed")))],
      ["interruption", Effect.failCause(Cause.combine(Cause.fail(preparationError), Cause.interrupt()))]
    ] as const

    for (const [reason, failure] of mixedFailures) {
      it.effect(`should disable the volume when a typed commit failure also contains ${reason}`, () =>
        Effect.gen(function*() {
          let fail = false
          let commits = 0

          const { volume } = yield* makeVolume(VolumeSource.Empty(), {
            mode: "durable",
            shutdown: Effect.void,
            commit: () =>
              Effect.suspend(() => {
                commits++

                return fail ? failure : Effect.succeed("committed" as const)
              })
          })

          const caller = yield* volume.caller()
          const scope = yield* Scope.make()

          const handle = yield* caller.open("/held", { access: "readWrite", create: "exclusive" })
            .pipe(Scope.provide(scope))

          yield* handle.write(new Uint8Array([1]))
          yield* caller.unlink("/held")
          fail = true
          const before = commits
          const error = yield* Effect.flip(caller.mkdir("/uncertain"))
          assert.strictEqual(error.code, "OutcomeUnknown")
          assert.strictEqual(error.operation, "mkdir")
          assert.strictEqual(commits - before, 1)
          assert.strictEqual((yield* Effect.flip(volume.usage)).code, "VolumeUnavailable")
          assert.strictEqual((yield* Effect.flip(caller.stat("/uncertain"))).code, "VolumeUnavailable")
          assert.strictEqual((yield* Effect.flip(caller.mkdir("/later"))).code, "VolumeUnavailable")
          yield* Scope.close(scope, Exit.void)
          assert.strictEqual(commits - before, 1)
          assert.strictEqual((yield* Effect.flip(handle.read(1))).code, "VolumeUnavailable")
        }))
    }

    const cleanupFailures = [
      ["rejected", Effect.succeed("rejected" as const)],
      ["unknown", Effect.succeed("unknown" as const)],
      ["not prepared", Effect.fail(makeError({ code: "StorageRejected", operation: "commit" }))]
    ] as const

    for (const [condition, failure] of cleanupFailures) {
      it.effect(`should release handles and disable the volume when cleanup is ${condition}`, () =>
        Effect.gen(function*() {
          let failCleanup = false
          let commits = 0

          const { volume } = yield* makeVolume(VolumeSource.Empty(), {
            mode: "durable",
            shutdown: Effect.void,
            commit: () =>
              Effect.suspend(() => {
                commits++

                return failCleanup ? failure : Effect.succeed("committed" as const)
              })
          })

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

    it.effect("should finish the active commit before releasing the provider when shutdown is requested", () =>
      Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const callbackEntered = yield* Deferred.make<void>()
        const callbackRelease = yield* Deferred.make<void>()
        let committed = false
        let shutDown = false

        const { volume, shutdown } = yield* makeVolume(VolumeSource.Empty(), {
          mode: "durable",
          commit: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Effect.sync(() => {
                committed = true
              })),
              Effect.as("committed" as const)
            ),
          shutdown: Effect.gen(function*() {
            assert.isTrue(committed)
            shutDown = true
            yield* Deferred.succeed(callbackEntered, undefined)
            yield* Deferred.await(callbackRelease)
          })
        })

        const caller = yield* volume.caller()
        const worker = yield* caller.mkdir("/committed").pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(entered)
        const closing = yield* shutdown.pipe(Effect.forkChild({ startImmediately: true }))

        for (let i = 0; i < 4; i++) yield* Effect.yieldNow
        assert.isFalse(shutDown)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(worker)
        yield* Deferred.await(callbackEntered)
        const interrupt = yield* Fiber.interrupt(closing).pipe(Effect.forkChild({ startImmediately: true }))

        for (let i = 0; i < 4; i++) yield* Effect.yieldNow
        assert.isUndefined(interrupt.pollUnsafe())
        yield* Deferred.succeed(callbackRelease, undefined)
        yield* Fiber.join(interrupt)
        assert.strictEqual((yield* Effect.flip(volume.usage)).code, "VolumeUnavailable")
      }))

    it.effect("should keep a memory volume usable when its no-op shutdown runs", () =>
      Effect.gen(function*() {
        const { volume, shutdown } = yield* makeVolume(VolumeSource.Empty(), memoryCommitProvider)
        const caller = yield* volume.caller()
        yield* caller.mkdir("/before")
        yield* shutdown
        yield* caller.mkdir("/after")
        assert.strictEqual((yield* caller.stat("/before")).kind, "directory")
        assert.strictEqual((yield* caller.stat("/after")).kind, "directory")
      }))
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should include open unlinked files in candidates when the final handle has not closed",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const retained = new Array<ReadonlyArray<bigint>>()

          const { volume } = yield* makeVolume(VolumeSource.Empty(), {
            mode: "durable",
            shutdown: Effect.void,
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
        }))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should retain inode identity and open unlinked content when a commit image is encoded",
      () =>
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

          const { volume } = yield* makeVolume(VolumeSource.Empty(), {
            mode: "durable",
            shutdown: Effect.void,
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

          const { volume: recovered } = yield* makeVolume(
            VolumeSource.Live({ restored: retained }),
            memoryCommitProvider
          )

          assert.strictEqual(recovered.identity, identity)
          assert.notStrictEqual(recovered.incarnation, volume.incarnation)
          assert.deepEqual(yield* recovered.usage, { usedBytes: 0n, entries: 0 })
          assert.strictEqual((yield* Effect.flip((yield* recovered.caller()).stat("/file"))).code, "NotFound")
          yield* handle.close
          const released = yield* storedTree(images.at(-1)!)
          assert.deepEqual(released.nodes.map((node) => node.ino), [1])
        }))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should read path options before waiting when a commit is pending", () =>
      Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let pause = false

        const { volume } = yield* makeVolume(VolumeSource.Empty(), {
          mode: "durable",
          shutdown: Effect.void,
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
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should stop the volume when final handle cleanup is rejected",
      () =>
        Effect.scoped(Effect.gen(function*() {
          let outcome: "committed" | "rejected" = "committed"

          const { volume } = yield* makeVolume(VolumeSource.Empty(), {
            mode: "durable",
            shutdown: Effect.void,
            commit: () => Effect.succeed(outcome)
          })

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

          const { volume } = yield* makeVolume(VolumeSource.Empty(), {
            mode: "durable",
            shutdown: Effect.void,
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
