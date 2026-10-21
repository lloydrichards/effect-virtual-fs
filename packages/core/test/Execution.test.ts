// Exercise the synchronous JavaScript boundary alongside live Effect fibers.
/* eslint-disable effecttsgo/async-function */
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
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
  Result,
  Scheduler,
  Schema,
  Scope,
  Stream
} from "effect"
import type * as Tracer from "effect/Tracer"
import { LiveVolume, VirtualFileSystem as Vfs } from "../src/index.js"
import { makeEngine, memoryCommitProvider, State, withVolumeTestSeams } from "../src/internal/engine.js"

const run = Effect.runSync

const text = new TextEncoder()

const create = { access: "write", create: "exclusive" } as const

const failure = <A>(effect: Effect.Effect<A, Vfs.VfsError>) => {
  const exit = Effect.runSyncExit(effect)
  assert.isTrue(Exit.isFailure(exit))

  if (Exit.isSuccess(exit)) return assert.fail("Expected failure")
  const error = Cause.squash(exit.cause)

  if (!Schema.is(Vfs.VfsError)(error)) return assert.fail(`Expected settled VfsError: ${String(error)}`)

  return error
}

const withNanos = (clock: Clock.Clock, nanos: () => bigint): Clock.Clock => ({
  currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
  currentTimeMillis: clock.currentTimeMillis,
  currentTimeNanosUnsafe: nanos,
  currentTimeNanos: Effect.sync(nanos),
  monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: clock.monotonicTimeNanos,
  sleep: (duration) => clock.sleep(duration)
})

const make = (options?: Vfs.VolumeOptions) =>
  Effect.runPromise(Vfs.make(options).pipe(Effect.provide(NodeCrypto.layer)))

describe("volume execution", () => {
  it("should share a sync volume across Effect and synchronous callers without a queued write", async () => {
    const volume = await make({ execution: "sync" })
    const caller = run(volume.caller())
    const deep = "/" + Array(160).fill("d").join("/")
    const mutation = Effect.runFork(caller.mkdir(deep, { recursive: true }))
    run(caller.mkdir("/sync"))
    await Effect.runPromise(Fiber.join(mutation))
    assert.strictEqual(run(caller.stat("/sync")).kind, "directory")
    const scope = Scope.makeUnsafe()
    const rooted = run(caller.withRoot(deep).pipe(Effect.provideService(Scope.Scope, scope)))
    run(rooted.writeFile("/data", text.encode("shared"), create))
    assert.deepStrictEqual(await Effect.runPromise(caller.readFile(deep + "/data")), text.encode("shared"))
    run(Scope.close(scope, Exit.void))
    assert.strictEqual(failure(rooted.stat("/")).code, "ClosedCaller")
  })

  for (const execution of ["cooperative", "sync"] as const) {
    it(`should preserve positional I/O, links, open-unlinked files and admission reuse in ${execution} mode`, async () => {
      const engine = run(makeEngine({ execution, limits: { maxPendingOperations: 1 } }))
      const caller = run(engine.context()).operations
      const scope = Scope.makeUnsafe()
      await Effect.runPromise(caller.writeFile("/file", text.encode("abcd"), create))
      const handle = run(caller.open("/file", { access: "readWrite" }).pipe(Effect.provideService(Scope.Scope, scope)))
      run(caller.link("/file", "/alias"))
      assert.deepStrictEqual(run(handle.read(1)), text.encode("a"))
      assert.deepStrictEqual(run(handle.pread(2, 1n)).bytes, text.encode("bc"))
      run(handle.pwrite(text.encode("X"), 2n))
      assert.strictEqual(run(handle.seek(0n, "current")), 1n)
      run(handle.write(text.encode("Y")))
      assert.deepStrictEqual(run(caller.readFile("/alias")), text.encode("aYXd"))
      run(caller.unlink("/file"))
      run(caller.unlink("/alias"))
      assert.strictEqual(run(engine.usage).usedBytes, 4n)
      run(handle.close)
      run(Scope.close(scope, Exit.void))
      assert.strictEqual(run(engine.usage).usedBytes, 0n)
      assert.strictEqual(failure(handle.stat).code, "InvalidHandle")
      run(caller.mkdir("/after-close"))
    })
  }

  it("should default to cooperative execution and restore or overlay with an independent mode", async () => {
    assert.isUndefined(run(makeEngine()).syncBinding)
    const original = await make({ execution: "sync" })
    run((run(original.caller())).writeFile("/file", text.encode("before"), create))
    const snapshot = run(original.snapshot)

    const restored = await Effect.runPromise(
      Vfs.fromSnapshot(snapshot, { execution: "sync" }).pipe(Effect.provide(NodeCrypto.layer))
    )

    const overlay = await Effect.runPromise(
      Vfs.makeOverlay(snapshot, { execution: "sync" }).pipe(Effect.provide(NodeCrypto.layer))
    )

    run((run(overlay.caller())).writeFile("/file", text.encode("after"), { access: "write", truncate: true }))
    assert.deepStrictEqual(run((run(restored.caller())).readFile("/file")), text.encode("before"))
    assert.strictEqual((await Effect.runPromise(overlay.capture())).changes.length, 1)

    const fixture = await Effect.runPromise(
      Vfs.fromFixture({ entries: [] }, { execution: "sync" }).pipe(Effect.provide(NodeCrypto.layer))
    )

    run((run(fixture.caller())).mkdir("/fixture"))
  })

  it("should reject a falsely labelled memory provider before calling its commit or clock", () => {
    let invoked = false

    const provider = {
      ...memoryCommitProvider,
      commit: () => {
        invoked = true

        return Effect.succeed("committed" as const)
      }
    }

    const clock = run(Clock.clockWith(Effect.succeed))

    const construction = makeEngine({ execution: "sync", commitProvider: provider }).pipe(
      Effect.provideService(
        Clock.Clock,
        withNanos(clock, () => {
          invoked = true

          return 0n
        })
      )
    )

    assert.strictEqual(failure(construction).field, "execution")
    assert.isFalse(invoked)
  })

  it("should reject sync live stores before loading or committing an image", async () => {
    let touched = false

    const store = LiveVolume.LiveImageStore.of({
      loadOrCreate: () => {
        touched = true

        return Effect.succeed(new Uint8Array())
      },
      commit: () => {
        touched = true

        return Effect.succeed("committed")
      }
    })

    const result = await Effect.runPromise(Effect.result(
      LiveVolume.open({
        volume: { execution: "sync" },
        maxImageBytes: ByteSize.bytes(1024)
      }).pipe(Effect.provideService(LiveVolume.LiveImageStore, store), Effect.provide(NodeCrypto.layer), Effect.scoped)
    ))

    assert.isTrue(Result.isFailure(result))

    if (Result.isFailure(result)) assert.strictEqual(result.failure.field, "volume.execution")
    assert.isFalse(touched)
  })

  it("should reject reentrant operations before scope acquisition and never publish them later", async () => {
    let hook: (() => void) | undefined
    const clock = run(Clock.clockWith(Effect.succeed))

    const engine = run(
      makeEngine({ execution: "sync" }).pipe(Effect.provideService(
        Clock.Clock,
        withNanos(clock, () => {
          hook?.()

          return clock.currentTimeNanosUnsafe()
        })
      ))
    )

    const caller = run(engine.context()).operations
    const scope = Scope.makeUnsafe()
    hook = () => {
      assert.strictEqual(failure(caller.stat("/")).code, "VolumeBusy")
      assert.strictEqual(
        failure(caller.open("/nested", create).pipe(Effect.provideService(Scope.Scope, scope))).code,
        "VolumeBusy"
      )
      assert.strictEqual(
        failure(caller.openDirectory("/").pipe(Effect.provideService(Scope.Scope, scope))).code,
        "VolumeBusy"
      )
      assert.isTrue(Result.isFailure(engine.syncBinding!.check("close")))
    }

    run(caller.mkdir("/outer"))
    hook = undefined
    run(Scope.close(scope, Exit.void))
    await Effect.runPromise(Effect.sleep("1 millis"))
    assert.strictEqual(failure(caller.stat("/nested")).code, "NotFound")
    assert.strictEqual(run(engine.capture("test")).open.size, 0)
  })

  for (const outcome of ["success", "failure", "defect"] as const) {
    it(`should reclaim reentrantly closed file and directory ownership before outer ${outcome} returns`, () => {
      let hook: (() => void) | undefined
      let invalidTime = false
      const clock = run(Clock.clockWith(Effect.succeed))

      const engine = run(
        makeEngine({ execution: "sync" }).pipe(Effect.provideService(
          Clock.Clock,
          withNanos(clock, () => {
            hook?.()

            return invalidTime ? 10n ** 129n : clock.currentTimeNanosUnsafe()
          })
        ))
      )

      const caller = run(engine.context()).operations
      const scope = Scope.makeUnsafe(outcome === "success" ? "parallel" : "sequential")
      run(caller.writeFile("/held", text.encode("held"), create))
      const handle = run(caller.open("/held", { access: "readWrite" }).pipe(Effect.provideService(Scope.Scope, scope)))
      run(caller.mkdir("/directory"))
      const directory = run(caller.openDirectory("/directory").pipe(Effect.provideService(Scope.Scope, scope)))
      run(caller.unlink("/held"))
      run(caller.rmdir("/directory"))
      hook = () => {
        hook = undefined
        run(Scope.close(scope, Exit.void))

        if (outcome === "failure") invalidTime = true

        if (outcome === "defect") throw new Error("hook failed")
      }

      const outer = Effect.runSyncExit(caller.mkdir("/outer"))
      invalidTime = false
      assert.strictEqual(Exit.isSuccess(outer), outcome === "success")
      assert.strictEqual(run(engine.usage).usedBytes, 0n)
      assert.strictEqual(failure(handle.stat).code, "InvalidHandle")
      assert.strictEqual(failure(directory.stat).code, "InvalidHandle")
      const state = run(engine.capture("test"))
      assert.strictEqual(Array.from(state.inodes).filter(([, node]) => node.metadata.nlink === 0).length, 0)
    })
  }

  for (const when of ["before", "after"] as const) {
    it(`should release acquisition when its scope closes ${when} publication`, () => {
      let hook: (() => void) | undefined
      let installed: (() => void) | undefined
      const clock = run(Clock.clockWith(Effect.succeed))

      const engine = run(
        makeEngine({ execution: "sync", installed: () => installed?.() }).pipe(
          Effect.provideService(
            Clock.Clock,
            withNanos(clock, () => {
              hook?.()

              return clock.currentTimeNanosUnsafe()
            })
          )
        )
      )

      const caller = run(engine.context()).operations
      const scope = Scope.makeUnsafe()

      const close = () => {
        hook = undefined
        installed = undefined
        run(Scope.close(scope, Exit.void))
      }

      if (when === "before") hook = close
      else installed = close
      const opened = Effect.runSyncExit(caller.open("/created", create).pipe(Effect.provideService(Scope.Scope, scope)))
      assert.isTrue(Exit.isFailure(opened))
      assert.strictEqual(run(engine.capture("test")).open.size, 0)
      assert.strictEqual(Exit.isSuccess(Effect.runSyncExit(caller.stat("/created"))), when === "after")
    })
  }

  it("should reject injected Effects before recursive removal invokes a hook or changes state", () => {
    const caller = run((run(makeEngine({ execution: "sync" }))).context()).operations
    run(caller.mkdir("/tree/child", { recursive: true }))
    let invoked = false

    const remove = caller.remove("/tree", { recursive: true }).pipe(withVolumeTestSeams({
      beforeTreeRemoval: Effect.andThen(
        Effect.sync(() => {
          invoked = true
        }),
        Effect.sleep("1 millis")
      )
    }))

    assert.strictEqual(failure(remove).code, "InvalidArgument")
    assert.isFalse(invoked)
    assert.strictEqual(run(caller.stat("/tree/child")).kind, "directory")
  })

  it("should capture persistent state without holding ownership during subsequent Effects", async () => {
    const engine = run(makeEngine({ execution: "sync" }))
    const caller = run(engine.context()).operations
    const captured = run(engine.capture("test"))
    const pending = Effect.runFork(Effect.andThen(Effect.yieldNow, Effect.succeed(captured.revision)))
    run(caller.mkdir("/later"))
    assert.strictEqual(await Effect.runPromise(Fiber.join(pending)), captured.revision)
    assert.isTrue(run(engine.capture("test")).revision > captured.revision)
    assert.strictEqual(State.getNode(captured, State.ROOT_INO)!.kind, "directory")
  })
  it("should keep rejecting ordinary reentry while draining every release after a cleanup defect", () => {
    let hook: (() => void) | undefined
    let installed: (() => void) | undefined
    const defect = new Error("cleanup installation failed")
    const clock = run(Clock.clockWith(Effect.succeed))

    const engine = run(
      makeEngine({ execution: "sync", installed: () => installed?.() }).pipe(
        Effect.provideService(
          Clock.Clock,
          withNanos(clock, () => {
            hook?.()

            return clock.currentTimeNanosUnsafe()
          })
        )
      )
    )

    const caller = run(engine.context()).operations
    const scope = Scope.makeUnsafe()

    const handles = ["a", "b"].map((name) => {
      run(caller.writeFile("/" + name, new Uint8Array([1]), create))
      const handle = run(caller.open("/" + name, { access: "read" }).pipe(Effect.provideService(Scope.Scope, scope)))
      run(caller.unlink("/" + name))

      return handle
    })

    hook = () => {
      hook = undefined
      run(Scope.close(scope, Exit.void))
    }

    let installs = 0
    installed = () => {
      assert.strictEqual(failure(caller.stat("/")).code, "VolumeBusy")

      if (++installs === 2) throw defect
    }

    const outer = Effect.runSyncExit(caller.mkdir("/outer"))
    installed = undefined
    assert.isTrue(Exit.isFailure(outer))

    if (Exit.isFailure(outer)) assert.strictEqual(Cause.squash(outer.cause), defect)
    assert.strictEqual(run(engine.usage).usedBytes, 0n)

    for (const handle of handles) assert.strictEqual(failure(handle.stat).code, "InvalidHandle")
    assert.strictEqual(run(caller.stat("/outer")).kind, "directory")
  })

  it("should deliver interruption after a started transition and its cleanup finish", () => {
    const engine = run(makeEngine({ execution: "sync" }))
    const caller = run(engine.context()).operations
    const tracer = run(Effect.tracer)
    let interrupted = false

    const hooked: Tracer.Tracer = {
      span: (options) => tracer.span(options),
      context(primitive, fiber) {
        if (!interrupted && Result.isFailure(engine.syncBinding!.check("probe"))) {
          interrupted = true
          fiber.interruptUnsafe()
        }

        return primitive["~effect/Effect/evaluate"](fiber)
      }
    }

    const exit = Effect.runSyncExit(caller.mkdir("/committed").pipe(Effect.withTracer(hooked)))
    assert.isTrue(interrupted)
    assert.isTrue(Exit.isFailure(exit))

    if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterrupts(exit.cause))
    assert.strictEqual(run(caller.stat("/committed")).kind, "directory")
  })

  it("should not start an interrupted operation that has not entered the volume", async () => {
    const caller = run((run(makeEngine({ execution: "sync" }))).context()).operations
    const ready = Deferred.makeUnsafe<void>()
    const waiting = Effect.runFork(Effect.andThen(Deferred.await(ready), caller.mkdir("/cancelled")))
    await Effect.runPromise(Fiber.interrupt(waiting))
    run(Deferred.succeed(ready, undefined))
    assert.strictEqual(failure(caller.stat("/cancelled")).code, "NotFound")
  })

  it("should close a watch reentrantly and run consumer mutations after ownership is released", async () => {
    let hook: (() => void) | undefined
    const clock = run(Clock.clockWith(Effect.succeed))

    const volume = await Effect.runPromise(
      Vfs.make({ execution: "sync" }).pipe(
        Effect.provide(NodeCrypto.layer),
        Effect.provideService(
          Clock.Clock,
          withNanos(clock, () => {
            hook?.()

            return clock.currentTimeNanosUnsafe()
          })
        )
      )
    )

    const caller = run(volume.caller())
    const scope = Scope.makeUnsafe()
    const events = run(volume.watch().pipe(Effect.provideService(Scope.Scope, scope)))
    let delivered = 0

    const reader = Effect.runFork(Stream.runForEach(events, () =>
      Effect.sync(() => {
        delivered++
      })))

    hook = () => {
      hook = undefined
      run(Scope.close(scope, Exit.void))
    }

    run(caller.mkdir("/after-close"))
    const stopped = await Effect.runPromiseExit(Fiber.join(reader))
    assert.isTrue(Exit.isFailure(stopped))
    assert.strictEqual(delivered, 0)
    const otherScope = Scope.makeUnsafe()
    const other = run(volume.watch().pipe(Effect.provideService(Scope.Scope, otherScope)))
    const callback = Effect.runFork(Stream.runForEach(other.pipe(Stream.take(1)), () => caller.mkdir("/callback")))
    run(caller.mkdir("/published"))
    await Effect.runPromise(Fiber.join(callback))
    run(Scope.close(otherScope, Exit.void))
    assert.strictEqual(run(caller.stat("/callback")).kind, "directory")
  })
  it("should keep scheduler yield callbacks outside sync ownership", () => {
    const engine = run(makeEngine({ execution: "sync" }))
    const caller = run(engine.context()).operations
    const ordinary = new Scheduler.MixedScheduler("sync")
    let consulted = 0

    const scheduler: Scheduler.Scheduler = {
      executionMode: "sync",
      makeDispatcher: () => ordinary.makeDispatcher(),
      shouldYield(fiber) {
        consulted++
        assert.isTrue(Result.isSuccess(engine.syncBinding!.check("probe")))

        return ordinary.shouldYield(fiber)
      }
    }

    run(caller.mkdir("/scheduled").pipe(Effect.provideService(Scheduler.Scheduler, scheduler)))
    assert.isTrue(consulted > 0)
  })

  it("should pair a captured sync overlay snapshot and summary while a competing write completes", async () => {
    const original = await make({ execution: "sync" })
    const caller = run(original.caller())
    run(caller.writeFile("/file", text.encode("before"), create))

    const overlay = await Effect.runPromise(
      Vfs.makeOverlay(run(original.snapshot), { execution: "sync" }).pipe(Effect.provide(NodeCrypto.layer))
    )

    const writer = run(overlay.caller())
    const pending = Effect.runFork(overlay.capture())
    run(writer.writeFile("/file", text.encode("after"), { access: "write", truncate: true }))
    const captured = await Effect.runPromise(Fiber.join(pending))
    assert.strictEqual(captured.changes.length, 0)

    const restored = await Effect.runPromise(
      Vfs.fromSnapshot(captured.snapshot, { execution: "sync" }).pipe(Effect.provide(NodeCrypto.layer))
    )

    assert.deepStrictEqual(run((run(restored.caller())).readFile("/file")), text.encode("before"))
    assert.strictEqual((await Effect.runPromise(overlay.capture())).changes.length, 1)
  })
  it("should reject a sync live registry before constructing a store layer", async () => {
    let constructed = false

    const result = await Effect.runPromise(Effect.result(
      LiveVolume.makeRegistry({
        volume: { volume: { execution: "sync" }, maxImageBytes: ByteSize.bytes(1024) },
        store: (_key: string) => {
          constructed = true

          return Layer.succeed(
            LiveVolume.LiveImageStore,
            LiveVolume.LiveImageStore.of({
              loadOrCreate: (initial) => Effect.succeed(initial),
              commit: () => Effect.succeed("committed")
            })
          )
        }
      }).pipe(Effect.provide(NodeCrypto.layer), Effect.scoped)
    ))

    assert.isTrue(Result.isFailure(result))

    if (Result.isFailure(result)) assert.strictEqual(result.failure.field, "volume.volume.execution")
    assert.isFalse(constructed)
  })
})
