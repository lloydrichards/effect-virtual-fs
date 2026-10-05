import { Config, Schema } from "effect"

const positive = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))

export const xdrControls = Config.all({
  time: Config.schema(positive, "XDR_BENCH_TIME_MS").pipe(Config.withDefault(1000)),
  iterations: Config.schema(positive, "XDR_BENCH_ITERATIONS").pipe(Config.withDefault(64)),
  rounds: Config.schema(positive, "XDR_BENCH_ROUNDS").pipe(Config.withDefault(3))
})
