import { afterEach, expect, test } from "bun:test"
import { strict as assert } from "node:assert"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { validatePackedExports } from "../consumers.mjs"
import { discoverWorkspaces, publicEntries, validateInventory } from "../repository.mjs"

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

test("should reject an unclassified package when a workspace is added", async () => {
  const directory = await repository()
  const workspaces = await discoverWorkspaces(directory, {})
  await expect(validateInventory(workspaces, directory, {})).rejects.toThrow("missing repository validation policy")
})

test("should reject a public export when its source module is missing", async () => {
  const directory = await repository()
  const registry = { "packages/example": policy }
  await validateInventory(undefined, directory, registry)
  await rm(path.join(directory, "packages/example/src/Example.ts"))
  await expect(validateInventory(undefined, directory, registry)).rejects.toThrow("has no source")
})

test("should reject stale policy when a workspace is removed", async () => {
  const directory = await repository()
  await expect(validateInventory(undefined, directory, { "packages/example": policy, "packages/removed": policy }))
    .rejects.toThrow("missing workspace packages/removed")
})

test("should require a reason when diagnostics are excluded", async () => {
  const directory = await repository()
  await expect(validateInventory(undefined, directory, { "packages/example": { ...policy, effects: false } }))
    .rejects.toThrow("effects needs an explicit policy or exclusion reason")
})

test("should discover typed entrypoints when internals and metadata are also exported", () => {
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

test("should reject unsupported exports when discovery cannot qualify them", () => {
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

test("should reject invalid paths when declarations do not match their runtime module", () => {
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

test("should exempt metadata only when it exports the package manifest", () => {
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

test("should reject shorthand maps when typed subpaths are not explicit", () => {
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

test("should reject dependency inventory when a workspace has no name", async () => {
  const directory = await repository()
  const registry = { "packages/example": policy }
  const workspaces = await discoverWorkspaces(directory, registry)
  delete workspaces[0].manifest.name
  await expect(validateInventory(workspaces, directory, registry)).rejects.toThrow("missing workspace package name")
})

test("should reject a packed entrypoint when its runtime file is missing", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vfs-packed-exports-"))

  const manifest = {
    name: "@test/package",
    exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } }
  }

  try {
    await mkdir(path.join(directory, "dist"))
    await writeFile(path.join(directory, "dist/index.d.ts"), "export declare const value: number")
    await assert.rejects(validatePackedExports(directory, manifest), /packed import target is missing/)
    await writeFile(path.join(directory, "dist/index.js"), "export const value = 1")
    await validatePackedExports(directory, manifest)
    manifest.exports["."].types = "./dist/../../outside.d.ts"
    manifest.exports["."].import = "./dist/../../outside.js"
    await assert.rejects(validatePackedExports(directory, manifest), /unsupported public export/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
