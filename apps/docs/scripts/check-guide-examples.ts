#!/usr/bin/env bun

import { spawn } from "bun"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "../../..")

const docs = path.join(root, "apps/docs")

const guide = path.join(docs, "app/content/guides/testing-with-an-isolated-filesystem.mdx")

const staging = path.join(docs, ".cache/testing-guide-examples")

const source = await readFile(guide, "utf8")

const blocks = [...source.matchAll(/^```ts(?: ([^\n]*))?\n([\s\S]*?)^```$/gm)]

const names = new Set<string>()

if (blocks.length === 0) throw new Error("The testing guide has no TypeScript examples")

await rm(staging, { recursive: true, force: true })

await mkdir(staging, { recursive: true })

try {
  for (const block of blocks) {
    const name = /^title="([A-Za-z][A-Za-z0-9-]*\.(?:test\.)?ts)"$/.exec(block[1] ?? "")?.[1]

    if (name === undefined) throw new Error("Each testing guide example needs a TypeScript filename title")

    if (names.has(name)) throw new Error(`Duplicate testing guide example: ${name}`)
    names.add(name)
    await writeFile(path.join(staging, name), block[2]!)
  }

  if (![...names].some((name) => name.endsWith(".test.ts"))) {
    throw new Error("The testing guide has no runnable test examples")
  }

  await writeFile(
    path.join(staging, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          skipLibCheck: true,
          types: ["bun"]
        },
        include: ["*.ts"]
      },
      null,
      2
    )
  )
  await writeFile(
    path.join(staging, "vitest.config.ts"),
    "import { defineConfig } from \"vitest/config\"\n"
      + "export default defineConfig({ test: { include: [\"*.test.ts\"], passWithNoTests: false } })\n"
  )

  const commands = [
    [path.join(root, "node_modules/.bin/tsc"), "--project", path.join(staging, "tsconfig.json")],
    ["bun", "--bun", path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.ts"]
  ]

  for (const command of commands) {
    const check = spawn(command, { cwd: staging, stdout: "inherit", stderr: "inherit" })

    if (await check.exited !== 0) throw new Error(`Testing guide examples failed: ${command[0]}`)
  }

  console.log(`Testing guide examples are valid: ${names.size} exact MDX snippets compiled and their tests passed.`)
} finally {
  await rm(staging, { recursive: true, force: true })
}
