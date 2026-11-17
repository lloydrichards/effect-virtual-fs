// Qualify regeneration in a temporary package so failure probes cannot modify the working port.
/* eslint-disable effecttsgo/node-builtin-import */
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))

const temporary = await mkdtemp(join(tmpdir(), "effect-preview-sync-"))

try {
  await mkdir(join(temporary, "scripts"))
  await cp(join(root, "scripts/sync.mjs"), join(temporary, "scripts/sync.mjs"))
  await cp(join(root, "upstream"), join(temporary, "upstream"), { recursive: true })

  const run = (...args) =>
    spawnSync(process.execPath, [join(temporary, "scripts/sync.mjs"), ...args], { encoding: "utf8" })

  const generated = run()
  assert.equal(generated.status, 0, generated.stderr)
  assert.equal(run("--check").status, 0)

  for (const directory of ["src", "test", "typetest"]) {
    for (const path of await readdir(join(temporary, directory), { recursive: true })) {
      if (!path.endsWith(".ts")) continue
      assert.equal(
        await readFile(join(temporary, directory, path), "utf8"),
        await readFile(join(root, directory, path), "utf8"),
        path
      )
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

  const snapshotPath = join(temporary, "upstream/files.json")
  const manifestPath = join(temporary, "upstream/manifest.json")
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"))
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  const corrupted = structuredClone(snapshot)
  corrupted.files[0].patch += "\n"
  await writeFile(snapshotPath, JSON.stringify(corrupted))
  assert.notEqual(run().status, 0, "A corrupted snapshot must fail regeneration")

  const spawnImport = "+import { execFile } from \"node:child_process\"\n"

  const cases = [
    {
      path: "src/Schema.ts",
      anchor: "+import * as BytePath_ from \"./BytePath.ts\"\n",
      replacement: "",
      adaptation: "remove the upstream BytePath import",
      matches: 0
    },
    {
      path: "test/virtual-file-system/VirtualFileSystem.test.ts",
      anchor: spawnImport,
      replacement: spawnImport.repeat(2),
      adaptation: "use spawn for the identity probe",
      matches: 2
    }
  ]

  for (const { path, anchor, replacement, adaptation, matches } of cases) {
    const changed = structuredClone(snapshot)
    const file = changed.files.find(({ filename }) => filename === `packages/effect/${path}`)
    assert.ok(file.patch.includes(anchor), `Fixture anchor is missing in ${path}`)
    file.patch = file.patch.replace(anchor, replacement)
    const files = { ...manifest.files, [path]: createHash("sha256").update(file.patch).digest("hex") }
    await writeFile(snapshotPath, JSON.stringify(changed))
    await writeFile(manifestPath, JSON.stringify({ ...manifest, files }))

    const result = run()
    assert.notEqual(result.status, 0, `Regeneration must fail for ${path}: ${adaptation}`)

    const diagnostic = result.stderr.split("\n").find((line) => /^error:/i.test(line) && line.includes(path))
    assert.ok(diagnostic?.includes(adaptation), result.stderr)
    assert.match(diagnostic.slice(diagnostic.indexOf(adaptation) + adaptation.length), new RegExp(`\\b${matches}\\b`))
  }

  process.stdout.write(
    "Offline regeneration, generated-file drift, unexpected files, snapshot corruption, and adaptation checks passed.\n"
  )
} finally {
  await rm(temporary, { recursive: true, force: true })
}
