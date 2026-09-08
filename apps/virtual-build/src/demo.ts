import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Effect } from "effect"
import { buildVirtual, demoFixture } from "./VirtualBuild.js"

const program = Effect.gen(function*() {
  const volume = yield* Vfs.fromFixture(demoFixture)
  const caller = yield* volume.caller()
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
await Effect.runPromise(program.pipe(Effect.catchCause((cause) =>
  Effect.gen(function*() {
    yield* Effect.logError(cause)
    process.exitCode = 1
  })
)))
