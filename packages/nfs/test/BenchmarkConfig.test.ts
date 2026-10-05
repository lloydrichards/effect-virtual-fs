import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect } from "effect"
import { xdrControls } from "../benchmarks/config.ts"

describe("Benchmark configuration", () => {
  it.effect("should supply workload defaults when controls are missing", () =>
    Effect.gen(function*() {
      const value = yield* xdrControls
      assert.strictEqual(value.iterations, 64)
      assert.strictEqual(value.time, 1000)
      assert.strictEqual(value.rounds, 3)
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))))

  it.effect.each(["0", "-1", "1.5", "invalid", "9007199254740992"])(
    "should reject invalid iteration count %s when configured",
    (iterations) =>
      Effect.gen(function*() {
        const result = yield* Effect.exit(xdrControls)
        assert.strictEqual(result._tag, "Failure")
      }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ XDR_BENCH_ITERATIONS: iterations }))))
  )
})
