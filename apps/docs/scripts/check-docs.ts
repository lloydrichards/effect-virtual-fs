#!/usr/bin/env bun

import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { apiPages } from "../app/api-pages"
import { contentPages } from "../app/content-pages"
import { navigation } from "../app/nav.config"
import routes from "../app/routes"

const root = path.resolve(import.meta.dirname, "../../..")

const contentDir = path.join(root, "apps/docs/app/content")

const walk = async (directory: string): Promise<Array<string>> => {
  const entries = await readdir(directory, { withFileTypes: true })

  return (await Promise.all(entries.map((entry) => {
    const absolute = path.join(directory, entry.name)

    return entry.isDirectory() ? walk(absolute) : Promise.resolve([absolute])
  }))).flat()
}

const expectedContent = [
  "index.mdx",
  ...contentPages.map(({ contentPath }) => contentPath.replace("content/", "")),
  ...apiPages.map(({ contentPath }) => contentPath.replace("content/", ""))
].sort()

const actualContent = (await walk(contentDir))
  .map((file) => path.relative(contentDir, file))
  .filter((file) => file.endsWith(".mdx"))
  .sort()

const expectedRoutes = [...contentPages, ...apiPages].map(({ href }) => href).sort()

const assertEqual = (label: string, actual: ReadonlyArray<string>, expected: ReadonlyArray<string>): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch\nExpected: ${expected.join(", ")}\nActual: ${actual.join(", ")}`)
  }
}

assertEqual("Content", actualContent, expectedContent)

assertEqual(
  "Routes",
  routes.filter((entry) => "path" in entry).map((entry) => `/${entry.path}`).sort(),
  expectedRoutes
)

assertEqual("Navigation", navigation.flatMap(({ items }) => items.map(({ href }) => href)).sort(), expectedRoutes)

for (const page of apiPages) {
  const source = await readFile(path.join(root, page.packageDir, "src", `${page.moduleName}.ts`), "utf8")
  const generated = await readFile(path.join(root, "apps/docs/app", page.contentPath), "utf8")

  if (/export type \w+ =\s*typeof \w+\.Type\b/.test(generated)) {
    throw new Error(`${page.contentPath} contains an unresolved schema model signature`)
  }

  const internalImports = source.matchAll(/import\s+\*\s+as\s+(\w+)\s+from\s+["'][^"']*\/internal\/[^"']+["']/g)

  for (const [, namespace] of internalImports) {
    if (generated.includes(`typeof ${namespace}.`)) {
      throw new Error(`${page.contentPath} exposes typeof ${namespace} from an internal module`)
    }
  }
}

console.log(
  `Docs structure is valid: 1 landing page, ${contentPages.length} content pages, and ${apiPages.length} API pages.`
)
