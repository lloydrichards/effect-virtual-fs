import { strict as assert } from "node:assert"

const lint = (file) => {
  const result = Bun.spawnSync([
    "./node_modules/.bin/oxlint",
		"--config",
		"scripts/anti-slop-policy.config.json",
		"--disable-nested-config",
    "--format",
    "json",
    file
  ])

  const report = JSON.parse(result.stdout.toString())

  return new Set(report.diagnostics.map((diagnostic) => diagnostic.code))
}

const valid = lint("scripts/anti-slop-policy-fixtures/valid.ts")

const invalid = lint("scripts/anti-slop-policy-fixtures/invalid.ts")

const policyRules = [
  "anti-slop(no-shape-in-symbol-names)",
  "anti-slop-effect(no-manual-tagged-construction)",
  "anti-slop-effect(prefer-effect-match)"
]

for (const rule of policyRules) {
  assert(!valid.has(rule), `valid policy fixture triggered ${rule}`)
  assert(invalid.has(rule), `invalid policy fixture did not trigger ${rule}`)
}
