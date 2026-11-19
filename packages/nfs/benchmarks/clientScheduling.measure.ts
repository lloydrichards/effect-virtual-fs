import { LiveVolume, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { ByteSize, Clock, Deferred, Duration, Effect, Fiber } from "effect"
import { assert, test } from "vitest"
import { Operation, Status } from "../src/internal/nfs4.js"
import { XdrCodec } from "../src/internal/xdr.js"
import {
  call,
  connection,
  makeHandler,
  parseOpen,
  sequence,
  startSession,
  statuses
} from "./support/clientScheduling.js"

const elapsedMs = (start: bigint, end: bigint) => Number(end - start) / 1_000_000

const sample = Effect.fnUntraced(function*(delayMs: number) {
  const clock = yield* Clock.Clock
  const now = clock.monotonicTimeNanosUnsafe.bind(clock)
  const entered = yield* Deferred.make<void>()
  const probesStarted = yield* Deferred.make<void>()
  let measure = false
  let storeEntered = 0n
  let storeReleased = 0n
  let admitted = 0n

  const store = LiveVolume.LiveImageStore.of({
    loadOrCreate: Effect.succeed,
    commit: Effect.fnUntraced(function*() {
      if (measure && storeEntered === 0n) {
        storeEntered = now()
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(probesStarted)

        if (delayMs > 0) yield* Effect.sleep(Duration.millis(delayMs))
        storeReleased = now()
      }

      return "committed" as const
    })
  })

  const volume = yield* LiveVolume.open({ maxImageBytes: ByteSize.kilobytes(64), volume: { maxEntries: 16 } }).pipe(
    Effect.provideService(LiveVolume.LiveImageStore, store)
  )

  const caller = yield* volume.caller()
  yield* caller.writeFile("/independent", Uint8Array.of(1), { access: "write", create: "exclusive" })

  const writer = connection(1)
  const reader = connection(2)

  const handler = yield* makeHandler(caller, {
    writable: true,
    callerFor: (request) =>
      Effect.sync(() => {
        if (measure && request.connection === reader) admitted = now()

        return caller
      })
  }).pipe(Effect.provideService(Vfs.Volume, volume))

  const a = yield* startSession(handler, "writer", {}, new Uint8Array(8), writer)
  const b = yield* startSession(handler, "observer", {}, new Uint8Array(8), reader)
  const control = yield* call([sequence(b.session, 1)], "control", reader)

  const mutation = yield* call(
    [
      sequence(a.session, 1, true),
      (out) => out.write(XdrCodec.uint32, Operation.PUTROOTFH),
      (out) =>
        Effect.gen(function*() {
          yield* out.write(XdrCodec.uint32, Operation.OPEN)
          yield* out.write(XdrCodec.uint32, 0)
          yield* out.write(XdrCodec.uint32, 3)
          yield* out.write(XdrCodec.uint32, 0)
          yield* out.write(XdrCodec.uint64, a.client)
          yield* out.write(XdrCodec.string(), "creator")
          yield* out.write(XdrCodec.uint32, 1)
          yield* out.write(XdrCodec.uint32, 0)
          yield* out.write(XdrCodec.array(XdrCodec.uint32), [])
          yield* out.write(XdrCodec.opaque(), new Uint8Array(0))
          yield* out.write(XdrCodec.uint32, 0)
          yield* out.write(XdrCodec.string(), "created")
        }),
      (out) => out.write(XdrCodec.uint32, Operation.GETFH)
    ],
    "mutation",
    writer
  )

  measure = true
  const writerStarted = now()

  const inFlight = yield* Effect.forkChild(
    handler.compound(mutation).pipe(Effect.ensuring(Deferred.succeed(entered, undefined)))
  )

  yield* Deferred.await(entered)

  let nfsStarted = 0n
  let coreStarted = 0n

  const [sequenceProbe, coreProbe] = yield* Effect.gen(function*() {
    const sequenceProbe = yield* Effect.forkChild(
      Effect.gen(function*() {
        nfsStarted = now()
        const response = yield* handler.compound(control)

        return { response, finished: now() }
      }),
      { startImmediately: true }
    )

    const coreProbe = yield* Effect.forkChild(
      Effect.gen(function*() {
        coreStarted = now()
        const bytes = yield* caller.readFile("/independent")

        return { bytes, finished: now() }
      }),
      { startImmediately: true }
    )

    return [sequenceProbe, coreProbe] as const
  }).pipe(Effect.ensuring(Deferred.succeed(probesStarted, undefined)))

  const mutationResponse = yield* Fiber.join(inFlight)
  const sequenceResult = yield* Fiber.join(sequenceProbe)
  const coreResult = yield* Fiber.join(coreProbe)
  measure = false

  yield* parseOpen(mutationResponse)
  const status = yield* statuses(sequenceResult.response)
  assert.deepStrictEqual(status.operations, [[Operation.SEQUENCE, Status.OK]])
  assert.deepStrictEqual(coreResult.bytes, Uint8Array.of(1))
  assert.isTrue(storeEntered >= writerStarted && storeReleased >= storeEntered)
  assert.isTrue(nfsStarted >= storeEntered && coreStarted >= storeEntered)
  assert.isTrue(storeReleased >= coreStarted && admitted >= storeReleased && sequenceResult.finished >= admitted)

  return {
    delayMs,
    storageMs: elapsedMs(storeEntered, storeReleased),
    sequenceMs: elapsedMs(nfsStarted, sequenceResult.finished),
    sequenceWaitMs: elapsedMs(nfsStarted, admitted),
    sequenceWorkMs: elapsedMs(admitted, sequenceResult.finished),
    sequenceWaitAfterStorageMs: elapsedMs(storeReleased, admitted),
    directCoreReadMs: elapsedMs(coreStarted, coreResult.finished)
  }
})

test(
  "measure normal cross-client scheduling with a controlled storage delay",
  () =>
    Effect.runPromise(
      Effect.gen(function*() {
        yield* Effect.scoped(sample(0))
        yield* Effect.scoped(sample(40))

        return yield* Effect.forEach(
          Array.from({ length: 10 }, () => [0, 40]).flat(),
          (delay) => Effect.scoped(sample(delay))
        )
      }).pipe(Effect.provide(NodeCrypto.layer))
    ).then((samples) => {
      process.stdout.write(JSON.stringify({ samples }) + "\n")
    }),
  30_000
)
