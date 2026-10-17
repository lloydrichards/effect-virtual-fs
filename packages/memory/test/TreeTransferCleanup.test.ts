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
    metadataFails?: boolean
    writeFails?: boolean
    writing?: {
      started: Deferred.Deferred<void>
      resume: Deferred.Deferred<void>
      interrupted: Deferred.Deferred<void>
    }
    claiming?: { started: Deferred.Deferred<void>; resume: Deferred.Deferred<void> }
    finalizing?: { started: Deferred.Deferred<void>; resume: Deferred.Deferred<void> }
  }
) {
  let claimObserved = false

  const afterStat = Effect.fnUntraced(function*() {
    if (claimObserved || options?.claiming === undefined) return
    claimObserved = true
    yield* Deferred.succeed(options.claiming.started, undefined)
    yield* Deferred.await(options.claiming.resume)
  })

  const callerFailure = Object.assign(new Vfs.VfsError({ code: "AccessDenied", operation: "chmod" }), {
    code: "AccessDenied" as const
  })

  const metadataFailure = PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "chmod" })
  const writeFailure = PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "writeAll" })

  const writing = options?.writing

  const afterWrite = writing === undefined ? Effect.void : Effect.gen(function*() {
    yield* Deferred.succeed(writing.started, undefined)
    yield* Deferred.await(writing.resume)
  }).pipe(Effect.onInterrupt(() => Deferred.succeed(writing.interrupted, undefined)))

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
            stat: (target) => caller.stat(target).pipe(Effect.tap(afterStat)),
            rmdir: (path) =>
              options?.cleanupFails
                ? Effect.fail(
                  Object.assign(new Vfs.VfsError({ code: "AccessDenied", operation: "rmdir" }), {
                    code: "AccessDenied" as const
                  })
                )
                : caller.rmdir(path),
            chmod: Function.dual(2, (target: Vfs.TargetInput, mode: number) =>
              options?.metadataFails && mode === 0o540 ?
                Effect.fail(callerFailure)
                : beforeMode(mode).pipe(Effect.andThen(caller.chmod(target, mode))))
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
          stat: (path) => fs.stat(path).pipe(Effect.tap(afterStat)),
          open: (path, openOptions) =>
            fs.open(path, openOptions).pipe(Effect.map((file) => ({
              ...file,
              stat: file.stat.pipe(Effect.tap(afterStat)),
              writeAll: (contents: Uint8Array) =>
                options?.writeFails
                  ? file.writeAll(contents.subarray(0, 1)).pipe(Effect.andThen(Effect.fail(writeFailure)))
                  : file.writeAll(contents).pipe(Effect.andThen(afterWrite))
            }))),
          writeFile: (path, contents, writeOptions) =>
            options?.writeFails
              ? fs.writeFile(path, contents.subarray(0, 1), writeOptions).pipe(
                Effect.andThen(Effect.fail(metadataFailure))
              )
              : fs.writeFile(path, contents, writeOptions).pipe(Effect.andThen(afterWrite)),
          remove: (path, removeOptions) =>
            options?.cleanupFails
              ? Effect.fail(
                PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "remove" })
              )
              : fs.remove(path, removeOptions),
          chmod: (path, mode) =>
            options?.metadataFails && mode === 0o540 ?
              Effect.fail(metadataFailure)
              : beforeMode(mode).pipe(Effect.andThen(fs.chmod(path, mode)))
        }),
        root,
        { existing }
      )
  }
})

for (const kind of ["Caller", "Memory", "Node"] as const) {
  it.layer(NodeCrypto.layer)(`TreeTransfer cleanup (${kind})`, (it) => {
    it.effect("should remove the created root when its initial metadata fails", () =>
      Effect.gen(function*() {
        const { fs, root, sink } = yield* cleanupDestination(kind, { metadataFails: true })

        const entry: TreeTransfer.Entry = kind === "Caller"
          ? { kind: "symlink", path: "/", target: "missing", metadata: { mode: 0o540 } }
          : { kind: "file", path: "/", bytes: text.encode("partial"), metadata: { mode: 0o540 } }

        const exit = yield* Effect.exit(Stream.run(Stream.make(entry), sink("reject")))
        assert.isTrue(Exit.isFailure(exit))

        if (Exit.isFailure(exit)) assert.isTrue(Cause.hasFails(exit.cause))
        const parent = root.slice(0, root.lastIndexOf("/")) || "/"
        assert.notInclude(yield* fs.readDirectory(parent), "copy")
        yield* fs.writeFileString(root, "usable")
        assert.strictEqual(yield* fs.readFileString(root), "usable")
      }))

    if (kind !== "Caller") {
      it.effect("should interrupt a blocked root-file write after ownership has been captured", () =>
        Effect.gen(function*() {
          const writing = {
            started: yield* Deferred.make<void>(),
            resume: yield* Deferred.make<void>(),
            interrupted: yield* Deferred.make<void>()
          }

          const { fs, root, sink } = yield* cleanupDestination(kind, { writing })

          const fiber = yield* Effect.forkChild(Stream.run(
            Stream.fromIterable<TreeTransfer.Entry>([
              { kind: "file", path: "/", bytes: text.encode("partial") }
            ]),
            sink("reject")
          ))

          yield* Deferred.await(writing.started)
          const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))
          yield* Effect.yieldNow
          const stoppedBeforeRelease = yield* Deferred.isDone(writing.interrupted)
          yield* Deferred.succeed(writing.resume, undefined)
          yield* Fiber.join(interrupting)
          const exit = yield* Fiber.await(fiber)
          assert.isTrue(stoppedBeforeRelease)
          assert.isTrue(Exit.isFailure(exit))

          if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterruptsOnly(exit.cause))
          assert.isFalse(yield* fs.exists(root))
        }))

      it.effect("should retain the handle identity when a root file is moved and replaced during its write", () =>
        Effect.gen(function*() {
          const writing = {
            started: yield* Deferred.make<void>(),
            resume: yield* Deferred.make<void>(),
            interrupted: yield* Deferred.make<void>()
          }

          const { fs, root, sink } = yield* cleanupDestination(kind, { writing, metadataFails: true })

          const fiber = yield* Effect.forkChild(Stream.run(
            Stream.fromIterable<TreeTransfer.Entry>([
              { kind: "file", path: "/", bytes: text.encode("original"), metadata: { mode: 0o540 } }
            ]),
            sink("reject")
          ))

          yield* Deferred.await(writing.started)
          yield* fs.rename(root, `${root}-moved`)
          yield* fs.writeFileString(root, "replacement")
          yield* Deferred.succeed(writing.resume, undefined)
          const exit = yield* Fiber.await(fiber)
          assert.isTrue(Exit.isFailure(exit))

          if (Exit.isFailure(exit)) assert.isTrue(Cause.hasFails(exit.cause))
          assert.strictEqual(yield* fs.readFileString(root), "replacement")
          assert.strictEqual(yield* fs.readFileString(`${root}-moved`), "original")
        }))

      for (const targetExists of [false, true]) {
        it.effect(`should finish an allowed root symlink when its target ${targetExists ? "exists" : "dangles"}`, () =>
          Effect.gen(function*() {
            const { fs, root } = yield* cleanupDestination(kind)
            const target = `${root}-target`

            if (targetExists) yield* fs.writeFileString(target, "protected")

            const report = yield* Stream.run(
              Stream.fromIterable<TreeTransfer.Entry>([
                { kind: "symlink", path: "/", target }
              ]),
              TreeTransfer.toFileSystem(fs, root, { escaping: "allow" })
            )

            assert.strictEqual(report.entries, 1)
            assert.strictEqual(yield* fs.readLink(root), target)

            if (targetExists) assert.strictEqual(yield* fs.readFileString(target), "protected")
            else assert.isFalse(yield* fs.exists(root))
          }))
      }

      it.effect("should keep a finalized root symlink when interruption arrives during its creation", () =>
        Effect.gen(function*() {
          const { fs, root } = yield* cleanupDestination(kind)
          const created = yield* Deferred.make<void>()
          const resume = yield* Deferred.make<void>()

          const delayed = FileSystem.make({
            ...fs,
            symlink: (target, path) =>
              fs.symlink(target, path).pipe(
                Effect.andThen(Deferred.succeed(created, undefined)),
                Effect.andThen(Deferred.await(resume))
              )
          })

          const fiber = yield* Effect.forkChild(Stream.run(
            Stream.fromIterable<TreeTransfer.Entry>([
              { kind: "symlink", path: "/", target: "missing" }
            ]),
            TreeTransfer.toFileSystem(delayed, root, { escaping: "allow" })
          ))

          yield* Deferred.await(created)
          const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))
          yield* Effect.yieldNow
          yield* Deferred.succeed(resume, undefined)
          yield* Fiber.join(interrupting)
          const exit = yield* Fiber.await(fiber)
          assert.isTrue(Exit.isFailure(exit))

          if (Exit.isFailure(exit)) {
            assert.isTrue(Cause.hasInterruptsOnly(exit.cause))
          }

          assert.strictEqual(yield* fs.readLink(root), "missing")
        }))

      it.effect("should remove a root file when its contents fail after creation", () =>
        Effect.gen(function*() {
          const { fs, root, sink } = yield* cleanupDestination(kind, { writeFails: true })

          const exit = yield* Effect.exit(Stream.run(
            Stream.fromIterable<TreeTransfer.Entry>([
              { kind: "file", path: "/", bytes: text.encode("partial") }
            ]),
            sink("reject")
          ))

          assert.isTrue(Exit.isFailure(exit))

          if (Exit.isFailure(exit)) assert.isTrue(Cause.hasFails(exit.cause))
          assert.isFalse(yield* fs.exists(root))
          yield* fs.writeFileString(root, "usable")
          assert.strictEqual(yield* fs.readFileString(root), "usable")
        }))
    }

    for (
      const rootKind of kind === "Caller"
        ? ["directory", "file", "symlink"] as const
        : ["directory", "file"] as const
    ) {
      it.effect(`should remove a ${rootKind} root when interrupted while recording ownership`, () =>
        Effect.gen(function*() {
          const claiming = { started: yield* Deferred.make<void>(), resume: yield* Deferred.make<void>() }
          const { fs, root, sink } = yield* cleanupDestination(kind, { claiming })

          const entry: TreeTransfer.Entry = rootKind === "file"
            ? { kind: "file", path: "/", bytes: text.encode("partial") }
            : rootKind === "symlink"
            ? { kind: "symlink", path: "/", target: "missing" }
            : { kind: "directory", path: "/" }

          const fiber = yield* Effect.forkChild(Stream.run(Stream.make(entry), sink("reject")))
          yield* Deferred.await(claiming.started)
          const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))
          yield* Effect.yieldNow
          yield* Deferred.succeed(claiming.resume, undefined)
          yield* Fiber.join(interrupting)
          const exit = yield* Fiber.await(fiber)
          assert.isTrue(Exit.isFailure(exit))

          if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterrupts(exit.cause))
          const parent = root.slice(0, root.lastIndexOf("/")) || "/"
          assert.notInclude(yield* fs.readDirectory(parent), "copy")
        }))
    }

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

it.layer(NodeCrypto.layer)("TreeTransfer confined cleanup", (it) => {
  it.effect("should write a read-only root file through an unprivileged FileSystem binding", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      yield* (yield* volume.caller()).chmod("/", 0o777)
      const caller = yield* volume.caller({ identity: { uid: 1000, gid: 1000, groups: [], privileged: false } })
      const fs = yield* MemoryFileSystem.bindCaller(caller)
      yield* Stream.run(
        Stream.fromIterable<TreeTransfer.Entry>([
          { kind: "file", path: "/", bytes: text.encode("readable"), metadata: { mode: 0o444 } }
        ]),
        TreeTransfer.toFileSystem(fs, "/copy")
      )
      assert.strictEqual((yield* caller.stat("/copy")).mode, 0o444)
      assert.strictEqual(yield* fs.readFileString("/copy"), "readable")
    }))

  it.effect("should preserve outside state when a confined destination moves outside and is replaced by a symlink", () =>
    Effect.gen(function*() {
      const admin = yield* (yield* Vfs.make()).caller()
      yield* admin.mkdir("/jail")
      yield* admin.mkdir("/outside")
      yield* admin.writeFile("/outside/keep", text.encode("protected"), { create: "exclusive", access: "write" })
      const confined = yield* admin.withRoot("/jail")
      const waiting = yield* Deferred.make<void>()
      const resume = yield* Deferred.make<void>()

      const stream = Stream.fromIterable<TreeTransfer.Entry>([
        { kind: "directory", path: "/" },
        { kind: "file", path: "/data", bytes: text.encode("partial") }
      ]).pipe(Stream.concat(Stream.fromEffect(Effect.gen(function*() {
        yield* Deferred.succeed(waiting, undefined)
        yield* Deferred.await(resume)

        return yield* Effect.fail("source failed")
      }))))

      const fiber = yield* Effect.forkChild(Stream.run(stream, TreeTransfer.toCaller(confined, "/copy")))
      yield* Deferred.await(waiting)
      yield* admin.rename("/jail/copy", "/outside/moved")
      yield* admin.symlink("/outside", "/jail/copy")
      yield* Deferred.succeed(resume, undefined)
      const exit = yield* Fiber.await(fiber)
      assert.isTrue(Exit.isFailure(exit))

      if (Exit.isFailure(exit)) assert.deepStrictEqual(Cause.findError(exit.cause), Result.succeed("source failed"))
      assert.deepStrictEqual(yield* admin.readFile("/outside/keep"), text.encode("protected"))
      assert.deepStrictEqual(yield* admin.readFile("/outside/moved/data"), text.encode("partial"))
      assert.deepStrictEqual(yield* confined.readLink("/copy"), text.encode("/outside"))
      assert.strictEqual((yield* Effect.flip(confined.readFile("/copy/keep"))).code, "NotFound")
      yield* admin.writeFile("/outside/moved/after", text.encode("usable"), { create: "exclusive", access: "write" })
      assert.deepStrictEqual(yield* admin.readFile("/outside/moved/after"), text.encode("usable"))
    }))
})
