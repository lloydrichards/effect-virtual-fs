// Reentry happens through a synchronous Clock callback, outside an Effect test fiber.
/* eslint-disable effecttsgo/async-function, effecttsgo/node-builtin-import */
import * as Vfs from "@effect-vfs/core/VirtualFileSystem"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Scope from "effect/Scope"
import { setImmediate } from "node:timers/promises"
import { expect, it } from "vitest"
import * as NodeVfs from "../src/NodeVirtualProvider.js"

const clockWith = (clock: Clock.Clock, nanos: () => bigint): Clock.Clock => ({
  currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
  currentTimeMillis: clock.currentTimeMillis,
  currentTimeNanosUnsafe: nanos,
  currentTimeNanos: Effect.sync(nanos),
  monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: clock.monotonicTimeNanos,
  sleep: (duration) => clock.sleep(duration)
})

it("should reject reentry before closing a scope or starting a delayed mutation", async () => {
  const clock = Effect.runSync(Clock.clockWith(Effect.succeed))
  let hook: (() => void) | undefined

  const volume = await Effect.runPromise(
    Vfs.make({ execution: "sync" }).pipe(
      Effect.provide(NodeCrypto.layer),
      Effect.provideService(
        Clock.Clock,
        clockWith(clock, () => {
          hook?.()

          return clock.currentTimeNanosUnsafe()
        })
      )
    )
  )

  const scope = Scope.makeUnsafe()

  try {
    const provider = await Effect.runPromise(NodeVfs.bind(volume).pipe(Effect.provideService(Scope.Scope, scope)))
    provider.writeFileSync("/held", "owned")
    const handle = provider.openSync("/held", "r+")
    provider.unlinkSync("/held")
    let calls = 0
    hook = () => {
      calls++
      expect(() => handle.closeSync()).toThrow(expect.objectContaining({ code: "EBUSY", syscall: "close" }))
      expect(handle.closed).toBe(false)
      expect(() => provider.openSync("/late", "w")).toThrow(expect.objectContaining({ code: "EBUSY" }))
    }

    provider.mkdirSync("/outer")
    hook = undefined
    expect(calls).toBeGreaterThan(0)
    expect(handle.statSync().size).toBe(5)
    await setImmediate()
    expect(provider.existsSync("/late")).toBe(false)
    handle.closeSync()
    expect((await Effect.runPromise(volume.usage)).usedBytes).toBe(0n)
    await Effect.runPromise(Scope.close(scope, Exit.void))
    expect((await Effect.runPromise(volume.usage)).usedBytes).toBe(0n)
  } finally {
    hook = undefined
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

it("should release an orphan when the owner scope closes reentrantly", async () => {
  const clock = Effect.runSync(Clock.clockWith(Effect.succeed))
  let hook: (() => void) | undefined

  const volume = await Effect.runPromise(
    Vfs.make({ execution: "sync" }).pipe(
      Effect.provide(NodeCrypto.layer),
      Effect.provideService(
        Clock.Clock,
        clockWith(clock, () => {
          hook?.()

          return clock.currentTimeNanosUnsafe()
        })
      )
    )
  )

  const scope = Scope.makeUnsafe()

  try {
    const provider = await Effect.runPromise(NodeVfs.bind(volume).pipe(Effect.provideService(Scope.Scope, scope)))
    provider.writeFileSync("/held", "owned")
    const handle = provider.openSync("/held", "r+")
    provider.unlinkSync("/held")
    hook = () => {
      Effect.runSync(Scope.close(scope, Exit.void))
    }

    provider.mkdirSync("/outer")
    hook = undefined
    expect(handle.closed).toBe(true)
    expect(() => handle.statSync()).toThrow(expect.objectContaining({ code: "EBADF" }))
    expect((await Effect.runPromise(volume.usage)).usedBytes).toBe(0n)
  } finally {
    hook = undefined
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})
