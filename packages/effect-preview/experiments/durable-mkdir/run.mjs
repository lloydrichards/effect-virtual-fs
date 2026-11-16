// Apply the candidate after the MVP patches in a disposable preview package.
/* eslint-disable effecttsgo/node-builtin-import */
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
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

  const seriesPath = join(scratch, "patches/series.json")
  const series = JSON.parse(await readFile(seriesPath, "utf8"))

  for (const file of ["publication.patch", "file-cleanup.patch"]) {
    const patch = await readFile(join(experiment, file))
    series.push({ file, sha256: createHash("sha256").update(patch).digest("hex") })
    await writeFile(join(scratch, "patches", file), patch)
  }

  await writeFile(seriesPath, JSON.stringify(series))

  const run = (...args) => execFileSync(process.execPath, args, { cwd: scratch, stdio: "inherit" })
  run("scripts/sync.mjs")
  // Compile the trial alongside this engine so the caller registry and revision tokens share one instance.
  const trialSource = await readFile(join(experiment, "trial.ts"), "utf8")
  await mkdir(join(scratch, "src/trial"))
  await writeFile(join(scratch, "src/trial/mkdir.ts"), trialSource.replaceAll("../../src/", "../"))
  const manifestPath = join(scratch, "package.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  manifest.exports["./durable-mkdir"] = { types: "./dist/trial/mkdir.d.ts", import: "./dist/trial/mkdir.js" }
  await writeFile(manifestPath, JSON.stringify(manifest))
  run(join(dependencies, ".bin/tsc"), "-p", "tsconfig.build.json")
  run("experiments/durable-mkdir/check.mjs")

  const core = join(scratch, "core")

  for (const path of ["src", "package.json", "tsconfig.build.json"]) {
    await cp(resolve(preview, "../core", path), join(core, path), { recursive: true })
  }

  await mkdir(join(core, "node_modules/@effect-vfs"), { recursive: true })
  await symlink(scratch, join(core, "node_modules/@effect-vfs/effect-preview"), "dir")
  await cp(join(experiment, "core-adapter.ts"), join(core, "src/internal/durableMkdirTrial.ts"))
  execFileSync("git", ["apply", join(experiment, "core-reopen.patch")], { cwd: core })
  run(join(dependencies, ".bin/tsc"), "-p", join(core, "tsconfig.build.json"))
  run("experiments/durable-mkdir/reopen.mjs")
  run("experiments/durable-mkdir/cleanup.mjs")
  const vitest = join(dependencies, "vitest/vitest.mjs")
  run(vitest, "run", "test", "--maxWorkers", "2")

  for (const path of ["test/LiveVolume.test.ts", "test/internal/virtualFileSystem.test.ts", "test/support/lines.ts", "test/support/text.ts"]) {
    await cp(resolve(preview, "../core", path), join(core, path))
  }

  run(vitest, "run", "core/test/LiveVolume.test.ts", "core/test/internal/virtualFileSystem.test.ts", "-t",
    "detached directory|retain open content until close|typed commit failure also contains|stop paths, observations|persist final unlinked-file cleanup|release handles and disable|include open unlinked files|retain inode identity and open unlinked content|stop the volume when final handle cleanup")
} finally {
  await rm(scratch, { recursive: true, force: true })
}
