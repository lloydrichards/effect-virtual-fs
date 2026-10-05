import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect } from "effect"
import { confinementControls } from "../benchmarks/config.ts"

describe("Benchmark configuration", () => {
  it.effect("should supply workload defaults when controls are missing", () =>
    Effect.gen(function*() {
      const value = yield* confinementControls
      assert.strictEqual(value.iterations, 1200)
      assert.deepStrictEqual(value.depths, [1, 8, 64])
      assert.isFalse(value.compareConfined)
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))))

  it.effect.each(["0", "-1", "1.5", "invalid", "9007199254740992"])(
    "should reject invalid iteration count %s when configured",
    (iterations) =>
      Effect.gen(function*() {
        const result = yield* Effect.exit(confinementControls)
        assert.strictEqual(result._tag, "Failure")
      }).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ CONFINEMENT_BENCH_ITERATIONS: iterations })))
      )
  )
  it.effect("should decode depth lists and confinement controls when supplied by the environment", () =>
    Effect.gen(function*() {
      const value = yield* confinementControls
      assert.deepStrictEqual(value.depths, [2, 16])
      assert.strictEqual(value.iterations, 10)
      assert.isTrue(value.compareConfined)
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({
      env: {
        CONFINEMENT_BENCH_DEPTHS: "2,16",
        CONFINEMENT_BENCH_ITERATIONS: "10",
        CONFINEMENT_BENCH_BASELINE_CONFINED: "1"
      }
    })))))

  it.effect.each(["1,0", "1,invalid", "1,2.5"])(
    "should reject depth list %s when it contains invalid entries",
    (depths) =>
      Effect.gen(function*() {
        const result = yield* Effect.exit(confinementControls)
        assert.strictEqual(result._tag, "Failure")
      }).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { CONFINEMENT_BENCH_DEPTHS: depths } })))
      )
  )
})
