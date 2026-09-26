import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Effect, Layer } from "effect"
import { buildVirtual, demoFixture } from "./VirtualBuild.js"

const program = Effect.gen(function*() {
  const caller = yield* Vfs.Caller
  const first = yield* buildVirtual(caller, "/__effect_vfs_demo__/main.js")
  yield* caller.writeFile("/__effect_vfs_demo__/value.js", new TextEncoder().encode("export const value = 21"), {
    access: "write",
    truncate: true
  })
  const second = yield* buildVirtual(caller, "/__effect_vfs_demo__/main.js")
  const packageBuild = yield* buildVirtual(caller, "/__effect_vfs_demo__/package.js")
  yield* Effect.log({
    firstBundle: first.code,
    rebuiltBundle: second.code,
    packageBundle: packageBuild.code,
    reads: [...first.reads, ...packageBuild.reads]
  })
})

await Effect.runPromise(
  program.pipe(
    Effect.provide(Vfs.Caller.layer().pipe(Layer.provide(Vfs.Volume.layerFromFixture(demoFixture)))),
    Effect.catchCause(Effect.fnUntraced(function*(cause) {
      yield* Effect.logError(cause)
      process.exitCode = 1
    }))
  )
)
