// Vitest is the runtime boundary. Scope ownership spans setup and all timed callbacks.
/* oxlint-disable effecttsgo/async-function */
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { Effect } from "effect"
import { afterAll, assert, beforeAll, test } from "vitest"
import type * as VirtualFileSystem from "../dist/VirtualFileSystem.js"
import { confinementControls } from "./config.ts"
import { prepareSources, writeReport } from "./sources.ts"

const controls = Effect.runSync(confinementControls)

let sources: Awaited<ReturnType<typeof prepareSources>>

const reports: Array<
  {
    depth: number
    workload: string
    round: number
    timing: Record<string, { meanMs: number; samplesMs: Array<number> }>
  }
> = []

beforeAll(async () => {
  sources = await prepareSources(controls)
})

afterAll(async () => {
  if (sources === undefined) return

  try {
    const summaries = controls.depths.flatMap((depth) =>
      ["path-read", "handle-read", "handle-read-write"].flatMap((workload) => {
        const rounds = reports.filter((report) => report.depth === depth && report.workload === workload)

        if (rounds.length === 0) return []

        const first = rounds[0]
        assert.isDefined(first)

        const timing = Object.fromEntries(
          Object.keys(first.timing).map((label) => {
            const samplesMs = rounds.flatMap((round) => {
              const measurement = round.timing[label]
              assert.isDefined(measurement)

              return measurement.samplesMs
            })

            const sorted = [...samplesMs].sort((a, b) => a - b)

            const medianMs = sorted[Math.floor(sorted.length / 2)]
            assert.isDefined(medianMs)

            return [label, { samplesMs, medianMs }]
          })
        )

        const baseline = timing["baseline"]
        const ordinary = timing["ordinary"]
        const confined = timing["confined"]
        const baselineConfined = timing["baselineConfined"]
        assert.isDefined(baseline)
        assert.isDefined(ordinary)
        assert.isDefined(confined)

        return [{
          depth,
          workload,
          timing,
          ordinaryRegressionPercent: (ordinary.medianMs / baseline.medianMs - 1) * 100,
          confinedChangePercent: baselineConfined === undefined ?
            undefined :
            (confined.medianMs / baselineConfined.medianMs - 1) * 100,
          confinedOverOrdinaryPercent: (confined.medianMs / ordinary.medianMs - 1) * 100
        }]
      })
    )

    await writeReport(
      controls.output,
      JSON.stringify(
        {
          ...controls,
          ...sources.metadata,
          reports: summaries,
          roundReports: reports,
          units: "milliseconds per batch",
          warmupRounds: 3,
          limitations:
            "Independent bundled sources; memory backend; setup excluded, assertions and runtime included. No allocation or package-wide claim."
        },
        null,
        2
      ) + "\n"
    )
  } finally {
    await sources.close()
  }
})

for (const depth of controls.depths) {
  for (const workload of ["path-read", "handle-read", "handle-read-write"] as const) {
    test(`depth ${depth}/${workload}/${controls.iterations} operations/${controls.fileBytes} bytes`, async ({ bench }) => {
      const bytes = new Uint8Array(controls.fileBytes).fill(100)

      const directories = Array.from(
        { length: depth },
        (_, index) => `/tenant/${Array.from({ length: index + 1 }, () => "d").join("/")}`
      )

      const physicalPath = `${directories[depth - 1]}/file`

      const fixture = {
        entries: [
          { kind: "directory" as const, path: "/tenant" },
          ...directories.map((path) => ({ kind: "directory" as const, path })),
          { kind: "file" as const, path: physicalPath, bytes }
        ]
      }

      const setup = Effect.fnUntraced(function*(vfs: Pick<typeof VirtualFileSystem, "fromFixture">, confined: boolean) {
        const volume = yield* vfs.fromFixture(fixture)
        const owner = yield* volume.caller()
        const caller = confined ? yield* owner.withRoot("/tenant") : owner
        const path = confined ? physicalPath.slice("/tenant".length) : physicalPath
        const handle = yield* caller.open(path, { access: "readWrite" })

        return { caller, path, handle }
      })

      await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const contexts = [
            ["baseline", yield* setup(sources.baseline, false)],
            ["ordinary", yield* setup(sources.current, false)],
            ["confined", yield* setup(sources.current, true)]
          ] as const

          const candidates: Array<readonly [string, typeof contexts[number][1]]> = [...contexts]

          if (controls.compareConfined) candidates.push(["baselineConfined", yield* setup(sources.baseline, true)])
          const run = Effect.runPromiseWith(yield* Effect.context())

          const batch = Effect.fnUntraced(function*(context: typeof contexts[number][1]) {
            let checksum = 0

            for (let index = 0; index < controls.iterations; index++) {
              const data = workload === "path-read"
                ? yield* context.caller.readFile(context.path)
                : (yield* context.handle.pread(controls.fileBytes, 0n)).bytes

              assert.strictEqual(data.length, controls.fileBytes)
              assert.strictEqual(data.at(-1), 100)
              checksum += data[0] ?? 0

              if (workload === "handle-read-write") {
                assert.strictEqual(yield* context.handle.pwrite(bytes, 0n), controls.fileBytes)
              }
            }

            assert.strictEqual(checksum, controls.iterations * 100)
          })

          yield* Effect.tryPromise(async () => {
            for (let round = 0; round < controls.rounds; round++) {
              const ordered = round % 2 === 0 ? candidates : [...candidates].reverse()

              const results = await bench.compare(
                ...ordered.map(([label, context]) =>
                  bench(`${label}/round-${round + 1}`, { async: true }, () => run(batch(context)))
                ),
                {
                  time: 0,
                  iterations: 1,
                  warmupTime: 0,
                  warmupIterations: 3,
                  retainSamples: true
                }
              )

              reports.push({
                depth,
                workload,
                round: round + 1,
                timing: Object.fromEntries(candidates.map(([label]) => {
                  const result = results.get(`${label}/round-${round + 1}`)

                  assert.isDefined(result.latency.samples)

                  return [label, { meanMs: result.latency.mean, samplesMs: Array.from(result.latency.samples) }]
                }))
              })
            }
          })
        })).pipe(Effect.provide(NodeCrypto.layer))
      )
    })
  }
}
