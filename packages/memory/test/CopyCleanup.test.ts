import { BytePath, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, it } from "@effect/vitest"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Function, PlatformError, Result } from "effect"
import * as MemoryFileSystem from "../src/MemoryFileSystem.js"

// The core test seam runs between observing an entry and its coordinated removal.
const removalSeam = Context.Reference("@effect-vfs/core/VolumeTestSeams", {
  defaultValue: () => ({
    afterSubscribe: Effect.void,
    betweenSnapshotAndSummary: Effect.void,
    beforeTreeRemoval: Effect.void
  })
})

const text = new TextEncoder()

const denied = Object.assign(new Vfs.VfsError({ code: "AccessDenied", operation: "readFile" }), {
  code: "AccessDenied" as const
})

const setup = Effect.fnUntraced(function*() {
  const volume = yield* Vfs.make()
  const owner = yield* volume.caller()
  yield* owner.chmod("/", 0o777)
  const caller = yield* volume.caller({ identity: { uid: 1000, gid: 1000, groups: [], privileged: false }, umask: 0 })
  yield* caller.mkdir("/source")

  for (const name of ["a", "b"]) {
    yield* caller.writeFile(`/source/${name}`, text.encode(name), { access: "write", create: "exclusive" })
  }

  const failing = {
    ...caller,
    readFile: Effect.fnUntraced(function*(target: Vfs.TargetInput) {
      if (Vfs.Target.$is("Path")(target)) {
        const path = yield* BytePath.toString(yield* BytePath.fromInput(target.path))

        if (path === "/source/b") return yield* denied
      }

      return yield* caller.readFile(target)
    })
  }

  return { caller, failing }
})

it.effect("copy removes an unfinished reject-mode root but preserves overwrite progress", () =>
  Effect.gen(function*() {
    for (const overwrite of [false, true]) {
      const { caller, failing } = yield* setup()
      const fs = yield* MemoryFileSystem.bindCaller(failing)
      const result = yield* Effect.result(fs.copy("/source", "/copy", { overwrite }))
      assert.isTrue(Result.isFailure(result))
      assert.strictEqual(yield* fs.exists("/copy"), overwrite)

      if (overwrite) assert.strictEqual(yield* fs.readFileString("/copy/a"), "a")
      assert.strictEqual(
        yield* caller.readFile("/source/b").pipe(Effect.map((bytes) => new TextDecoder().decode(bytes))),
        "b"
      )
    }
  }).pipe(Effect.provide(NodeCrypto.layer)))

for (const replacement of ["directory", "symlink"] as const) {
  it.effect(`copy cleanup preserves a replacement ${replacement} and the moved claimed tree`, () =>
    Effect.gen(function*() {
      const { caller, failing } = yield* setup()

      const fs = yield* MemoryFileSystem.bindCaller({
        ...failing,
        readFile: (target) =>
          failing.readFile(target).pipe(Effect.tapError(() =>
            Effect.gen(function*() {
              yield* caller.rename("/copy", "/moved")
              yield* caller.mkdir("/outside")
              yield* caller.writeFile("/outside/keep", text.encode("safe"), { access: "write", create: "exclusive" })

              if (replacement === "symlink") yield* caller.symlink("/outside", "/copy")
              else {
                yield* caller.mkdir("/copy")
                yield* caller.writeFile("/copy/keep", text.encode("safe"), { access: "write", create: "exclusive" })
              }
            })
          ))
      })

      assert.isTrue(Result.isFailure(yield* Effect.result(fs.copy("/source", "/copy"))))
      assert.strictEqual(yield* fs.readFileString("/copy/keep"), "safe")
      assert.strictEqual(yield* fs.readFileString("/moved/a"), "a")
      assert.strictEqual(yield* fs.readFileString("/outside/keep"), "safe")
    }).pipe(Effect.provide(NodeCrypto.layer)))
}

for (const cleanupFails of [false, true]) {
  it.effect(
    cleanupFails
      ? "copy retains interruption and a cleanup defect"
      : "copy interruption removes the claimed root after an interruptible source read",
    () =>
      Effect.gen(function*() {
        const { caller } = yield* setup()
        const waiting = yield* Deferred.make<void>()

        const fs = yield* MemoryFileSystem.bindCaller({
          ...caller,
          remove: cleanupFails ? () => Effect.fail(denied) : caller.remove,
          readFile: (target) =>
            caller.readFile(target).pipe(Effect.andThen(
              Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never))
            ))
        })

        const fiber = yield* Effect.forkChild(fs.copy("/source", "/copy"))
        yield* Deferred.await(waiting)
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        assert.isTrue(Exit.isFailure(exit))

        if (Exit.isFailure(exit)) {
          assert.isTrue(Cause.hasInterrupts(exit.cause))
          assert.strictEqual(Cause.hasDies(exit.cause), cleanupFails)
        }

        assert.strictEqual(yield* fs.exists("/copy"), cleanupFails)
        assert.isTrue(yield* fs.exists("/source/a"))
      }).pipe(Effect.provide(NodeCrypto.layer))
  )
}

for (const cleanupFails of [false, true]) {
  it.effect(
    cleanupFails
      ? "copy restores restrictive modes when cleanup also fails"
      : "copy removes finalized restrictive directories after a metadata failure",
    () =>
      Effect.gen(function*() {
        const { caller } = yield* setup()
        yield* caller.mkdir("/source/nested", { mode: 0o555 })
        yield* caller.chmod("/source", 0o555)

        const fs = yield* MemoryFileSystem.bindCaller({
          ...caller,
          remove: cleanupFails ? () => Effect.fail(denied) : caller.remove,
          utimes: Function.dual(2, (target: Vfs.TargetInput, times: Parameters<Vfs.Caller["utimes"]>[1]) =>
            Effect.gen(function*() {
              if (target === (yield* caller.lookup("/copy"))) {
                return yield* denied
              }

              yield* caller.utimes(target, times)
            }))
        })

        const exit = yield* Effect.exit(fs.copy("/source", "/copy", { preserveTimestamps: true }))
        assert.isTrue(Exit.isFailure(exit))

        if (Exit.isFailure(exit)) {
          assert.strictEqual(Cause.hasDies(exit.cause), cleanupFails)
        }

        assert.strictEqual(yield* fs.exists("/copy"), cleanupFails)

        if (cleanupFails) {
          assert.strictEqual((yield* fs.stat("/copy")).mode & 0o777, 0o555)
          assert.strictEqual((yield* fs.stat("/copy/nested")).mode & 0o777, 0o555)
        }
      }).pipe(Effect.provide(NodeCrypto.layer))
  )
}

it.effect("copy retains the original failure and a cleanup defect", () =>
  Effect.gen(function*() {
    const { caller, failing } = yield* setup()

    const cleanup = Object.assign(new Vfs.VfsError({ code: "AccessDenied", operation: "remove" }), {
      code: "AccessDenied" as const
    })

    const fs = yield* MemoryFileSystem.bindCaller({ ...failing, remove: () => Effect.fail(cleanup) })
    const exit = yield* Effect.exit(fs.copy("/source", "/copy"))
    assert.isTrue(Exit.isFailure(exit))

    if (Exit.isFailure(exit)) {
      assert.deepStrictEqual(exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect), [cleanup])
      const original = Cause.findError(exit.cause)
      assert.isTrue(Result.isSuccess(original))

      if (Result.isSuccess(original)) {
        assert.isTrue(PlatformError.isPlatformError(original.success))
        assert.strictEqual(original.success.cause, denied)
      }

      assert.isFalse(Cause.hasInterrupts(exit.cause))
    }

    assert.strictEqual(yield* (yield* MemoryFileSystem.bindCaller(caller)).readFileString("/copy/a"), "a")
  }).pipe(Effect.provide(NodeCrypto.layer)))

it.effect("copy preserves raw names, dangling link aliases, and nanosecond timestamps", () =>
  Effect.gen(function*() {
    const { caller } = yield* setup()
    const raw = yield* BytePath.fromBytes(new Uint8Array([0xff]))
    const base = yield* caller.openDirectory("/source")
    const target = Vfs.Target.Path({ path: raw, relativeTo: base, followFinalSymlink: false })
    yield* caller.symlink(yield* BytePath.fromBytes(new Uint8Array([0xfe])), target)
    yield* caller.chmod(target, 0o751)
    yield* caller.link(target, "/source/alias")
    yield* caller.utimes(target, {
      access: { kind: "value", nanoseconds: 123n },
      modification: { kind: "value", nanoseconds: 456n }
    })
    const fs = yield* MemoryFileSystem.bindCaller(caller)
    yield* fs.copy("/source", "/copy", { preserveTimestamps: true })

    const copied = Vfs.Target.Path({
      path: raw,
      relativeTo: yield* caller.openDirectory("/copy"),
      followFinalSymlink: false
    })

    const metadata = yield* caller.stat(copied)
    assert.strictEqual(
      metadata.ino,
      (yield* caller.stat(Vfs.Target.Path({ path: "/copy/alias", followFinalSymlink: false }))).ino
    )
    assert.strictEqual(metadata.mode, 0o751)
    assert.strictEqual(metadata.atimeNs, 123n)
    assert.strictEqual(metadata.mtimeNs, 456n)
    assert.deepStrictEqual(yield* caller.readLink(copied), new Uint8Array([0xfe]))
  }).pipe(Effect.provide(NodeCrypto.layer)))

for (const replaced of ["root", "child"] as const) {
  it.effect(`copy cleanup preserves a ${replaced} replacement made after the removal walk observes it`, () =>
    Effect.gen(function*() {
      const { caller, failing } = yield* setup()
      const fs = yield* MemoryFileSystem.bindCaller(failing)
      let reached = false

      const beforeTreeRemoval = Effect.gen(function*() {
        if (reached) return
        reached = true
        const path = replaced === "root" ? "/copy" : "/copy/a"
        yield* caller.rename(path, "/moved")

        if (replaced === "root") {
          yield* caller.mkdir(path)
          yield* caller.writeFile(`${path}/keep`, text.encode("replacement"), { access: "write", create: "exclusive" })
        } else yield* caller.writeFile(path, text.encode("replacement"), { access: "write", create: "exclusive" })
      }).pipe(Effect.orDie)

      const exit = yield* Effect.exit(
        fs.copy("/source", "/copy").pipe(
          Effect.provideService(removalSeam, {
            afterSubscribe: Effect.void,
            betweenSnapshotAndSummary: Effect.void,
            beforeTreeRemoval
          })
        )
      )

      assert.isTrue(reached)
      assert.isTrue(Exit.isFailure(exit))

      if (Exit.isFailure(exit)) assert.isTrue(Cause.hasDies(exit.cause))
      const view = yield* MemoryFileSystem.bindCaller(caller)
      assert.strictEqual(yield* view.readFileString(replaced === "root" ? "/copy/keep" : "/copy/a"), "replacement")
      assert.strictEqual(yield* view.readFileString(replaced === "root" ? "/moved/a" : "/moved"), "a")
    }).pipe(Effect.provide(NodeCrypto.layer)))
}

it.effect("copy cleanup removes concurrent additions listed inside its owned root", () =>
  Effect.gen(function*() {
    const { caller, failing } = yield* setup()

    const fs = yield* MemoryFileSystem.bindCaller({
      ...failing,
      readFile: (target) =>
        failing.readFile(target).pipe(Effect.tapError(() =>
          caller.writeFile("/copy/addition", text.encode("new"), { access: "write", create: "exclusive" })
        ))
    })

    assert.isTrue(Result.isFailure(yield* Effect.result(fs.copy("/source", "/copy"))))
    assert.isFalse(yield* fs.exists("/copy"))
  }).pipe(Effect.provide(NodeCrypto.layer)))

it.effect("copy completes restrictive directory metadata before a late interruption takes effect", () =>
  Effect.gen(function*() {
    const { caller } = yield* setup()
    yield* caller.mkdir("/source/nested", { mode: 0o555 })
    yield* caller.chmod("/source", 0o555)
    const waiting = yield* Deferred.make<void>()
    const resume = yield* Deferred.make<void>()

    const fs = yield* MemoryFileSystem.bindCaller({
      ...caller,
      chmod: Function.dual(2, (target: Vfs.TargetInput, mode: number) =>
        Effect.gen(function*() {
          yield* caller.chmod(target, mode)

          if (mode === 0o555 && target === (yield* caller.lookup("/copy"))) {
            yield* Deferred.succeed(waiting, undefined)
            yield* Deferred.await(resume)
          }
        }))
    })

    const fiber = yield* Effect.forkChild(fs.copy("/source", "/copy"))
    yield* Deferred.await(waiting)
    const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber), { startImmediately: true })
    yield* Deferred.succeed(resume, undefined)
    yield* Fiber.join(interrupting)
    const exit = yield* Fiber.await(fiber)
    assert.isTrue(Exit.isFailure(exit))

    if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterrupts(exit.cause))
    assert.strictEqual((yield* fs.stat("/copy")).mode & 0o777, 0o555)
    assert.strictEqual((yield* fs.stat("/copy/nested")).mode & 0o777, 0o555)
    assert.strictEqual(yield* fs.readFileString("/copy/a"), "a")
  }).pipe(Effect.provide(NodeCrypto.layer)))

it.effect("copy overwrites root and dot-ending directory destinations", () =>
  Effect.gen(function*() {
    for (const destination of ["/", "/destination/.", "/destination/child/.."]) {
      const { caller } = yield* setup()
      yield* caller.mkdir("/destination/child", { recursive: true })
      const fs = yield* MemoryFileSystem.bindCaller(caller)
      yield* fs.copy("/source", destination, { overwrite: true })
      const prefix = destination === "/" ? "" : "/destination"
      assert.strictEqual(yield* fs.readFileString(`${prefix}/a`), "a")
      assert.strictEqual(yield* fs.readFileString(`${prefix}/b`), "b")
    }
  }).pipe(Effect.provide(NodeCrypto.layer)))
