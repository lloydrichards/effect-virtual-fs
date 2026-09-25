import { assert, describe } from "@effect/vitest"
import { ByteSize, Deferred, Effect, Fiber } from "effect"
import { LiveVolume } from "../src/index.js"
import { it } from "./TestEffect.js"

const bytes = (...values: Array<number>) => new Uint8Array(values)

const name = (value: string) => new TextEncoder().encode(value)

const MAX_IMAGE_BYTES = ByteSize.kilobytes(256)

interface Pause {
  readonly entered: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
}

// A live volume opened through the public image boundary whose next commit can be paused or given a fixed outcome.
const pausable = Effect.gen(function*() {
  let pause: Pause | undefined
  let outcome: LiveVolume.CommitOutcome = "committed"
  let commits = 0
  let lastImage: Uint8Array | undefined
  const record = { commits: () => commits, lastImage: () => lastImage }

  const image = yield* LiveVolume.prepareEmptyImage()

  const session = yield* LiveVolume.openImage(image, MAX_IMAGE_BYTES, (committed) =>
    Effect.suspend(() => {
      commits++
      lastImage = committed
      const paused = pause

      if (paused === undefined) return Effect.succeed(outcome)
      pause = undefined

      return Deferred.succeed(paused.entered, undefined).pipe(
        Effect.andThen(Deferred.await(paused.release)),
        Effect.map(() => outcome)
      )
    }))

  const caller = yield* session.volume.caller()

  // Pauses the next commit, returning the effects that await its start and release it.
  const pauseNext = Effect.gen(function*() {
    const paused: Pause = { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
    pause = paused

    return { entered: Deferred.await(paused.entered), release: Deferred.succeed(paused.release, undefined) }
  })

  const setOutcome = (next: LiveVolume.CommitOutcome) =>
    Effect.sync(() => {
      outcome = next
    })

  return { volume: session.volume, caller, pauseNext, setOutcome, record }
})

// Lets forked fibers make progress without waiting on any of them.
const settle = Effect.gen(function*() {
  for (let i = 0; i < 4; i++) yield* Effect.yieldNow
})

const renameFixture = Effect.gen(function*() {
  const live = yield* pausable
  yield* live.caller.mkdir("/a")
  yield* live.caller.mkdir("/b")
  yield* live.caller.writeFile("/a/f", bytes(1), { access: "write", create: "exclusive" })

  return live
})

describe("live commit", () => {
  it.effect("holds reads behind a pending commit and never shows a half-applied rename", () =>
    Effect.gen(function*() {
      const { caller, pauseNext } = yield* renameFixture
      const { entered, release } = yield* pauseNext
      const rename = yield* caller.rename("/a/f", "/b/f").pipe(Effect.forkChild({ startImmediately: true }))
      yield* entered

      const source = yield* caller.stat("/a/f").pipe(Effect.forkChild({ startImmediately: true }))
      const target = yield* caller.stat("/b/f").pipe(Effect.forkChild({ startImmediately: true }))
      yield* settle
      assert.isUndefined(source.pollUnsafe())
      assert.isUndefined(target.pollUnsafe())

      yield* release
      yield* Fiber.join(rename)
      assert.strictEqual((yield* Effect.flip(Fiber.join(source))).code, "NotFound")
      assert.strictEqual((yield* Fiber.join(target)).kind, "file")
    }))

  it.effect("shows the pre-rename state to waiting reads when the commit is rejected", () =>
    Effect.gen(function*() {
      const { caller, pauseNext, setOutcome } = yield* renameFixture
      const root = yield* caller.rootReference
      const a = yield* caller.lookupReference(root, name("a"))
      const b = yield* caller.lookupReference(root, name("b"))
      const file = yield* caller.lookupReference(a, name("f"))
      const aBefore = (yield* caller.observeDirectory(a)).revision
      const bBefore = (yield* caller.observeDirectory(b)).revision

      const { entered, release } = yield* pauseNext
      const rename = yield* caller.rename("/a/f", "/b/f").pipe(Effect.forkChild({ startImmediately: true }))
      yield* entered

      const source = yield* caller.stat("/a/f").pipe(Effect.forkChild({ startImmediately: true }))
      const target = yield* caller.stat("/b/f").pipe(Effect.forkChild({ startImmediately: true }))
      yield* settle
      assert.isUndefined(source.pollUnsafe())
      assert.isUndefined(target.pollUnsafe())

      yield* setOutcome("rejected")
      yield* release
      assert.strictEqual((yield* Effect.flip(Fiber.join(rename))).code, "StorageRejected")
      yield* setOutcome("committed")

      assert.strictEqual((yield* Fiber.join(source)).kind, "file")
      assert.strictEqual((yield* Effect.flip(Fiber.join(target))).code, "NotFound")
      assert.strictEqual((yield* caller.observeDirectory(a)).revision, aBefore)
      assert.strictEqual((yield* caller.observeDirectory(b)).revision, bBefore)
      assert.strictEqual(yield* caller.lookupReference(a, name("f")), file)
    }))

  it.effect("keeps identity and revisions across a rejected rename", () =>
    Effect.gen(function*() {
      const { caller, setOutcome } = yield* pausable
      yield* caller.mkdir("/from")
      yield* caller.mkdir("/to")
      yield* caller.writeFile("/from/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      yield* caller.link("/from/file", "/alias")

      const root = yield* caller.rootReference
      const from = yield* caller.lookupReference(root, name("from"))
      const file = yield* caller.lookupReference(from, name("file"))
      const before = (yield* caller.observeMetadata(from)).revision
      yield* setOutcome("rejected")

      assert.strictEqual((yield* Effect.flip(caller.rename("/from/file", "/to/file"))).code, "StorageRejected")
      yield* setOutcome("committed")
      assert.strictEqual((yield* caller.observeMetadata(from)).revision, before)
      assert.strictEqual(yield* caller.lookupReference(from, name("file")), file)
      assert.strictEqual(yield* caller.lookupReference(root, name("alias")), file)
      assert.strictEqual((yield* Effect.flip(caller.stat("/to/file"))).code, "NotFound")

      yield* caller.rename("/from/file", "/to/file")
      const to = yield* caller.lookupReference(root, name("to"))
      assert.strictEqual(yield* caller.lookupReference(to, name("file")), file)
      assert.strictEqual(yield* caller.lookupReference(root, name("alias")), file)
    }))

  it.effect("preserves a reference and its link count after a rejected unlink", () =>
    Effect.gen(function*() {
      const { caller, setOutcome } = yield* pausable
      yield* caller.writeFile("/f", bytes(1, 2), { access: "write", create: "exclusive" })
      const root = yield* caller.rootReference
      const ref = yield* caller.lookupReference(root, name("f"))

      yield* setOutcome("rejected")
      assert.strictEqual((yield* Effect.flip(caller.unlink("/f"))).code, "StorageRejected")
      assert.strictEqual((yield* caller.observeMetadata(ref)).value.nlink, 1)
      // A path read commits its access-time update, so it also reports the rejection.
      assert.strictEqual((yield* Effect.flip(caller.readFile("/f"))).code, "StorageRejected")

      yield* setOutcome("committed")
      assert.deepStrictEqual(yield* caller.readFile("/f"), bytes(1, 2))
      yield* caller.unlink("/f")
      assert.strictEqual((yield* Effect.flip(caller.observeMetadata(ref))).code, "StaleReference")
    }))

  it.effect("does not commit when a failed open scope closes", () =>
    Effect.gen(function*() {
      const { caller, record } = yield* pausable
      const opened = record.commits()

      yield* Effect.scoped(Effect.flip(caller.open("/missing", { access: "read" })))
      assert.strictEqual(record.commits() - opened, 0)
      yield* caller.mkdir("/x")
      assert.strictEqual(record.commits() - opened, 1)
      assert.isDefined(record.lastImage())
    }))

  it.effect("reads the committed state after waiting behind a commit", () =>
    Effect.gen(function*() {
      const { caller, volume, pauseNext } = yield* pausable
      const { usedBytes, entries } = yield* volume.usage
      const { entered, release } = yield* pauseNext
      const writer = yield* caller.mkdir("/held").pipe(Effect.forkChild({ startImmediately: true }))
      yield* entered

      const usage = yield* volume.usage.pipe(Effect.forkChild({ startImmediately: true }))
      const stat = yield* caller.stat("/held").pipe(Effect.forkChild({ startImmediately: true }))
      yield* settle
      assert.isUndefined(usage.pollUnsafe())
      assert.isUndefined(stat.pollUnsafe())

      yield* release
      yield* Fiber.join(writer)
      assert.strictEqual((yield* Fiber.join(stat)).kind, "directory")
      assert.deepStrictEqual(yield* Fiber.join(usage), { usedBytes, entries: entries + 1 })
    }))
})
