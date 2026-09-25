import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import { assert, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const files = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const platform = Layer.mergeAll(files, NodeChildProcessSpawner.layer.pipe(Layer.provide(files)))

it.layer(platform, { excludeTestServices: true })("checkpoint process restart", (it) => {
  it.effect(
    "restores the saved namespace in a fresh process without retaining later mutations",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const filesystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const directory = yield* filesystem.makeTempDirectoryScoped({ prefix: "effect-vfs-restart-" })
        const database = path.join(directory, "checkpoints.sqlite")
        const worker = yield* path.fromFileUrl(new URL("./fixtures/restart.ts", import.meta.url))

        // A worker that logs its marker and then fails while closing its database must still fail the test.
        const run = (mode: "save" | "restore") =>
          Effect.scoped(Effect.gen(function*() {
            const child = yield* spawner.spawn(ChildProcess.make("bun", [worker, mode, database]))
            const output = yield* Stream.mkString(Stream.decodeText(child.stdout))
            assert.strictEqual(yield* child.exitCode, 0)

            return output
          })).pipe(Effect.timeout("5 seconds"))

        assert.include(yield* run("save"), "saved")
        assert.include(yield* run("restore"), "restored")
      })),
    15_000
  )
})
