// Vitest runs the rename pairs after all churn handles have closed.
/* oxlint-disable effecttsgo/async-function */
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { Effect, Exit, Scope } from "effect"
import { test } from "vitest"
import * as Vfs from "../dist/VirtualFileSystem.js"

const setup = Effect.fnUntraced(function*(churn: number) {
  const volume = yield* Vfs.make({ maxEntries: 2 })
  const owner = yield* volume.caller()
  yield* owner.mkdir("/tenant")
  yield* owner.writeFile("/tenant/source", Uint8Array.of(1), { access: "write", create: "exclusive" })
  const caller = yield* owner.withRoot("/tenant")

  const closed: Array<Vfs.FileHandle> = []

  for (let i = 0; i < churn; i++) {
    const handle = yield* caller.open("/source", { access: "read" })
    yield* handle.close
    closed.push(handle)
  }

  // Keep one live grant and retain the closed wrappers through the benchmark.
  const live = yield* caller.open("/source", { access: "read" })
  const renamePair = Effect.andThen(caller.rename("/source", "/destination"), caller.rename("/destination", "/source"))
  const run = Effect.andThen(renamePair, live.stat).pipe(Effect.asVoid)

  return { closed, run }
})

test("rename round trip and confined handle stat after closed-handle churn", async ({ bench }) => {
  const scope = Scope.makeUnsafe()
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

  try {
    const candidates = await run(
      Effect.forEach([0, 1_000], setup).pipe(
        Scope.provide(scope),
        Effect.provide(NodeCrypto.layer)
      )
    )

    const results = await bench.compare(
      ...candidates.map((candidate) =>
        bench(`${candidate.closed.length} closed handles`, { async: true }, () => run(candidate.run))
      ),
      { time: 1000 }
    )

    console.table(Object.fromEntries(candidates.map((candidate) => {
      const label = `${candidate.closed.length} closed handles` as const
      const timing = results.get(label).latency
      candidate.closed.length = 0

      return [label, { meanMs: timing.mean, medianMs: timing.p50 }]
    })))
  } finally {
    await run(Scope.close(scope, Exit.void))
  }
})
