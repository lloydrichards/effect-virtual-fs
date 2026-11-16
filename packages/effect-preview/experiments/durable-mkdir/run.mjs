// Apply the candidate after the MVP patches in a disposable preview package.
/* eslint-disable effecttsgo/node-builtin-import */
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const experiment = fileURLToPath(new URL("./", import.meta.url))

const preview = resolve(experiment, "../..")

const dependencies = resolve(preview, "../../node_modules")

const scratch = await mkdtemp(join(tmpdir(), "effect-vfs-durable-mkdir-"))

try {
  for (const path of ["upstream", "patches", "scripts/sync.mjs", "package.json", "tsconfig.json", "tsconfig.build.json"]) {
    await cp(join(preview, path), join(scratch, path), { recursive: true })
  }

  await cp(experiment, join(scratch, "experiments/durable-mkdir"), { recursive: true })
  await symlink(dependencies, join(scratch, "node_modules"), "dir")

  const file = "publication.patch"
  const patch = await readFile(join(experiment, file))
  const seriesPath = join(scratch, "patches/series.json")
  const series = JSON.parse(await readFile(seriesPath, "utf8"))
  series.push({ file, sha256: createHash("sha256").update(patch).digest("hex") })
  await writeFile(join(scratch, "patches", file), patch)
  await writeFile(seriesPath, JSON.stringify(series))

  const run = (...args) => execFileSync(process.execPath, args, { cwd: scratch, stdio: "inherit" })
  run("scripts/sync.mjs")
  run(join(dependencies, ".bin/tsc"), "-p", "tsconfig.build.json")
  await writeFile(join(scratch, "tsconfig.trial.json"), JSON.stringify({
    extends: "./tsconfig.json",
    include: ["experiments/durable-mkdir/trial.ts"]
  }))
  run(join(dependencies, ".bin/tsc"), "--noEmit", "-p", "tsconfig.trial.json")
  run("experiments/durable-mkdir/check.mjs")
  run(join(dependencies, "vitest/vitest.mjs"), "run", "test", "--maxWorkers", "2")
} finally {
  await rm(scratch, { recursive: true, force: true })
}
