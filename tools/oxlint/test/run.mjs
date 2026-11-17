import { strict as assert } from "node:assert"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import policy from "../../../oxlint.config.ts"

import { ruleCases } from "./cases.mjs"

const root = path.resolve(import.meta.dirname, "../../..")

const enabledRules = Object.keys(policy.rules).filter((rule) =>
  rule.startsWith("anti-slop") && policy.rules[rule] !== "off"
)

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

// Type-aware fixtures live under the workspace so their Effect imports resolve.
const cache = path.join(root, ".cache")
await mkdir(cache, { recursive: true })
const typedDirectory = await mkdtemp(path.join(cache, "vfs-tag-policy-"))

try {
  const configPath = path.join(typedDirectory, "oxlint.json")
  const filePath = path.join(typedDirectory, "tag-ownership.ts")
  await writeFile(
    configPath,
    JSON.stringify({
      jsPlugins: policy.jsPlugins.map((plugin) => ({ ...plugin, specifier: path.resolve(root, plugin.specifier) })),
      plugins: ["effecttsgo"],
      categories: { correctness: "off" },
      rules: {
        "effecttsgo/catch-all-tag-dispatch-to-catch-tag": "error",
        "effecttsgo/catch-if-tag-to-catch-tag": "error",
        "anti-slop-effect/no-manual-effect-error-tag": "error",
        "anti-slop-effect/no-manual-tag-comparison": "error"
      }
    })
  )

  for (const identifier of ["Effect", "E"]) {
    await writeFile(
      filePath,
      `
import { Effect${identifier === "E" ? " as E" : ""} } from "effect"
declare const task: ${identifier}.Effect<never, { readonly _tag: "Missing"; readonly reason: { readonly _tag: "A" | "B" } } | { readonly _tag: "Other"; readonly reason: { readonly _tag: "A" | "B" } }>
declare const state: { readonly _tag: "Closed" | "Open" }
export const direct = ${identifier}.catch(task, error => error._tag === "Missing" ? ${identifier}.succeed(1) : ${identifier}.fail(error))
export const predicate = ${identifier}.catchIf(task, error => error._tag === "Missing", () => ${identifier}.succeed(1))
export const reason = ${identifier}.catch(task, error => error.reason._tag === "A" ? ${identifier}.succeed(1) : error.reason._tag === "B" ? ${identifier}.succeed(2) : ${identifier}.fail(error))
export const external = ${identifier}.catch(task, error => state._tag === "Closed" ? ${identifier}.succeed(1) : ${identifier}.fail(error))
export const externalChain = state._tag === "Closed" ? 1 : state._tag === "Open" ? 2 : 3
`
    )
    const result = Bun.spawnSync([
      path.join(root, "node_modules/.bin/oxlint"),
      "--type-aware",
      "--config",
      configPath,
      "--disable-nested-config",
      "--format",
      "json",
      filePath
    ], { cwd: root })

    assert.deepEqual(
      parseReport(result, filePath).map((diagnostic) => [
        diagnostic.code,
        diagnostic.labels[0].span.line
      ]).sort(),
      [
        ["anti-slop-effect(no-manual-effect-error-tag)", 7],
        ["anti-slop-effect(no-manual-tag-comparison)", 9],
        ["effecttsgo(catch-all-tag-dispatch-to-catch-tag)", 5],
        ["effecttsgo(catch-if-tag-to-catch-tag)", 6]
      ],
      `Unexpected native/custom catch-tag policy for ${identifier}: ${result.stdout.toString()}`
    )
  }
} finally {
  await rm(typedDirectory, { recursive: true, force: true })
}

console.log("Native and custom tag diagnostics have separate ownership for canonical and aliased imports.")
