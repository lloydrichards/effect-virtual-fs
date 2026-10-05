import { Config, type Effect, Option, Schema } from "effect"

const positive = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))

export const confinementControls = Config.all({
  iterations: Config.schema(positive, "CONFINEMENT_BENCH_ITERATIONS").pipe(Config.withDefault(1200)),
  rounds: Config.schema(positive, "CONFINEMENT_BENCH_ROUNDS").pipe(Config.withDefault(7)),
  fileBytes: Config.schema(positive, "CONFINEMENT_BENCH_FILE_BYTES").pipe(Config.withDefault(4)),
  depths: Config.Array(positive, "CONFINEMENT_BENCH_DEPTHS").pipe(Config.withDefault([1, 8, 64])),
  baseline: Config.String("CONFINEMENT_BENCH_BASELINE").pipe(Config.withDefault("HEAD")),
  baselinePatch: Config.option(Config.String("CONFINEMENT_BENCH_BASELINE_PATCH")).pipe(
    Config.map(Option.getOrUndefined)
  ),
  compareConfined: Config.Boolean("CONFINEMENT_BENCH_BASELINE_CONFINED").pipe(Config.withDefault(false)),
  output: Config.String("CONFINEMENT_BENCH_OUTPUT").pipe(Config.withDefault(".cache/confinement-benchmark.json"))
})

export type ConfinementControls = Effect.Success<typeof confinementControls>
