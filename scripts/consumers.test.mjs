import { strict as assert } from "node:assert"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { validatePackedExports } from "./check-consumers.mjs"

await test("a declaration alone does not prove that the runtime export was packed", async () => {
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
