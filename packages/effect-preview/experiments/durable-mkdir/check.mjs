/* eslint-disable effecttsgo/any-unknown-in-error-context, effecttsgo/experimental-api-usage */
import assert from "node:assert/strict"
import { Deferred, Effect, Fiber, Predicate } from "effect"
import { toBytes } from "../../src/compat/BytePath.ts"
import { equalsNamespaceRevision, equalsObjectRevision } from "../../src/virtual-file-system/VirtualFileSystem.ts"
import { makeMkdirTrial } from "./trial.ts"

const fork = (effect) => Effect.forkChild(effect, { startImmediately: true })

const run = (effect) => Effect.runPromise(Effect.scoped(effect))

const name = (bytes) => new TextDecoder().decode(bytes)

const pausableStore = Effect.gen(function*() {
  const entered = yield* Deferred.make()
  const release = yield* Deferred.make()
  const offers = []

  const trial = yield* makeMkdirTrial((candidate) => Effect.gen(function*() {
    offers.push(candidate)

    if (offers.length !== 1) return "committed"
    yield* Deferred.succeed(entered, undefined)

    return yield* Deferred.await(release)
  }))

  const events = []
  const listen = trial.onCommit((batch) => events.push(...batch))
  yield* listen

  return { trial, entered, release, offers, events, listen }
})

await run(Effect.gen(function*() {
  const { trial, entered, release, offers, events } = yield* pausableStore
  const worker = yield* fork(trial.mkdir("/accepted"))
  yield* Deferred.await(entered)
  const read = yield* fork(trial.stat("/accepted"))
  const waiting = yield* fork(trial.mkdir("/cancelled"))
  const cancelling = yield* fork(Fiber.interrupt(waiting))
  const interrupt = yield* fork(Fiber.interrupt(worker))
  yield* Effect.yieldNow
  const before = [read.pollUnsafe(), interrupt.pollUnsafe(), events.length]
  const cancelledBeforeOffer = cancelling.pollUnsafe() !== undefined
  const candidate = offers[0]
  const offeredName = name(candidate.name)
  candidate.name.fill(0)
  yield* Deferred.succeed(release, "committed")
  yield* Fiber.join(cancelling)
  yield* Fiber.join(interrupt)
  const installed = yield* Fiber.join(read)

  assert.deepEqual(before, [undefined, undefined, 0])
  assert.ok(cancelledBeforeOffer)
  assert.equal(offers.length, 1)
  assert.equal((yield* Effect.flip(trial.stat("/cancelled")))._tag, "NotFound")
  assert.equal(offeredName, "accepted")
  assert.equal(candidate.child.objectNumber, installed.metadata.objectNumber)
  assert.equal(candidate.child.nlink, installed.metadata.nlink)
  assert.equal(candidate.parent.nlink, (yield* trial.stat("/")).metadata.nlink)
  assert.equal(candidate.nextObject, installed.metadata.objectNumber + 1n)
  assert.ok(Predicate.isBigInt(candidate.child.revision))
  assert.ok(Predicate.isBigInt(candidate.parent.namespaceRevision))
  assert.equal("reference" in candidate.child, false)
  assert.deepEqual(events.map((e) => [e._tag, name(toBytes(e.name))]), [["Create", "accepted"]])
}))

await run(Effect.gen(function*() {
  const { trial, entered, release, offers, events } = yield* pausableStore
  const root = yield* trial.stat("/")
  const worker = yield* fork(Effect.flip(trial.mkdir("/rejected")))
  yield* Deferred.await(entered)
  const read = yield* fork(Effect.flip(trial.stat("/rejected")))
  yield* Effect.yieldNow
  const pending = read.pollUnsafe()
  yield* Deferred.succeed(release, "rejected")

  assert.equal(pending, undefined)
  assert.equal((yield* Fiber.join(worker))._tag, "StorageRejected")
  assert.equal((yield* Fiber.join(read))._tag, "NotFound")
  const after = yield* trial.stat("/")
  assert.deepEqual(root.metadata, after.metadata)
  assert.ok(equalsObjectRevision(root.revision, after.revision))
  assert.ok(equalsNamespaceRevision(root.namespaceRevision, after.namespaceRevision))
  assert.equal(events.length, 0)
  const next = yield* trial.mkdir("/retry")
  assert.equal(next.metadata.objectNumber, offers[0].child.objectNumber)
  assert.equal((yield* Effect.flip(trial.mkdir("/retry")))._tag, "AlreadyExists")
  assert.equal(offers.length, 2)
  assert.deepEqual(events.map((e) => name(toBytes(e.name))), ["retry"])
}))

await run(Effect.gen(function*() {
  const { trial, entered, release, offers, events, listen } = yield* pausableStore
  const worker = yield* fork(Effect.flip(trial.mkdir("/unknown")))
  yield* Deferred.await(entered)
  const queued = []

  for (const effect of [trial.stat("/"), trial.mkdir("/queued"), listen]) {
    queued.push(yield* fork(Effect.flip(effect)))
  }

  yield* Effect.yieldNow
  const pending = queued.map((fiber) => fiber.pollUnsafe())
  yield* Deferred.succeed(release, "unknown")

  assert.deepEqual(pending, [undefined, undefined, undefined])

  for (const fiber of [worker, ...queued]) {
    assert.equal((yield* Fiber.join(fiber))._tag, "VolumeUnavailable")
  }

  for (const effect of [trial.stat("/"), trial.mkdir("/later"), listen]) {
    assert.equal((yield* Effect.flip(effect))._tag, "VolumeUnavailable")
  }

  assert.equal(offers.length, 1)
  assert.equal(events.length, 0)
}))

await run(Effect.gen(function*() {
  const independent = yield* makeMkdirTrial(() => Effect.succeed("committed"))

  const trial = yield* makeMkdirTrial(() => Effect.gen(function*() {
    const nested = yield* Effect.flip(trial.stat("/"))
    assert.equal(nested._tag, "ReentrantOperation")
    assert.equal((yield* independent.stat("/")).kind, "directory")

    return "committed"
  }))

  assert.equal((yield* trial.mkdir("/visible")).kind, "directory")
}))

await run(Effect.gen(function*() {
  const trial = yield* makeMkdirTrial(() => Effect.die("store lost its connection"))
  assert.equal((yield* Effect.flip(trial.mkdir("/unknown")))._tag, "VolumeUnavailable")
  assert.equal((yield* Effect.flip(trial.stat("/")))._tag, "VolumeUnavailable")
}))

process.stdout.write("Durable mkdir experiment passed acceptance, rejection, interruption and uncertain-outcome checks.\n")
