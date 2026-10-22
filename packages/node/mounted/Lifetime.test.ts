// Exercise native resources during Effect scope unwinding and synchronous reentry.
/* eslint-disable effecttsgo/async-function, effecttsgo/node-builtin-import, effecttsgo/run-effect-inside-effect */
import * as Vfs from "@effect-vfs/core/VirtualFileSystem"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { once } from "node:events"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import { setImmediate } from "node:timers/promises"
import { expect, it } from "vitest"
import { mount, type Mounted } from "./fixture.js"

it.each(["success", "failure", "interruption"] as const)(
  "should drain owned Node resources before binding teardown on %s",
  async (outcome) => {
    let owned: Mounted | undefined
    let fd = -1
    let handle: fsp.FileHandle | undefined
    let stream: fs.ReadStream | undefined

    const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function*() {
      const m = yield* Effect.acquireRelease(
        Effect.promise(() => mount()),
        (fixture) => Effect.promise(() => fixture.close())
      )

      owned = m
      fs.writeFileSync(m.path("/file"), "orphan")
      fd = m.ownFd(fs.openSync(m.path("/file"), "r+"))
      handle = m.ownHandle(yield* Effect.promise(() => fsp.open(m.path("/file"), "r+")))
      const reading = m.ownStream(fs.createReadStream(m.path("/file")))
      stream = reading
      yield* Effect.promise(() => once(reading, "open"))
      fs.unlinkSync(m.path("/file"))

      if (outcome === "failure") return yield* Effect.fail("expected failure")

      if (outcome === "interruption") return yield* Effect.interrupt
    })))

    expect(Exit.isSuccess(exit)).toBe(outcome === "success")

    if (outcome === "failure" && Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe("expected failure")

    if (outcome === "interruption" && Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)

    if (owned === undefined) throw new Error("Mounted resource acquisition did not complete")
    expect(stream?.closed).toBe(true)
    expect(handle?.fd).toBe(-1)
    expect(() => fs.fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }))
    const root = owned.path("/")
    expect(() => fs.statSync(root)).toThrow()
    expect((await Effect.runPromise(owned.volume.usage)).usedBytes).toBe(0n)
    await setImmediate()
    expect((await Effect.runPromise(owned.volume.usage)).usedBytes).toBe(0n)
  }
)

it("should reject a reentrant descriptor close without removing ownership", async () => {
  const clock = Effect.runSync(Clock.clockWith(Effect.succeed))
  let hook: (() => void) | undefined

  const volume = await Effect.runPromise(
    Vfs.make({ execution: "sync" }).pipe(
      Effect.provide(NodeCrypto.layer),
      Effect.provideService(Clock.Clock, {
        currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
        currentTimeMillis: clock.currentTimeMillis,
        currentTimeNanos: clock.currentTimeNanos,
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: clock.monotonicTimeNanos,
        sleep: (duration) => clock.sleep(duration),
        currentTimeNanosUnsafe: () => {
          hook?.()

          return clock.currentTimeNanosUnsafe()
        }
      })
    )
  )

  const m = await mount(undefined, volume)

  try {
    fs.writeFileSync(m.path("/file"), "owned")
    const fd = m.ownFd(fs.openSync(m.path("/file"), "r+"))
    fs.unlinkSync(m.path("/file"))
    let attempts = 0
    hook = () => {
      attempts++
      expect(() => fs.closeSync(fd)).toThrow(expect.objectContaining({ code: "EBUSY" }))
      expect(() => fs.writeFileSync(m.path("/late"), "no")).toThrow(expect.objectContaining({ code: "EBUSY" }))
    }

    fs.mkdirSync(m.path("/outer"))
    hook = undefined
    expect(attempts).toBeGreaterThan(0)
    expect(fs.fstatSync(fd).size).toBe(5)
    await setImmediate()
    expect(fs.existsSync(m.path("/late"))).toBe(false)
    await m.close()
    expect((await Effect.runPromise(volume.usage)).usedBytes).toBe(0n)
  } finally {
    hook = undefined
    await m.close()
  }
})
