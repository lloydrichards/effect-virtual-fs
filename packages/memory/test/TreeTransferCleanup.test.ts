import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import { assert, it } from "@effect/vitest"
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Function,
  PlatformError,
  Result,
  Schema,
  Stream
} from "effect"
import * as TestClock from "effect/testing/TestClock"
import * as MemoryFileSystem from "../src/MemoryFileSystem.js"
import * as TreeTransfer from "../src/TreeTransfer.js"
import { FOUR_FILES_FIXTURE } from "./support/treeTransferFixtures.js"

const text = new TextEncoder()

const cleanupDestination = Effect.fnUntraced(function*(
  kind: "Caller" | "Memory" | "Node",
  options?: {
    cleanupFails?: boolean
    finalizing?: { started: Deferred.Deferred<void>; resume: Deferred.Deferred<void> }
  }
) {
  const beforeMode = (mode: number) =>
    mode === 0o555 && options?.finalizing !== undefined
      ? Deferred.succeed(options.finalizing.started, undefined).pipe(
        Effect.andThen(Deferred.await(options.finalizing.resume))
      )
      : Effect.void

  if (kind === "Caller") {
    const volume = yield* Vfs.make()
    yield* (yield* volume.caller()).chmod("/", 0o777)
    const caller = yield* volume.caller({ identity: { uid: 1000, gid: 1000, groups: [], privileged: false } })

    return {
      fs: yield* MemoryFileSystem.bindCaller(caller),
      root: "/copy",
      sink: (existing: "reject" | "overwrite") =>
        TreeTransfer.toCaller(
          {
            ...caller,
            rmdir: (path) =>
              options?.cleanupFails
                ? Effect.fail(
                  Object.assign(new Vfs.VfsError({ code: "AccessDenied", operation: "rmdir" }), {
                    code: "AccessDenied" as const
                  })
                )
                : caller.rmdir(path),
            chmod: Function.dual(2, (target: Vfs.TargetInput, mode: number) =>
              beforeMode(mode).pipe(Effect.andThen(caller.chmod(target, mode))))
          },
          "/copy",
          { existing }
        )
    }
  }

  const fs = yield* FileSystem.FileSystem.pipe(
    Effect.provide(kind === "Node" ? NodeFileSystem.layer : MemoryFileSystem.layer)
  )

  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "transfer-cleanup-" })
  const root = `${directory}/copy`

  return {
    fs,
    root,
    sink: (existing: "reject" | "overwrite") =>
      TreeTransfer.toFileSystem(
        FileSystem.make({
          ...fs,
          remove: (path, removeOptions) =>
            options?.cleanupFails
              ? Effect.fail(
                PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "remove" })
              )
              : fs.remove(path, removeOptions),
          chmod: (path, mode) => beforeMode(mode).pipe(Effect.andThen(fs.chmod(path, mode)))
        }),
        root,
        { existing }
      )
  }
})

for (const kind of ["Caller", "Memory", "Node"] as const) {
  it.layer(NodeCrypto.layer)(`TreeTransfer cleanup (${kind})`, (it) => {
    for (const existing of ["reject", "overwrite"] as const) {
      for (const stop of ["interrupt", "timeout"] as const) {
        it.effect(`should finish ${existing} cleanup after ${stop} while waiting for another source entry`, () =>
          Effect.gen(function*() {
            const { fs, root, sink } = yield* cleanupDestination(kind, { cleanupFails: existing === "overwrite" })
            const source = yield* Vfs.fromFixture(FOUR_FILES_FIXTURE)
            const waiting = yield* Deferred.make<void>()

            const stream = TreeTransfer.fromSnapshot(yield* source.snapshot, "/").pipe(
              Stream.take(2),
              Stream.map((entry) =>
                entry.kind === "directory"
                  ? { ...entry, metadata: { ...entry.metadata, mode: 0o555 } }
                  : entry
              ),
              Stream.concat(Stream.fromEffect(Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never))))
            )

            const transfer = Stream.run(stream, sink(existing))

            const fiber = yield* Effect.forkChild(
              stop === "timeout" ? transfer.pipe(Effect.timeout("1 second")) : transfer
            )

            yield* Deferred.await(waiting)
            assert.deepStrictEqual(yield* fs.readDirectory(root), ["a"])

            if (stop === "timeout") yield* TestClock.adjust("1 second")
            else yield* Fiber.interrupt(fiber)

            const exit = yield* Fiber.await(fiber)
            assert.isTrue(Exit.isFailure(exit))

            if (Exit.isFailure(exit)) {
              assert.isTrue(stop === "timeout" ? Cause.hasFails(exit.cause) : Cause.hasInterrupts(exit.cause))
              assert.isFalse(Cause.hasDies(exit.cause))
            }

            assert.strictEqual(yield* fs.exists(root), existing === "overwrite")

            if (existing === "overwrite") {
              assert.deepStrictEqual(yield* fs.readDirectory(root), ["a"])
              assert.strictEqual((yield* fs.stat(root)).mode & 0o777, 0o555)
              yield* fs.chmod(root, 0o755)
            } else yield* fs.makeDirectory(root)
            yield* fs.writeFileString(`${root}/after`, "usable")
            assert.strictEqual(yield* fs.readFileString(`${root}/after`), "usable")
          }))
      }
    }

    for (const stop of ["failure", "interrupt", "timeout"] as const) {
      it.effect(`should restore every created directory mode when overwrite stops by ${stop} with an unsearchable root`, () =>
        Effect.gen(function*() {
          const { fs, root, sink } = yield* cleanupDestination(kind)
          const waiting = yield* Deferred.make<void>()

          const stream = Stream.fromIterable<TreeTransfer.Entry>([
            { kind: "directory", path: "/", metadata: { mode: 0o000 } },
            { kind: "directory", path: "/nested", metadata: { mode: 0o000 } }
          ]).pipe(Stream.concat(Stream.fromEffect(Effect.gen(function*() {
            yield* Deferred.succeed(waiting, undefined)

            return yield* stop === "failure" ? Effect.fail("source failed") : Effect.never
          }))))

          const transfer = Stream.run(stream, sink("overwrite"))

          const fiber = yield* Effect.forkChild(
            stop === "timeout" ? transfer.pipe(Effect.timeout("1 second")) : transfer
          )

          yield* Deferred.await(waiting)

          if (stop === "interrupt") yield* Fiber.interrupt(fiber)

          if (stop === "timeout") yield* TestClock.adjust("1 second")
          const exit = yield* Fiber.await(fiber)
          assert.isTrue(Exit.isFailure(exit))

          if (Exit.isFailure(exit)) {
            assert.isFalse(Cause.hasDies(exit.cause))

            if (stop === "interrupt") assert.isTrue(Cause.hasInterrupts(exit.cause))
            else if (stop === "failure") {
              assert.deepStrictEqual(Cause.findError(exit.cause), Result.succeed("source failed"))
            } else assert.isTrue(Cause.hasFails(exit.cause))
          }

          assert.strictEqual((yield* fs.stat(root)).mode & 0o777, 0o000)
          yield* fs.chmod(root, 0o700)
          const nestedMode = (yield* fs.stat(`${root}/nested`)).mode & 0o777
          yield* fs.chmod(`${root}/nested`, 0o700)
          assert.strictEqual(nestedMode, 0o000)
          yield* fs.writeFileString(`${root}/nested/after`, "usable")
          assert.strictEqual(yield* fs.readFileString(`${root}/nested/after`), "usable")
        }))
    }

    for (const stop of ["failure", "interrupt"] as const) {
      it.effect(`should retain the original ${stop} and a cleanup defect when root removal fails`, () =>
        Effect.gen(function*() {
          const { fs, root, sink } = yield* cleanupDestination(kind, { cleanupFails: true })
          const waiting = yield* Deferred.make<void>()

          const stream = Stream.fromIterable<TreeTransfer.Entry>([
            { kind: "directory", path: "/" },
            { kind: "file", path: "/data", bytes: text.encode("partial") }
          ]).pipe(Stream.concat(Stream.fromEffect(Effect.gen(function*() {
            yield* Deferred.succeed(waiting, undefined)

            return yield* stop === "failure" ? Effect.fail("source failed") : Effect.never
          }))))

          const fiber = yield* Effect.forkChild(Stream.run(stream, sink("reject")))
          yield* Deferred.await(waiting)

          if (stop === "interrupt") yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber)
          assert.isTrue(Exit.isFailure(exit))

          if (Exit.isFailure(exit)) {
            assert.isTrue(Cause.hasDies(exit.cause))

            if (stop === "interrupt") assert.isTrue(Cause.hasInterrupts(exit.cause))
            else assert.deepStrictEqual(Cause.findError(exit.cause), Result.succeed("source failed"))
            const defects = exit.cause.reasons.filter(Cause.isDieReason)
            assert.strictEqual(defects.length, 1)
            assert.deepStrictEqual(
              defects.map((reason) =>
                kind === "Caller"
                  ? Schema.is(Vfs.VfsError)(reason.defect)
                  : PlatformError.isPlatformError(reason.defect)
              ),
              [true]
            )
          }

          assert.isTrue(yield* fs.exists(root))
          yield* fs.writeFileString(`${root}/after`, "usable")
          assert.strictEqual(yield* fs.readFileString(`${root}/after`), "usable")
        }))
    }

    for (const existing of ["reject", "overwrite"] as const) {
      it.effect(`should finish restrictive directory modes before ${existing} finalization accepts interruption`, () =>
        Effect.gen(function*() {
          const finalizing = { started: yield* Deferred.make<void>(), resume: yield* Deferred.make<void>() }
          const { fs, root, sink } = yield* cleanupDestination(kind, { finalizing })

          const stream = Stream.fromIterable<TreeTransfer.Entry>([
            { kind: "directory", path: "/", metadata: { mode: 0o555 } },
            { kind: "directory", path: "/nested", metadata: { mode: 0o555 } },
            { kind: "file", path: "/nested/data", bytes: text.encode("complete") }
          ])

          const fiber = yield* Effect.forkChild(Stream.run(stream, sink(existing)))
          yield* Deferred.await(finalizing.started)
          const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))
          yield* Effect.yieldNow
          yield* Deferred.succeed(finalizing.resume, undefined)
          yield* Fiber.join(interrupting)
          const exit = yield* Fiber.await(fiber)
          assert.isTrue(Exit.isFailure(exit))

          if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterrupts(exit.cause))
          assert.strictEqual((yield* fs.stat(root)).mode & 0o777, 0o555)
          assert.strictEqual((yield* fs.stat(`${root}/nested`)).mode & 0o777, 0o555)
          assert.strictEqual(yield* fs.readFileString(`${root}/nested/data`), "complete")
          yield* fs.chmod(root, 0o755)
          yield* fs.chmod(`${root}/nested`, 0o755)
          yield* fs.writeFileString(`${root}/nested/after`, "usable")
          assert.strictEqual(yield* fs.readFileString(`${root}/nested/after`), "usable")
        }))
    }

    for (const replacement of ["directory", "symlink"] as const) {
      it.effect(`should preserve a replacement ${replacement} and the moved claimed tree when the source fails`, () =>
        Effect.gen(function*() {
          const { fs, root, sink } = yield* cleanupDestination(kind)
          const source = yield* Vfs.fromFixture(FOUR_FILES_FIXTURE)
          const waiting = yield* Deferred.make<void>()
          const resume = yield* Deferred.make<void>()

          const stream = TreeTransfer.fromSnapshot(yield* source.snapshot, "/").pipe(
            Stream.take(2),
            Stream.concat(Stream.fromEffect(Effect.gen(function*() {
              yield* Deferred.succeed(waiting, undefined)
              yield* Deferred.await(resume)

              return yield* Effect.fail("source failed")
            })))
          )

          const fiber = yield* Effect.forkChild(Stream.run(stream, sink("reject")))
          yield* Deferred.await(waiting)
          yield* fs.rename(root, `${root}-moved`)
          const protectedRoot = replacement === "directory" ? root : `${root}-outside`
          yield* fs.makeDirectory(protectedRoot)
          yield* fs.writeFileString(`${protectedRoot}/keep`, "replacement")

          if (replacement === "symlink") yield* fs.symlink(protectedRoot, root)
          yield* Deferred.succeed(resume, undefined)
          const exit = yield* Fiber.await(fiber)
          assert.isTrue(Exit.isFailure(exit))

          if (Exit.isFailure(exit)) assert.deepStrictEqual(Cause.findError(exit.cause), Result.succeed("source failed"))
          assert.strictEqual(yield* fs.readFileString(`${protectedRoot}/keep`), "replacement")

          if (replacement === "symlink") assert.strictEqual(yield* fs.readLink(root), protectedRoot)
          assert.deepStrictEqual(yield* fs.readDirectory(`${root}-moved`), ["a"])
          yield* fs.writeFileString(`${root}-moved/after`, "usable")
          assert.strictEqual(yield* fs.readFileString(`${root}-moved/after`), "usable")
        }))
    }
  })
}
