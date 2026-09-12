#!/usr/bin/env bun

import { spawn } from "bun"
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { apiPages } from "../app/api-pages"

const stripFrontmatter = (content: string): string => content.replace(/^---[\s\S]*?---\n*/, "")
const replaceTocHeader = (content: string): string =>
  content.replace(/<h2 class="text-delta">Table of contents<\/h2>/, "## Table of contents")
const stripInlineToc = (content: string): string =>
  content.replace(/^## Table of contents\n(?:\n|[ \t]*-[^\n]*\n)*---\n*/m, "")
const escapeLineForMdx = (line: string): string =>
  line
    .replace(/\{@link\s+([^}]+)\}/g, "`$1`")
    .replace(/(?<!`)(\w+)<([^>]+)>(?!`)/g, (_, name, parameters) => `\`${name}<${parameters}>\``)

const escapeMdxUnsafe = (content: string): string => {
  let inCodeBlock = false
  return content
    .split("\n")
    .map((line) => {
      if (line.startsWith("```")) {
        inCodeBlock = !inCodeBlock
        return line
      }
      return inCodeBlock ? line : escapeLineForMdx(line)
    })
    .join("\n")
}

const transformContent = (content: string, primary: boolean): string => {
  const withoutMetadata = stripInlineToc(replaceTocHeader(stripFrontmatter(content)))
  const headingsAdjusted = withoutMetadata.replace(/^(#{1,5}) /gm, "#$1 ")
  return escapeMdxUnsafe(primary ? headingsAdjusted.replace(/^#{2,6} /m, "# ") : headingsAdjusted)
}

const keepPublishedExports = (moduleName: string, content: string): string => {
  if (moduleName === "BytePath") return content.replace(/^# utils[\s\S]*$/m, "")
  if (moduleName === "SnapshotDelta") return content.replace(/^## makeSnapshotDeltaLimits[\s\S]*$/m, "")
  return content
}

const root = path.resolve(import.meta.dirname, "../../..")
const apiDir = path.join(root, "apps/docs/app/content/api")
const stagedApiDir = path.join(root, "apps/docs/.cache", `api-${process.pid}-${Date.now()}`)
const docgen = path.join(root, "node_modules/.bin/docgen")

await mkdir(stagedApiDir, { recursive: true })

for (const page of apiPages) {
  const packageDir = path.join(root, page.packageDir)
  if (page.packageDir === "packages/core") {
    const stagedSource = path.join(packageDir, ".cache/docgen-src")
    await rm(stagedSource, { recursive: true, force: true })
    await cp(path.join(packageDir, "src"), stagedSource, { recursive: true })
    const facadePath = path.join(stagedSource, "VirtualFileSystem.ts")
    const facade = await readFile(facadePath, "utf8")
    await writeFile(
      facadePath,
      facade.replace(/^export\s*\{[\s\S]*?\}\s*from\s*"\.\/(?:Snapshot|BytePath|SnapshotDelta)\.js"\n/gm, ""),
      "utf8"
    )
  }
  const child = spawn([docgen], {
    cwd: packageDir,
    env: { ...process.env, PATH: `${path.dirname(docgen)}:${process.env["PATH"] ?? ""}` },
    stdout: "inherit",
    stderr: "inherit"
  })
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`docgen failed for ${page.packageDir} with exit code ${exitCode}`)

  const generatedDir = path.join(packageDir, "docs/modules")
  const generatedFiles = await readdir(generatedDir, { recursive: true })
  const moduleFiles = new Map<string, string>()
  for (const moduleName of page.moduleNames) {
    const expectedFile = `${moduleName}.ts.md`
    const generatedFile = generatedFiles.find((file) => file === expectedFile || file.endsWith(`/${expectedFile}`))
    if (generatedFile === undefined) {
      throw new Error(`docgen did not generate ${page.packageDir}/docs/modules/${expectedFile}`)
    }
    moduleFiles.set(moduleName, generatedFile)
  }

  const modules = await Promise.all(
    page.moduleNames.map((moduleName) => readFile(path.join(generatedDir, moduleFiles.get(moduleName)!), "utf8"))
  )
  const source = modules
    .map((content, index) => transformContent(keepPublishedExports(page.moduleNames[index]!, content), index === 0))
    .join("\n\n---\n\n")
  const destination = path.join(stagedApiDir, page.contentPath.replace("content/api/", ""))
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, source, "utf8")
  console.log(`Generated ${page.contentPath}`)
}

await rm(apiDir, { recursive: true, force: true })
try {
  await rename(stagedApiDir, apiDir)
} catch (error) {
  if (
    !(error instanceof Error && "code" in error && (error.code === "EEXIST" || error.code === "ENOTEMPTY"))
  ) throw error
  await rm(stagedApiDir, { recursive: true, force: true })
}
