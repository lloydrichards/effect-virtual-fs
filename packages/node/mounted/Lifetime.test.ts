// Exercise native resources during Effect scope unwinding and synchronous reentry.
/* eslint-disable effecttsgo/async-function, effecttsgo/node-builtin-import, effecttsgo/run-effect-inside-effect */
import * as Vfs from "@effect-vfs/core/VirtualFileSystem"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { once } from "node:events"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import { createRequire } from "node:module"
import { basename, dirname } from "node:path"
import { setImmediate } from "node:timers/promises"
import { afterEach, beforeEach, expect, it } from "vitest"
import { mount, type Mounted } from "./fixture.js"

// Only the ownership worker exposes this pinned Node API; production code never imports it.
const registry: { getVirtualFd(fd: number): object | undefined } = createRequire(import.meta.url)("internal/vfs/fd")

let sibling: Mounted | undefined

beforeEach(async () => {
  sibling = await mount()
})

afterEach(async () => {
  await sibling?.close()
  sibling = undefined
})

const expectReleased = (owner: Mounted, descriptors: ReadonlyArray<number>) => {
  for (const fd of descriptors) expect(registry.getVirtualFd(fd), `descriptor ${fd} remains registered`).toBeUndefined()

  if (sibling === undefined) throw new Error("Sibling mount was not acquired")
  const layers = fs.readdirSync(dirname(owner.root))
  expect(layers).toContain(basename(sibling.root))
  expect(layers, "owner mount remains registered").not.toContain(basename(owner.root))
}

it.each(["success", "failure", "interruption"] as const)(
  "should drain owned Node resources before binding teardown on %s",
  async (outcome) => {
    let owned: Mounted | undefined
    const descriptors: Array<number> = []
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
      descriptors.push(fd)
      handle = m.ownHandle(yield* Effect.promise(() => fsp.open(m.path("/file"), "r+")))
      descriptors.push(handle.fd)
      const reading = m.ownStream(fs.createReadStream(m.path("/file")))
      stream = reading
      const [opened]: ReadonlyArray<unknown> = yield* Effect.promise(() => once(reading, "open"))

      const streamFd = yield* Schema.decodeUnknownEffect(Schema.Natural)(opened)
      descriptors.push(streamFd)

      for (const registered of descriptors) expect(registry.getVirtualFd(registered)).toBeDefined()
      expect(fs.readdirSync(dirname(m.root))).toContain(basename(m.root))
      fs.unlinkSync(m.path("/file"))

      if (outcome === "failure") return yield* Effect.fail("expected failure")

      if (outcome === "interruption") return yield* Effect.interrupt
    })))

    expect(Exit.isSuccess(exit)).toBe(outcome === "success")

    if (outcome === "failure" && Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe("expected failure")

    if (outcome === "interruption" && Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)

    if (owned === undefined) throw new Error("Mounted resource acquisition did not complete")
    expectReleased(owned, descriptors)
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
      expect(registry.getVirtualFd(fd)).toBeDefined()
      expect(() => fs.writeFileSync(m.path("/late"), "no")).toThrow(expect.objectContaining({ code: "EBUSY" }))
    }

    fs.mkdirSync(m.path("/outer"))
    hook = undefined
    expect(attempts).toBeGreaterThan(0)
    expect(fs.fstatSync(fd).size).toBe(5)
    await setImmediate()
    expect(fs.existsSync(m.path("/late"))).toBe(false)
    await m.close()
    expectReleased(m, [fd])
    expect((await Effect.runPromise(volume.usage)).usedBytes).toBe(0n)
  } finally {
    hook = undefined
    await m.close()
  }
})
