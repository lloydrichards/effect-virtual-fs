import { strict as assert } from "node:assert"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import policy from "../../../oxlint.config.ts"
import boundaryAudit from "../boundary-audit.config.ts"

import { ruleCases } from "./cases.mjs"

const root = path.resolve(import.meta.dirname, "../../..")

const enabledRules = Object.keys(policy.rules).filter((rule) =>
  rule.startsWith("anti-slop") && policy.rules[rule] !== "off"
)

enabledRules.push(...Object.keys(boundaryAudit.rules))

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
          path.join(root, "node_modules/.bin/oxlint"),
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
} finally {
  await rm(directory, { recursive: true, force: true })
}

console.log(`Custom lint policy passed: ${enabledRules.length} rules, ${fixtures} isolated fixtures.`)
