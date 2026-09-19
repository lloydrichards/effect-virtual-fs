import { assert, describe } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { makeStagedState } from "../src/internal/virtualFileSystem/stagedState.js"
import { it } from "./TestEffect.js"

describe("staged state", () => {
  it.effect("keeps a rejected candidate invisible and permits a later mutation", () =>
    Effect.gen(function*() {
      let reject = true

      const state = makeStagedState(
        { value: 1 },
        (current) => Effect.succeed({ ...current }),
        { commit: () => Effect.succeed(reject ? "rejected" as const : "committed" as const) }
      )

      const rejected = yield* Effect.flip(state.mutate("write", (candidate) =>
        Effect.sync(() => {
          candidate.value = 2
        })))

      assert.strictEqual(rejected.code, "StorageRejected")
      assert.strictEqual(yield* state.read("read", (current) => Effect.succeed(current.value)), 1)

      reject = false
      yield* state.mutate("write", (candidate) =>
        Effect.sync(() => {
          candidate.value = 3
        }))
      assert.strictEqual(yield* state.read("read", (current) => Effect.succeed(current.value)), 3)
    }))

  it.effect("stops every later operation after an unknown commit outcome", () =>
    Effect.gen(function*() {
      const state = makeStagedState(
        { value: 1 },
        (current) => Effect.succeed({ ...current }),
        { commit: () => Effect.succeed("unknown" as const) }
      )

      const unknown = yield* Effect.flip(state.mutate("write", (candidate) =>
        Effect.sync(() => {
          candidate.value = 2
        })))

      assert.strictEqual(unknown.code, "OutcomeUnknown")
      assert.strictEqual(
        (yield* Effect.flip(state.read("read", (current) => Effect.succeed(current.value)))).code,
        "VolumeUnavailable"
      )
      assert.strictEqual((yield* Effect.flip(state.mutate("write", () => Effect.void))).code, "VolumeUnavailable")
    }))

  it.effect("treats a provider defect as an unknown outcome", () =>
    Effect.gen(function*() {
      const state = makeStagedState(
        { value: 1 },
        (current) => Effect.succeed({ ...current }),
        { commit: () => Effect.die("commit failed") }
      )

      const failure = yield* Effect.flip(state.mutate("write", (candidate) =>
        Effect.sync(() => {
          candidate.value = 2
        })))

      assert.strictEqual(failure.code, "OutcomeUnknown")
      assert.strictEqual(
        (yield* Effect.flip(state.read("read", (current) => Effect.succeed(current.value)))).code,
        "VolumeUnavailable"
      )
    }))

  it.effect("discards a candidate interrupted before commit", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let commits = 0

      const state = makeStagedState(
        { value: 1 },
        (current) => Effect.succeed({ ...current }),
        {
          commit: () =>
            Effect.sync(() => {
              commits += 1

              return "committed" as const
            })
        }
      )

      const write = yield* state.mutate("write", (candidate) =>
        Effect.gen(function*() {
          candidate.value = 2
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        })).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Deferred.await(entered)
      yield* Fiber.interrupt(write)

      assert.strictEqual(commits, 0)
      assert.strictEqual(yield* state.read("read", (current) => Effect.succeed(current.value)), 1)
    }))

  it.effect("holds reads behind a pending commit", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const readEntered = yield* Deferred.make<void>()

      const state = makeStagedState(
        { value: 1 },
        (current) => Effect.succeed({ ...current }),
        {
          commit: () =>
            Effect.as(
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
              "committed" as const
            )
        }
      )

      const write = yield* state.mutate("write", (candidate) =>
        Effect.sync(() => {
          candidate.value = 2
        })).pipe(
          Effect.forkChild({ startImmediately: true })
        )

      yield* Deferred.await(entered)

      const read = yield* state.read("read", (current) =>
        Deferred.succeed(readEntered, undefined).pipe(Effect.as(current.value))).pipe(
          Effect.forkChild({ startImmediately: true })
        )

      yield* Effect.yieldNow
      assert.isFalse(yield* Deferred.isDone(readEntered))
      yield* Deferred.succeed(release, undefined)

      yield* Fiber.join(write)
      assert.strictEqual(yield* Fiber.join(read), 2)
    }))
})
