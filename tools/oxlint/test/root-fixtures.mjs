import { strict as assert } from "node:assert"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "../../..")

/** Lint repository-relative fixture paths with the root TypeScript config. */
export async function lintRootFixtures(files) {
  const directory = await mkdtemp(path.join(tmpdir(), "vfs-root-lint-"))

  try {
    const config = path.join(directory, "oxlint.config.ts")

    await writeFile(
      config,
      `import path from "node:path"
import policy from ${JSON.stringify(path.join(root, "oxlint.config.ts"))}
export default {
  ...policy,
  jsPlugins: policy.jsPlugins.map(plugin => ({
    ...plugin,
    specifier: path.resolve(${JSON.stringify(root)}, plugin.specifier)
  }))
}
`
    )
    await symlink(path.join(root, "node_modules"), path.join(directory, "node_modules"))

    for (const [filename, source] of Object.entries(files)) {
      const target = path.join(directory, filename)

      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, source)
    }

    const args = [path.join(root, "node_modules/.bin/oxlint"), "--config", config, "--disable-nested-config"]
    const paths = Object.keys(files)
    const participation = Bun.spawnSync([...args, "--debug", "files", ...paths], { cwd: directory })

    assert.equal(participation.exitCode, 0, participation.stderr.toString())

    const report = Bun.spawnSync([...args, "--format", "json", ...paths], { cwd: directory })

    assert(report.exitCode === 0 || report.exitCode === 1, report.stderr.toString())

    const { diagnostics } = JSON.parse(report.stdout.toString())

    assert(Array.isArray(diagnostics), "Oxlint did not return diagnostics for root scope fixtures")
    assert.equal(report.exitCode, diagnostics.length === 0 ? 0 : 1, report.stderr.toString())

    return {
      participants: participation.stdout.toString().trim().split("\n").filter(Boolean).sort(),
      diagnostics
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
