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
import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const EXAMPLE_BLOCK = /@example\n\s*\*\s*```ts\n([\s\S]*?)\n\s*\*\s*```/g

const OWNER = /(?:export (?:const|class|interface|type|function)|static) (\w+)/

const EXPECTED_OUTPUT = /\n\/\/ ([^\n]*)$/

const root = path.resolve(import.meta.dirname, "../../..")

const packageDirs = ["packages/core", "packages/memory", "packages/persistence"]

const tsc = path.join(root, "node_modules/.bin/tsc")

const tsx = path.join(root, "node_modules/.bin/tsx")

const undent = (block: string): string => block.split("\n").map((line) => line.replace(/^\s*\*\s?/, "")).join("\n")

/** Node and Bun pad array inspections differently; compare on collapsed whitespace. */
const normalise = (text: string): string => text.replace(/\s+/g, " ").trim()

interface Example {
  readonly name: string
  readonly source: string
  readonly line: number
  readonly body: string
  readonly expected: string | undefined
}

const collect = async (srcDir: string): Promise<Array<Example>> => {
  const files = (await readdir(srcDir, { recursive: true }))
    .filter((file) => file.endsWith(".ts") && !file.includes("internal/") && file !== "index.ts")

  const examples: Array<Example> = []

  for (const file of files) {
    const content = await Bun.file(path.join(srcDir, file)).text()

    for (const match of content.matchAll(EXAMPLE_BLOCK)) {
      const body = undent(match[1]!)

      const line = content.slice(0, match.index).split("\n").length

      const owner = content.slice(match.index).match(OWNER)?.[1] ?? "module"

      const expected = body.includes(".then(console.log)")
        ? EXPECTED_OUTPUT.exec(body)?.[1]
        : undefined

      examples.push({
        name: `${path.basename(file, ".ts")}-${owner}-${examples.length}`,
        source: `${file}:${line}`,
        line,
        body,
        expected
      })
    }
  }

  return examples
}

const failures: Array<string> = []

let compiled = 0

let asserted = 0

for (const packagePath of packageDirs) {
  const packageDir = path.join(root, packagePath)
  const stagingDir = path.join(packageDir, ".cache/examples")

  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(stagingDir, { recursive: true })

  const examples = await collect(path.join(packageDir, "src"))

  if (examples.length === 0) {
    await rm(stagingDir, { recursive: true, force: true })
    continue
  }

  for (const example of examples) {
    await writeFile(path.join(stagingDir, `${example.name}.ts`), `${example.body}\n`, "utf8")
  }

  await writeFile(
    path.join(stagingDir, "tsconfig.json"),
    `${
      JSON.stringify(
        {
          extends: "../../tsconfig.json",
          compilerOptions: { noEmit: true, rootDir: ".", types: [] },
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

    const run = spawn([tsx, path.join(stagingDir, `${example.name}.ts`)], {
      cwd: packageDir,
      stdout: "pipe",
      stderr: "pipe"
    })

    const [stdout, stderr] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text()
    ])

    if (await run.exited !== 0) {
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

  await rm(stagingDir, { recursive: true, force: true })
}

if (failures.length > 0) {
  throw new Error(`Example checks failed:\n\n${failures.join("\n\n")}`)
}

console.log(
  `Examples are valid: ${compiled} compiled, ${asserted} executed with output asserted.`
)
