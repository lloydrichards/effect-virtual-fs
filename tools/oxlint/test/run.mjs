import { strict as assert } from "node:assert"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import policy from "../../../oxlint.config.ts"

import { ruleCases } from "./cases.mjs"

const root = path.resolve(import.meta.dirname, "../../..")

const oxlint = path.join(root, "node_modules/.bin/oxlint")

const enabledRules = [
  ...new Set(
    [policy.rules, ...policy.overrides.map((override) => override.rules)].flatMap((rules) =>
      Object.entries(rules).flatMap(([name, value]) => name.startsWith("anti-slop") && value !== "off" ? [name] : [])
    )
  )
]

assert.deepEqual(
  Object.keys(ruleCases).sort(),
  enabledRules.sort(),
  "Every enabled custom rule needs accepted and rejected fixtures"
)

const parseReport = (result, file) => {
  assert(result.exitCode === 0 || result.exitCode === 1, `Oxlint crashed for ${file}: ${result.stderr.toString()}`)
  const report = JSON.parse(result.stdout.toString())
  assert(Array.isArray(report.diagnostics), `Oxlint did not return diagnostics for ${file}`)
  assert.equal(
    result.exitCode,
    report.diagnostics.length === 0 ? 0 : 1,
    `Oxlint exit code disagrees with diagnostics for ${file}`
  )

  return report.diagnostics
}

const directory = await mkdtemp(path.join(tmpdir(), "vfs-lint-policy-"))

let fixtures = 0

try {
  const configPath = path.join(directory, "oxlint.json")
  const filePath = path.join(directory, "case.ts")

  for (const [rule, cases] of Object.entries(ruleCases)) {
    const config = {
      jsPlugins: policy.jsPlugins.map((plugin) => ({ ...plugin, specifier: path.resolve(root, plugin.specifier) })),
      categories: { correctness: "off" },
      rules: { [rule]: "error" }
    }

    await writeFile(configPath, JSON.stringify(config))
    const code = rule.replace("/", "(") + ")"

    for (const [kind, sources] of Object.entries(cases)) {
      assert(sources.length > 0, `${rule} needs ${kind} fixtures`)

      for (const [index, source] of sources.entries()) {
        await writeFile(filePath, source + "\n")

        const result = Bun.spawnSync([
          oxlint,
          "--config",
          configPath,
          "--disable-nested-config",
          "--format",
          "json",
          filePath
        ], { cwd: root })

        const diagnostics = parseReport(result, `${rule} ${kind} ${index + 1}`)
        const expected = kind === "valid" ? [] : [code]
        assert.deepEqual(
          diagnostics.map((diagnostic) => diagnostic.code),
          expected,
          `${rule} ${kind} ${index + 1}: ${source}\n${JSON.stringify(diagnostics)}`
        )
        fixtures++
      }
    }
  }

  const scopedConfigPath = path.join(directory, "oxlint.config.ts")
  await writeFile(
    scopedConfigPath,
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

  const libraryFiles = [
    "packages/core/src/internal/tracing.ts",
    "packages/memory/src/tracing.ts",
    "packages/nfs/src/tracing.ts",
    "packages/node/src/tracing.ts",
    "packages/persistence/src/tracing.ts"
  ]

  const allowedFiles = [
    "apps/docs/examples/tracing.ts",
    "apps/demo-overlay/src/tracing.ts",
    "packages/core/examples/tracing.ts",
    "packages/core/src/examples/tracing.ts",
    "packages/core/src/tracing.test.ts",
    "packages/core/test/tracing.ts"
  ]

  const generatedFile = "packages/effect-preview/src/tracing.ts"
  const lintedFiles = [...libraryFiles, ...allowedFiles]

  for (const filename of [...lintedFiles, generatedFile]) {
    await mkdir(path.join(directory, path.dirname(filename)), { recursive: true })
    await writeFile(
      path.join(directory, filename),
      `import { Effect, Stream } from "effect"

Effect.fn("scope")

Effect.withSpan("scope")

Stream.withSpan("scope")
`
    )
  }

  const scopeOptions = [oxlint, "--config", scopedConfigPath, "--disable-nested-config"]
  const paths = [...lintedFiles, generatedFile]
  const participation = Bun.spawnSync([...scopeOptions, "--debug", "files", ...paths], { cwd: directory })
  assert.equal(participation.exitCode, 0, participation.stderr.toString())
  assert.deepEqual(participation.stdout.toString().trim().split("\n").sort(), [...lintedFiles].sort())

  const scopedResult = Bun.spawnSync([...scopeOptions, "--format", "json", ...paths], { cwd: directory })
  const scopedDiagnostics = parseReport(scopedResult, "package tracing scope")
  assert.deepEqual(
    scopedDiagnostics
      .filter(({ code }) => code === "anti-slop-effect(no-package-spans)")
      .map(({ filename }) => filename)
      .sort(),
    libraryFiles.flatMap((filename) => [filename, filename, filename]).sort()
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}

console.log(`Custom lint policy passed: ${enabledRules.length} rules, ${fixtures} isolated fixtures.`)
