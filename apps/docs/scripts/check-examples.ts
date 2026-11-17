#!/usr/bin/env bun

/**
 * Type-checks and executes every `@example` block, asserting printed output.
 *
 * `@effect/docgen` covers part of this and misses two things. It collects
 * examples from module members, interfaces, type aliases, and class *methods*
 * only, so an example on a class' own doc comment is rendered into the API page
 * but never compiled. And while it executes the examples it does collect, it
 * asserts nothing about what they print, so a trailing `// output` comment can
 * drift from reality unnoticed.
 *
 * This script closes both gaps: it compiles every example, and for those ending
 * in `Effect.runPromise(...).then(console.log)` it runs them and compares stdout
 * against the trailing comment.
 */

import { spawn } from "bun"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { publicEntries, validateInventory, type Workspace } from "../../../tools/checks/repository.mjs"
import { collectPublicExamples, expectedExampleOutput } from "./public-examples"

const root = path.resolve(import.meta.dirname, "../../..")

const workspaces = (await validateInventory()).filter((workspace) =>
  workspace.policy.kind === "library" && workspace.manifest.private !== true
)

const tsc = path.join(root, "node_modules/.bin/tsc")

/** Node and Bun pad array inspections differently; compare on collapsed whitespace. */
const normalise = (text: string): string => text.replace(/\s+/g, " ").trim()

interface Example {
  readonly name: string
  readonly source: string
  readonly line: number
  readonly body: string
  readonly expected: string | undefined
}

const collect = async (workspace: Workspace): Promise<Array<Example>> => {
  const examples: Array<Example> = []

  for (const entry of publicEntries(workspace)) {
    const content = await Bun.file(path.join(root, entry.source)).text()

    for (const example of collectPublicExamples(content, entry.source)) {
      const expected = expectedExampleOutput(example.body, `${entry.source}:${example.line}`)

      examples.push({
        name: `${path.basename(entry.source, ".ts")}-${examples.length}`,
        source: `${path.basename(entry.source)}:${example.line}`,
        line: example.line,
        body: example.body,
        expected
      })
    }
  }

  return examples
}

const failures: Array<string> = []

let compiled = 0

let asserted = 0

for (const workspace of workspaces) {
  const packagePath = workspace.directory
  const packageDir = path.join(root, packagePath)
  const cacheDir = path.join(packageDir, ".cache")

  await mkdir(cacheDir, { recursive: true })
  const stagingDir = await mkdtemp(path.join(cacheDir, "examples-"))

  try {
    const examples = await collect(workspace)

    if (examples.length === 0) continue

    for (const example of examples) {
      await writeFile(path.join(stagingDir, `${example.name}.ts`), `${example.body}\n`, "utf8")
    }

    await writeFile(
      path.join(stagingDir, "tsconfig.json"),
      `${
        JSON.stringify(
          {
            extends: "../../tsconfig.json",
            compilerOptions: {
              noEmit: true,
              rootDir: ".",
              types: workspace.policy.runtime === "node" ? ["node"] : []
            },
            include: ["*.ts"]
          },
          null,
          2
        )
      }\n`,
      "utf8"
    )

    const typeCheck = spawn([tsc, "--project", path.join(stagingDir, "tsconfig.json")], {
      cwd: packageDir,
      stdout: "inherit",
      stderr: "inherit"
    })

    if (await typeCheck.exited !== 0) {
      throw new Error(`Examples failed to type-check in ${packagePath}`)
    }

    compiled += examples.length

    for (const example of examples) {
      if (example.expected === undefined) continue

      const runtime = workspace.policy.runtime === "bun"
        ? ["bun"]
        : ["node", ...(workspace.policy.runtime === "node" ? ["--experimental-vfs"] : []), "--import", "tsx"]

      // Regular files preserve Node console output when Bun launches the subprocess.
      const stdoutFile = Bun.file(path.join(stagingDir, `${example.name}.stdout`))
      const stderrFile = Bun.file(path.join(stagingDir, `${example.name}.stderr`))

      const run = spawn([...runtime, path.join(stagingDir, `${example.name}.ts`)], {
        cwd: packageDir,
        stdout: stdoutFile,
        stderr: stderrFile
      })

      const exitCode = await run.exited
      const [stdout, stderr] = await Promise.all([stdoutFile.text(), stderrFile.text()])

      if (exitCode !== 0) {
        failures.push(`${packagePath}/src/${example.source} failed to run:\n${stderr.trim()}`)
        continue
      }

      asserted += 1

      if (normalise(stdout) !== normalise(example.expected)) {
        failures.push(
          `${packagePath}/src/${example.source} output comment does not match\n`
            + `  comment: ${normalise(example.expected)}\n`
            + `  actual:  ${normalise(stdout)}`
        )
      }
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}

if (failures.length > 0) {
  throw new Error(`Example checks failed:\n\n${failures.join("\n\n")}`)
}

console.log(
  `Examples are valid: ${compiled} compiled, ${asserted} executed with output asserted.`
)
