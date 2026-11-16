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

  for (const file of ["publication.patch", "file-cleanup.patch", "file-acquisition.patch"]) {
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

  for (const path of ["test/FileHandle.test.ts", "test/VfsError.test.ts", "test/LiveVolumeRegistry.test.ts", "test/LiveVolume.test.ts", "test/internal/virtualFileSystem.test.ts", "test/internal/liveImage.test.ts", "test/support/lines.ts", "test/support/text.ts"]) {
    await cp(resolve(preview, "../core", path), join(core, path))
  }

  run(vitest, "run", "core/test/LiveVolume.test.ts", "-t",
    "should commit an access-time refresh only when a read changes it|should commit one refresh when two due reads wait|should avoid a commit when a change leaves state unchanged")

  run(vitest, "run", "core/test/LiveVolume.test.ts", "core/test/internal/virtualFileSystem.test.ts", "-t",
    "should admit one waiter and release its slot when it is cancelled|keep a memory volume usable when its no-op shutdown runs|detached directory|retain open content until close|typed commit failure also contains|stop paths, observations|persist final unlinked-file cleanup|release handles and disable|include open unlinked files|retain inode identity and open unlinked content|stop the volume when final handle cleanup")

  run(vitest, "run", "core/test/LiveVolumeRegistry.test.ts", "core/test/LiveVolume.test.ts",
    "core/test/internal/virtualFileSystem.test.ts", "-t",
    "should finish the active commit before releasing the provider|should preserve hard-link inode identity with a new incarnation|shares one acquisition while concurrent borrowers wait|shuts down the volume before storage")

  run(vitest, "run", "core/test/FileHandle.test.ts", "-t",
    "should interrupt (open|openReference|openChildReference) and release resources when its scope closes during a pending commit|should release resources when (open|openReference|openChildReference) scope and fiber close during its pending commit")

  const persistence = join(scratch, "persistence")

  for (const path of ["src", "test/SqliteLiveImageStore.test.ts", "test/R2LiveImageStore.test.ts", "test/fixtures/live-restart.ts"]) {
    await cp(resolve(preview, "../persistence", path), join(persistence, path), { recursive: true })
  }

  // The test and its independent Bun workers must all import the scratch core build.
  await mkdir(join(persistence, "node_modules/@effect-vfs"), { recursive: true })
  await symlink(core, join(persistence, "node_modules/@effect-vfs/core"), "dir")
  run(vitest, "run", "persistence/test/SqliteLiveImageStore.test.ts", "-t", "when the writer is killed",
    "--reporter", "verbose")

  const nfs = join(scratch, "nfs")
  for (const path of ["src", "test/internal/nfs4.test.ts", "test/support"]) {
    await cp(resolve(preview, "../nfs", path), join(nfs, path), { recursive: true })
  }
  await mkdir(join(nfs, "node_modules/@effect-vfs"), { recursive: true })
  await symlink(core, join(nfs, "node_modules/@effect-vfs/core"), "dir")

  run(vitest, "run", "core/test/LiveVolume.test.ts", "core/test/internal/liveImage.test.ts",
    "nfs/test/internal/nfs4.test.ts", "persistence/test/R2LiveImageStore.test.ts", "-t",
    "should compare capacity quantities|should re-encode identical bytes|should survive a server restart and report it in fh_expire_type|should answer STALE when a persistent handle|should report power-loss durability")
  run(vitest, "run", "core/test/LiveVolume.test.ts", "core/test/VfsError.test.ts",
    "persistence/test/R2LiveImageStore.test.ts", "persistence/test/SqliteLiveImageStore.test.ts", "-t",
    "should reject an oversized candidate|should attribute failure to commit|should preserve pre-write digest")
} finally {
  await rm(scratch, { recursive: true, force: true })
}
