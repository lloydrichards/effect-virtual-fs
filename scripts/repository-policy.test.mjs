import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { discoverWorkspaces, publicEntries, validateInventory } from "./repository-policy.mjs"

const temporary = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function repository() {
  const directory = await mkdtemp(path.join(tmpdir(), "vfs-policy-"))
  temporary.push(directory)
  await mkdir(path.join(directory, "packages/example/src"), { recursive: true })
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }))
  await writeFile(
    path.join(directory, "packages/example/package.json"),
    JSON.stringify({
      name: "example",
      exports: { "./Example": { types: "./dist/Example.d.ts", import: "./dist/Example.js" }, "./internal/*": null }
    })
  )
  await writeFile(path.join(directory, "packages/example/tsconfig.json"), "{}")
  await writeFile(path.join(directory, "packages/example/src/Example.ts"), "export const example = 1")

  return directory
}

const policy = {
  kind: "library",
  runtime: "mixed",
  effects: true,
  documentation: "public",
  allowedDependencies: []
}

test("new workspaces require a validation policy", async () => {
  const directory = await repository()
  const workspaces = await discoverWorkspaces(directory, {})
  await expect(validateInventory(workspaces, directory, {})).rejects.toThrow("missing repository validation policy")
})

test("published exports require corresponding source modules", async () => {
  const directory = await repository()
  const registry = { "packages/example": policy }
  await validateInventory(undefined, directory, registry)
  await rm(path.join(directory, "packages/example/src/Example.ts"))
  await expect(validateInventory(undefined, directory, registry)).rejects.toThrow("has no source")
})

test("removed workspaces cannot leave stale exclusions", async () => {
  const directory = await repository()
  await expect(validateInventory(undefined, directory, { "packages/example": policy, "packages/removed": policy }))
    .rejects.toThrow("missing workspace packages/removed")
})

test("diagnostic exclusions need an explanation", async () => {
  const directory = await repository()
  await expect(validateInventory(undefined, directory, { "packages/example": { ...policy, effects: false } }))
    .rejects.toThrow("effects needs an explicit policy or exclusion reason")
})

test("export discovery includes the root but excludes blocked internals and metadata", () => {
  expect(publicEntries({
    directory: "packages/example",
    manifest: {
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./Example": { types: "./dist/Example.d.ts", import: "./dist/Example.js" },
        "./internal/*": null,
        "./package.json": "./package.json"
      }
    }
  })).toEqual([
    { subpath: ".", source: "packages/example/src/index.ts" },
    { subpath: "./Example", source: "packages/example/src/Example.ts" }
  ])
})

test("unsupported live exports cannot silently escape validation", () => {
  const unsupported = [
    "./dist/Example.js",
    ["./dist/Example.js"],
    { import: "./dist/Example.js" },
    { types: "./dist/Example.d.ts" },
    { node: { types: "./dist/Example.d.ts", import: "./dist/Example.js" } },
    { types: "./dist/Example.d.ts", import: "./dist/Example.js", browser: "./dist/browser.js" }
  ]

  for (const target of unsupported) {
    expect(() => publicEntries({ directory: "packages/example", manifest: { exports: { "./Example": target } } }))
      .toThrow("unsupported public export ./Example")
  }
})

test("declaration mapping stays inside dist and matches the runtime module", () => {
  const unsupported = [
    { types: "./dist/Example.ts", import: "./dist/Example.js" },
    { types: "./other/Example.d.ts", import: "./other/Example.js" },
    { types: "./dist/../Example.d.ts", import: "./dist/../Example.js" },
    { types: "./dist//Example.d.ts", import: "./dist//Example.js" },
    { types: "./dist/sub/../../Example.d.ts", import: "./dist/sub/../../Example.js" },
    { types: "./dist/Example.d.ts", import: "./dist/Different.js" }
  ]

  for (const target of unsupported) {
    expect(() => publicEntries({ directory: "packages/example", manifest: { exports: { "./Example": target } } }))
      .toThrow("unsupported public export ./Example")
  }

  expect(publicEntries({
    directory: "packages/example",
    manifest: {
      exports: { "./nested/Example": { types: "./dist/nested/Example.d.ts", import: "./dist/nested/Example.js" } }
    }
  })).toEqual([{ subpath: "./nested/Example", source: "packages/example/src/nested/Example.ts" }])
})

test("only the exact package metadata export is exempt", () => {
  expect(
    publicEntries({ directory: "packages/example", manifest: { exports: { "./package.json": "./package.json" } } })
  ).toEqual([])

  for (
    const exports of [
      { "./package.json": "./dist/Example.js" },
      { "./settings.json": "./settings.json" },
      { "./native": "./native.node" },
      { "./*": { types: "./dist/Example.d.ts", import: "./dist/Example.js" } }
    ]
  ) {
    expect(() => publicEntries({ directory: "packages/example", manifest: { exports } })).toThrow(
      "unsupported public export"
    )
  }
})

test("a top-level shorthand or conditional export map needs an explicit policy implementation", () => {
  for (
    const exports of [
      "./dist/Example.js",
      ["./dist/Example.js"],
      { types: "./dist/Example.d.ts", import: "./dist/Example.js" }
    ]
  ) {
    expect(() => publicEntries({ directory: "packages/example", manifest: { exports } })).toThrow("unsupported")
  }
})

test("missing workspace names fail dependency inventory validation", async () => {
  const directory = await repository()
  const registry = { "packages/example": policy }
  const workspaces = await discoverWorkspaces(directory, registry)
  delete workspaces[0].manifest.name
  await expect(validateInventory(workspaces, directory, registry)).rejects.toThrow("missing workspace package name")
})
