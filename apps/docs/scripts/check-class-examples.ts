#!/usr/bin/env bun

/**
 * Type-checks `@example` blocks attached to exported classes.
 *
 * `@effect/docgen` collects examples from module members, interfaces, type
 * aliases, and class *methods* only. An example on a class' own doc comment is
 * rendered into the API page but never compiled, and `enforceExamples` accepts
 * it unchecked. This script closes that gap.
 */

import { spawn } from "bun"
import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const CLASS_EXAMPLE = /\/\*\*(?:(?!\*\/)[\s\S])*?\*\/\s*export class (\w+)/g

const EXAMPLE_BLOCK = /@example\n \* ```ts\n([\s\S]*?)\n \* ```/g

const root = path.resolve(import.meta.dirname, "../../..")

const packageDirs = ["packages/core", "packages/memory", "packages/persistence"]

const undent = (block: string): string =>
  block
    .split("\n")
    .map((line) => line.startsWith(" * ") ? line.slice(3) : line.replace(" *", ""))
    .join("\n")

const tsc = path.join(root, "node_modules/.bin/tsc")

let checked = 0

for (const packagePath of packageDirs) {
  const packageDir = path.join(root, packagePath)
  const srcDir = path.join(packageDir, "src")
  const stagingDir = path.join(packageDir, ".cache/class-examples")

  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(stagingDir, { recursive: true })

  const sources = (await readdir(srcDir, { recursive: true }))
    .filter((file) => file.endsWith(".ts") && !file.includes("internal/") && file !== "index.ts")

  let staged = 0

  for (const file of sources) {
    const content = await Bun.file(path.join(srcDir, file)).text()

    for (const [documentation, className] of content.matchAll(CLASS_EXAMPLE)) {
      for (const [index, [, block]] of [...documentation.matchAll(EXAMPLE_BLOCK)].entries()) {
        const name = `${path.basename(file, ".ts")}-${className}-${index}.ts`

        await writeFile(path.join(stagingDir, name), `${undent(block!)}\n`, "utf8")
        staged += 1
      }
    }
  }

  if (staged === 0) {
    await rm(stagingDir, { recursive: true, force: true })
    continue
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

  const child = spawn([tsc, "--project", path.join(stagingDir, "tsconfig.json")], {
    cwd: packageDir,
    stdout: "inherit",
    stderr: "inherit"
  })

  if (await child.exited !== 0) {
    throw new Error(`Class @example blocks failed to type-check in ${packagePath}`)
  }

  await rm(stagingDir, { recursive: true, force: true })
  checked += staged
}

console.log(`Class @example blocks are valid: ${checked} example(s) type-checked.`)
