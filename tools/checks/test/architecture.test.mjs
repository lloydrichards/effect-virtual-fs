import { strict as assert } from "node:assert"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { checkBoundaries, cycles, forbiddenImport, imports } from "../boundaries.mjs"

const workspace = (name, allowedDependencies = []) => ({ manifest: { name }, policy: { allowedDependencies } })

await test("should omit runtime edges when imports and reexports are type-only", () => {
  assert.deepEqual(
    imports(`
    import type * as A from "./a.js"
    export type { C } from "./c.js"
    type E = import("./e.js").E
  `),
    ["./a.js", "./c.js", "./e.js"].map((specifier) => ({ specifier, runtime: false }))
  )
})

await test("should retain runtime edges when modules are loaded for execution", () => {
  const actual = imports(`
    import { type A } from "./inline-import.js"
    export { type B } from "./inline-export.js"
    import "./side.js"
    import Default, { type A } from "./default.js"
    import { value, type B } from "./mixed.js"
    export { value, type C } from "./export.js"
    import("./dynamic.js")
    require("./require.js")
  `)

  assert.equal(actual.length, 8)
  assert(actual.every((entry) => entry.runtime))
})

await test("should report cycles when a dependency returns to an active module", () => {
  const graph = new Map([["a", ["shared", "b"]], ["b", ["shared"]], ["shared", []]])
  assert.deepEqual(cycles(graph), [])
  graph.set("b", ["a"])
  assert.deepEqual(cycles(graph), [["a", "b", "a"]])
})

await test("should reject adapter coupling when imports bypass the package direction", () => {
  const memory = workspace("@effect-vfs/memory", ["@effect-vfs/core"])
  const core = workspace("@effect-vfs/core", ["@effect-vfs/effect-preview"])
  assert.equal(forbiddenImport(memory, core, "@effect-vfs/core/Caller"), undefined)
  assert.match(forbiddenImport(memory, workspace("@effect-vfs/node"), "@effect-vfs/node"), /may not depend/)
  assert.match(forbiddenImport(memory, core, "@effect-vfs/core/internal/model"), /internal imports/)
  assert.match(forbiddenImport(memory, core, "../../core/src/Caller.js"), /relative imports/)
})

await test("should allow private preview integration when the importer is core", () => {
  const preview = workspace("@effect-vfs/effect-preview")
  assert.equal(
    forbiddenImport(
      workspace("@effect-vfs/core", [preview.manifest.name]),
      preview,
      "@effect-vfs/effect-preview/internal/durableStorage"
    ),
    undefined
  )
  assert.match(
    forbiddenImport(
      workspace("@effect-vfs/memory", [preview.manifest.name]),
      preview,
      "@effect-vfs/effect-preview/internal/durableStorage"
    ),
    /internal imports/
  )
})

await test("should reject engine imports when they require host services or private exports", () => {
  const core = workspace("@effect-vfs/core")

  for (const specifier of ["node:fs", "bun:sqlite", "@effect/platform-node/NodeFileSystem"]) {
    assert.match(forbiddenImport(core, undefined, specifier), /runtime neutral/)
  }

  assert.match(forbiddenImport(core, undefined, "effect/internal/core"), /supported package exports/)
  assert.equal(forbiddenImport(core, undefined, "effect/Effect"), undefined)
})

await test("should enforce Node builtin restrictions in the complete source graph", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vfs-builtin-boundaries-"))
  const engines = ["core", "effect-preview"]
  const names = [...engines, "node", "tools"]

  const entries = names.map((name) => ({
    ...workspace(`@effect-vfs/${name}`),
    directory: `packages/${name}`
  }))

  const builtins = ["fs", "fs/promises", "child_process", "node:fs"]
  const builtinImports = builtins.map((specifier) => `import "${specifier}"`).join("\n")

  try {
    for (const name of names) {
      const source = path.join(directory, `packages/${name}/src`)
      await mkdir(source, { recursive: true })
      await writeFile(
        path.join(source, "index.ts"),
        engines.includes(name) ? "import \"effect/Effect\"" : builtinImports
      )
    }

    const options = { directory, workspaces: entries, quiet: true }
    assert.deepEqual(await checkBoundaries(options), { modules: 4, workspaces: 4 })

    for (const name of engines) {
      await writeFile(path.join(directory, `packages/${name}/src/index.ts`), builtinImports)
    }

    await assert.rejects(checkBoundaries(options), (error) => {
      const diagnostics = error.message.split("\n").map((line) =>
        `${line.slice(0, line.indexOf(": "))} ${line.slice(line.lastIndexOf(": ") + 2)}`
      )

      const expected = engines.flatMap((name) =>
        builtins.map((specifier) => `packages/${name}/src/index.ts ${specifier}`)
      )

      assert.equal(diagnostics.length, expected.length)
      assert.deepEqual(new Set(diagnostics), new Set(expected))

      return true
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test("should enforce package boundaries when the complete source graph is checked", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vfs-boundary-test-"))

  const entries = ["a", "b"].map((name) => ({
    ...workspace(`@test/${name}`, ["@test/a", "@test/b"]),
    directory: `packages/${name}`,
    manifest: { name: `@test/${name}`, exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } } }
  }))

  try {
    for (const entry of entries) await mkdir(path.join(directory, entry.directory, "src"), { recursive: true })
    const a = path.join(directory, "packages/a/src/index.ts")
    const b = path.join(directory, "packages/b/src/index.ts")
    await writeFile(a, "import type { B } from \"@test/b\"; export const A = 1; export type T = B")
    await writeFile(b, "import { A } from \"@test/a\"; export type B = typeof A")
    assert.deepEqual(await checkBoundaries({ directory, workspaces: entries, quiet: true }), {
      modules: 2,
      workspaces: 2
    })
    await writeFile(a, "import { type B } from \"@test/b\"; export const A = 1; export type T = B")
    await assert.rejects(checkBoundaries({ directory, workspaces: entries, quiet: true }), /Runtime import cycle/)
    await writeFile(a, "export { type B } from \"@test/b\"; export const A = 1")
    await assert.rejects(checkBoundaries({ directory, workspaces: entries, quiet: true }), /Runtime import cycle/)
    await writeFile(a, "import { B } from \"@test/b\"; export const A = B")
    await assert.rejects(checkBoundaries({ directory, workspaces: entries, quiet: true }), /Runtime import cycle/)
    await writeFile(a, "import { B } from \"../../b/src/index.js\"; export const A = B")
    await writeFile(b, "export const B = 1")
    await assert.rejects(checkBoundaries({ directory, workspaces: entries, quiet: true }), /relative imports/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test("should detect application cycles when imports use TypeScript aliases", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vfs-app-boundaries-"))
  const application = { ...workspace("@test/docs"), directory: "apps/docs" }

  try {
    await mkdir(path.join(directory, application.directory, "app"), { recursive: true })
    await writeFile(
      path.join(directory, application.directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "~/*": ["app/*"] } }
      })
    )
    await writeFile(
      path.join(directory, application.directory, "app/index.ts"),
      "import { x } from \"~/shared\"; export const y = x"
    )
    await writeFile(
      path.join(directory, application.directory, "app/shared.ts"),
      "import { y } from \"./index\"; export const x = y"
    )
    await assert.rejects(checkBoundaries({ directory, workspaces: [application], quiet: true }), /Runtime import cycle/)
    await writeFile(path.join(directory, application.directory, "app/shared.ts"), "export const x = 1")
    assert.deepEqual(await checkBoundaries({ directory, workspaces: [application], quiet: true }), {
      modules: 2,
      workspaces: 1
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
