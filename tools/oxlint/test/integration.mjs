import { strict as assert } from "node:assert"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import policy from "../../../oxlint.config.ts"

import { lintRootFixtures } from "./root-fixtures.mjs"
import { checkSuppressionIntegration } from "./suppressions.mjs"

const root = path.resolve(import.meta.dirname, "../../..")

export async function checkCustomLintIntegration() {
  const scopeSource = `import * as Internal from "./internal/model.js"
import { Effect } from "effect"

export default Internal.read

export const execute = Effect.fnUntraced(function*() {
  yield* Effect.void
})

export const payload = { _tag: "Missing", reason: "example" }
`

  const publicFile = "packages/core/src/scope.ts"

  const internalFile = "packages/core/src/internal/scope.ts"

  const testFile = "packages/core/test/scope.test.ts"

  const applicationFile = "apps/demo-alchemy/src/scope.ts"

  const scopeFiles = [publicFile, internalFile, testFile, applicationFile]

  const scope = await lintRootFixtures(Object.fromEntries(scopeFiles.map((filename) => [filename, scopeSource])))

  assert.deepEqual(scope.participants, scopeFiles.toSorted())

  const aliasRule = "anti-slop(require-public-internal-alias-type)"

  const signatureRule = "anti-slop(require-public-effect-fn-signature)"

  const constructionRule = "anti-slop-effect(no-manual-tagged-construction)"

  const scopeRules = new Set([aliasRule, signatureRule, constructionRule])

  assert.deepEqual(
    scope.diagnostics.filter(({ code }) => scopeRules.has(code)).map(({ code, filename }) => `${filename} ${code}`)
      .sort(),
    [
      `${publicFile} ${aliasRule}`,
      `${publicFile} ${signatureRule}`,
      `${publicFile} ${constructionRule}`,
      `${internalFile} ${constructionRule}`,
      `${applicationFile} ${constructionRule}`
    ].sort(),
    "Public contracts apply only to the public library file and tag construction excludes the test file"
  )

  const directory = await mkdtemp(path.join(tmpdir(), "vfs-custom-lint-integration-"))

  try {
    const configPath = path.join(directory, "oxlint.json")

    const args = [
      path.join(root, "node_modules/.bin/oxlint"),
      "--config",
      configPath,
      "--disable-nested-config",
      "--format",
      "json"
    ]

    const lint = (paths, flags = []) => {
      const result = Bun.spawnSync([...args, ...flags, ...paths], { cwd: directory })

      assert(result.exitCode === 0 || result.exitCode === 1, result.stderr.toString())

      const { diagnostics } = JSON.parse(result.stdout.toString())

      assert.equal(result.exitCode, diagnostics.length === 0 ? 0 : 1, result.stderr.toString())

      return diagnostics.map(({ code }) => code).sort()
    }

    const writeConfig = (rules) =>
      writeFile(
        configPath,
        JSON.stringify({
          jsPlugins: policy.jsPlugins.map((plugin) => ({ ...plugin, specifier: path.resolve(root, plugin.specifier) })),
          categories: { correctness: "off" },
          rules
        })
      )

    await writeConfig(
      Object.fromEntries(Object.entries(policy.rules).filter(([rule]) => rule.startsWith("anti-slop-effect/")))
    )
    await writeFile(
      path.join(directory, "tags.ts"),
      `import { Effect } from "effect"

export const recovered = Effect.catch(task, (error) => error.reason._tag === "Missing" ? fallback : failed)

export const missing = value._tag === "Missing"
`
    )
    assert.deepEqual(
      lint(["tags.ts"]),
      ["anti-slop-effect(no-manual-effect-error-tag)", "anti-slop-effect(no-manual-tag-comparison)"],
      "The caught reason gets the handler diagnostic and the standalone comparison gets the general diagnostic"
    )

    await writeConfig({ "anti-slop/require-readable-spacing": "error" })

    const spacing = [
      {
        file: "comment.ts",
        before: `const first = 1 // Trailing comment
/** Describes the second declaration. */
const second = 2
`,
        after: `const first = 1 // Trailing comment

/** Describes the second declaration. */
const second = 2
`
      },
      {
        file: "same-line.ts",
        before: "const first = 1; const second = 2;\n",
        after: "const first = 1;\n\n const second = 2;\n"
      },
      {
        file: "overload.ts",
        before: `export function read(value: string): string
export function read(value: number): number
export function read(value: string | number) {
  return value
}
export const result = read(1)
`,
        after: `export function read(value: string): string
export function read(value: number): number
export function read(value: string | number) {
  return value
}

export const result = read(1)
`
      }
    ]

    await Promise.all(spacing.map(({ file, before }) => writeFile(path.join(directory, file), before)))

    const spacingFiles = spacing.map(({ file }) => file)

    assert.deepEqual(lint(spacingFiles), spacingFiles.map(() => "anti-slop(require-readable-spacing)"))

    for (const attempt of [1, 2]) {
      assert.deepEqual(lint(spacingFiles, ["--fix"]), [])

      for (const { file, after } of spacing) {
        assert.equal(await readFile(path.join(directory, file), "utf8"), after, `${file} after spacing fix ${attempt}`)
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }

  await checkSuppressionIntegration()

  console.log("Custom lint integration passed: root scope, combined tag diagnostics, and spacing fixes.")
}
