import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Clock, Effect, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Testing, VirtualFileSystem as Vfs } from "../src/index.js"
import { pathText } from "./support/text.js"

const OWNER = { uid: 9, gid: 9, groups: [], privileged: false } as const

const EXPLICIT_TIMES = {
  access: { kind: "value", nanoseconds: 1n },
  modification: { kind: "value", nanoseconds: 2n }
} as const

// A clock that moves forward on every reading, so two readings in one call cannot agree.
const tickingClock = (): Clock.Clock => {
  let now = 1_000n
  const tick = () => (now += 1_000n)

  return {
    currentTimeMillisUnsafe: () => Number(now / 1_000_000n),
    currentTimeMillis: Effect.sync(() => Number(now / 1_000_000n)),
    currentTimeNanosUnsafe: tick,
    currentTimeNanos: Effect.sync(tick),
    monotonicTimeNanosUnsafe: () => 0n,
    monotonicTimeNanos: Effect.succeed(0n),
    sleep: () => Effect.void
  }
}

// A file /f with four bytes, mode 0o644, owned by OWNER.
const ownedFile = Effect.gen(function*() {
  const fs = yield* Vfs.Caller
  yield* fs.writeFile("/f", new Uint8Array([1, 2, 3, 4]), { access: "write", create: "exclusive", mode: 0o644 })
  yield* fs.chown("/f", { uid: OWNER.uid, gid: OWNER.gid })

  return yield* fs.stat("/f")
})

describe("setattr", () => {
  it.effect("names the first invalid attribute in field before resolving the target", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller

      // SAFETY: the malformed attributes are the input under test; setattr validates them at runtime.
      const malformed = [
        { size: -1n, mode: -1 },
        { mode: 0o10000 },
        { owner: { uid: -1 } },
        { times: { access: { kind: "now" }, modification: { kind: "later" } } },
        { expected: { revision: 1 } },
        { size: 0n, extra: true }
      ] as ReadonlyArray<Vfs.SetattrOptions>

      const fields = yield* Effect.forEach(
        malformed,
        (attributes) =>
          Effect.map(Effect.flip(fs.setattr("/missing", attributes)), (error) => [error.code, error.field])
      )

      assert.deepStrictEqual(fields, [
        ["InvalidArgument", "size"],
        ["InvalidArgument", "mode"],
        ["InvalidArgument", "owner"],
        ["InvalidArgument", "times"],
        ["InvalidArgument", "expected"],
        ["InvalidArgument", "extra"]
      ])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("fails typed on attributes that are not an object", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* ownedFile

      const malformed: ReadonlyArray<unknown> = [null, undefined, 5, "size", [0n]]

      const codes = yield* Effect.forEach(
        malformed,
        (attributes) =>
          // SAFETY: the non-object attributes are the input under test; setattr validates them at runtime.
          Effect.map(Effect.flip(fs.setattr("/f", attributes as Vfs.SetattrOptions)), (error) => error.code)
      )

      assert.deepStrictEqual(codes, Array(malformed.length).fill("InvalidArgument"))
    }).pipe(Effect.provide(Testing.layer())))

  it("publishes a schema that rejects what setattr rejects", () => {
    const is = Schema.is(Vfs.SetattrOptions)

    assert.isFalse(is({ size: -1n }))
    assert.isTrue(is({ size: 0n }))
  })

  it.effect("leaves every attribute unapplied when a later check fails", () =>
    Effect.gen(function*() {
      const before = yield* ownedFile
      const owner = yield* Testing.callerAs(OWNER)

      // The size and mode pass their checks; giving the file away does not.
      const error = yield* Effect.flip(owner.setattr("/f", { size: 0n, mode: 0o600, owner: { uid: 0 } }))

      assert.strictEqual(error.code, "NotPermitted")
      assert.strictEqual(yield* pathText(error.path), "/f")
      assert.deepStrictEqual(yield* owner.stat("/f"), before)
      assert.deepStrictEqual(yield* owner.readFile("/f"), new Uint8Array([1, 2, 3, 4]))
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("leaves every attribute unapplied when the resize runs out of space", () =>
    Effect.gen(function*() {
      const before = yield* ownedFile
      const fs = yield* Vfs.Caller

      const error = yield* Effect.flip(fs.setattr("/f", { size: 64n, mode: 0o600, times: EXPLICIT_TIMES }))

      assert.strictEqual(error.code, "NoSpace")
      assert.deepStrictEqual(yield* fs.stat("/f"), before)
    }).pipe(Effect.provide(Testing.layer({ volume: { maxBytes: ByteSize.bytes(16) } }))))

  it.effect("applies every attribute under one revision and one clock reading", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(5)
      yield* ownedFile
      const fs = yield* Vfs.Caller
      const earlier = (yield* fs.mkdir("/earlier")).directory.after

      yield* fs.setattr("/f", { size: 2n, mode: 0o600, owner: { gid: 0 }, times: EXPLICIT_TIMES })
      const changed = yield* fs.stat("/f")
      const later = (yield* fs.mkdir("/later")).directory.after

      assert.deepStrictEqual(
        [changed.size, changed.mode, changed.gid, changed.atimeNs, changed.mtimeNs, changed.ctimeNs],
        [2n, 0o600, 0, 1n, 2n, 5_000_000n]
      )
      assert.strictEqual(changed.revision, earlier + 1n)
      assert.strictEqual(later, earlier + 2n)
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("stamps a resize and times set to now with the one clock reading of the change", () =>
    Effect.gen(function*() {
      yield* ownedFile
      const fs = yield* Vfs.Caller

      yield* fs.setattr("/f", { size: 2n, mode: 0o600 })
      const resized = yield* fs.stat("/f")
      assert.strictEqual(resized.mtimeNs, resized.ctimeNs)

      yield* fs.setattr("/f", { times: { access: { kind: "now" }, modification: { kind: "now" } } })
      const touched = yield* fs.stat("/f")
      assert.isAbove(Number(touched.ctimeNs), Number(resized.ctimeNs))
      assert.deepStrictEqual([touched.atimeNs, touched.mtimeNs], [touched.ctimeNs, touched.ctimeNs])
    }).pipe(Effect.provide(Testing.layer()), Effect.provideService(Clock.Clock, tickingClock())))

  it.effect("publishes one Update for a change to every attribute", () =>
    Effect.gen(function*() {
      yield* ownedFile
      const volume = yield* Vfs.Volume
      const fs = yield* Vfs.Caller
      const changes = yield* Testing.collectChanges(yield* volume.watch, 2)

      yield* fs.setattr("/f", { size: 2n, mode: 0o600, owner: { uid: 0 }, times: EXPLICIT_TIMES })
      yield* fs.mkdir("/done")

      const seen = yield* Effect.forEach(
        yield* changes,
        (change) => Effect.map(pathText(change.path), (path) => `${change._tag} ${path}`)
      )

      assert.deepStrictEqual(seen, ["Update /f", "Create /done"])
    }).pipe(Effect.scoped, Effect.provide(Testing.layer())))

  it.effect("keeps a requested setuid and setgid mode across an owner change and a resize", () =>
    Effect.gen(function*() {
      yield* ownedFile
      const fs = yield* Vfs.Caller

      yield* fs.setattr("/f", { size: 0n, mode: 0o6755, owner: { uid: 0, gid: 0 } })
      assert.strictEqual((yield* fs.stat("/f")).mode, 0o6755)

      // Without a requested mode, the owner change still clears both bits.
      yield* fs.setattr("/f", { owner: { uid: 9 } })
      assert.strictEqual((yield* fs.stat("/f")).mode, 0o755)
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("fails as StaleReference naming expected, applying nothing, when the target moved past the revision", () =>
    Effect.gen(function*() {
      const observed = yield* ownedFile
      const fs = yield* Vfs.Caller
      yield* fs.chown("/f", { uid: 2000 })
      const before = yield* fs.stat("/f")

      const error = yield* Effect.flip(
        fs.setattr("/f", { mode: 0o4755, owner: {}, expected: { revision: observed.revision } })
      )

      assert.strictEqual(error.code, "StaleReference")
      assert.strictEqual(error.field, "expected")
      assert.strictEqual(yield* pathText(error.path), "/f")
      assert.deepStrictEqual(yield* fs.stat("/f"), before)

      yield* fs.setattr("/f", { mode: 0o4755, expected: { revision: before.revision } })
      assert.deepInclude(yield* fs.stat("/f"), { mode: 0o4755, revision: before.revision + 1n })
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("changes nothing, not even ctime or the revision, without attributes", () =>
    Effect.gen(function*() {
      const before = yield* ownedFile
      const fs = yield* Vfs.Caller
      yield* TestClock.adjust(1000)

      yield* fs.setattr("/f", {})
      yield* fs.setattr("/f", { times: { access: { kind: "omit" }, modification: { kind: "omit" } } })

      assert.deepStrictEqual(yield* fs.stat("/f"), before)
    }).pipe(Effect.provide(Testing.layer())))
})
