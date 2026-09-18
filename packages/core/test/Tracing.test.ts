import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Tracer } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"

const traced = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const spans: Array<Tracer.NativeSpan> = []

  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)

      return span
    }
  })

  return effect.pipe(
    Effect.withTracer(tracer),
    Effect.map((value) => ({ value, names: spans.map((span) => span.name) }))
  )
}

describe("public tracing boundaries", () => {
  it.effect("emits one public span for each snapshot delta operation", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const snapshot = yield* volume.snapshot

      const diff = yield* traced(Vfs.diffSnapshots(snapshot, snapshot))
      const inspect = yield* traced(Vfs.inspectSnapshotDelta(snapshot, diff.value))
      const apply = yield* traced(Vfs.applySnapshotDelta(snapshot, diff.value))

      assert.deepStrictEqual(diff.names, ["VirtualFileSystem.diffSnapshots"])
      assert.deepStrictEqual(inspect.names, ["VirtualFileSystem.inspectSnapshotDelta"])
      assert.deepStrictEqual(apply.names, ["VirtualFileSystem.applySnapshotDelta"])
    }).pipe(Effect.provide(BunCrypto.layer)))

  it.effect("traces the public volume constructor without exposing its internal builder", () =>
    Effect.gen(function*() {
      const result = yield* traced(Vfs.make())

      assert.deepStrictEqual(result.names, ["VirtualFileSystem.make"])
    }).pipe(Effect.provide(BunCrypto.layer)))
})
