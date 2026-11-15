// Qualify regeneration in a temporary package so failure probes cannot modify the working port.
/* eslint-disable effecttsgo/node-builtin-import */
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))

const temporary = await mkdtemp(join(tmpdir(), "effect-preview-sync-"))

try {
  await mkdir(join(temporary, "scripts"))
  await cp(join(root, "scripts/sync.mjs"), join(temporary, "scripts/sync.mjs"))
  await cp(join(root, "upstream"), join(temporary, "upstream"), { recursive: true })
  await cp(join(root, "patches"), join(temporary, "patches"), { recursive: true })

  const run = (...args) => spawnSync(process.execPath, [join(temporary, "scripts/sync.mjs"), ...args], { encoding: "utf8" })

  const generated = run()
  assert.equal(generated.status, 0, generated.stderr)
  assert.equal(run("--check").status, 0)

  for (const directory of ["src", "test", "typetest"]) {
    for (const path of await readdir(join(temporary, directory), { recursive: true })) {
      if (!path.endsWith(".ts")) continue
      assert.equal(await readFile(join(temporary, directory, path), "utf8"), await readFile(join(root, directory, path), "utf8"), path)
    }
  }

  const engine = join(temporary, "src/virtual-file-system/internal/engine.ts")
  await writeFile(engine, "// accidental engine edit\n", { flag: "a" })
  assert.notEqual(run("--check").status, 0, "A manual engine edit must fail verification")
  assert.equal(run().status, 0, "Regeneration must restore the engine")

  const extra = join(temporary, "src/untracked.ts")
  await writeFile(extra, "export const extra = true\n")
  assert.notEqual(run("--check").status, 0, "Unexpected generated files must fail verification")
  await rm(extra)

  const series = JSON.parse(await readFile(join(temporary, "patches/series.json"), "utf8"))
  const contribution = join(temporary, "patches", series[0].file)
  const originalPatch = await readFile(contribution, "utf8")
  await writeFile(contribution, originalPatch + "\n")
  assert.notEqual(run().status, 0, "A corrupted contribution patch must fail regeneration")
  await writeFile(contribution, originalPatch)
  assert.equal(run("--check").status, 0, "Restoring the patch must restore reproducibility")

  const snapshotPath = join(temporary, "upstream/files.json")
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"))
  snapshot.files[0].patch += "\n"
  await writeFile(snapshotPath, JSON.stringify(snapshot))
  assert.notEqual(run().status, 0, "A corrupted snapshot must fail regeneration")
  process.stdout.write("Offline regeneration, generated-file drift, unexpected files, and snapshot/patch corruption checks passed.\n")
} finally {
  await rm(temporary, { recursive: true, force: true })
}
