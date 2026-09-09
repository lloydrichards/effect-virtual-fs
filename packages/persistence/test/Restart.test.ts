import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { execFile } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const run = promisify(execFile)
const worker = fileURLToPath(new URL("./fixtures/restart.ts", import.meta.url))

describe("checkpoint process restart", () => {
  it.effect(
    "restores the saved namespace in a fresh process without retaining later mutations",
    () =>
      Effect.gen(function*() {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => Fs.mkdtemp(Path.join(Os.tmpdir(), "effect-vfs-restart-"))),
          (path) => Effect.promise(() => Fs.rm(path, { recursive: true, force: true }))
        )
        const database = Path.join(directory, "checkpoints.sqlite")
        const saved = yield* Effect.promise(() => run("bun", [worker, "save", database], { timeout: 5_000 }))
        assert.include(saved.stdout, "saved")
        const restored = yield* Effect.promise(() => run("bun", [worker, "restore", database], { timeout: 5_000 }))
        assert.include(restored.stdout, "restored")
      }),
    15_000
  )
})
