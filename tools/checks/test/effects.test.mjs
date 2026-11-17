import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import compiler from "../../../packages/config-typescript/base.json" with { type: "json" }
import { root } from "../repository.mjs"

test("should retain correctness errors and outside warnings when the preview boundary is excepted", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vfs-effect-policy-"))
  const workspace = path.join(directory, "packages/core")

  try {
    await mkdir(path.join(workspace, "src/internal"), { recursive: true })
    const require = createRequire(path.join(root, "packages/core/package.json"))
    const effect = path.dirname(require.resolve("effect/package.json"))
    await mkdir(path.join(workspace, "node_modules"))
    await symlink(effect, path.join(workspace, "node_modules/effect"), "dir")
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "@test/effect-policy", type: "module" })
    )
    await writeFile(
      path.join(workspace, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, module: "Preserve", moduleResolution: "Bundler", target: "ES2022", types: [] },
        include: ["src/**/*.ts"]
      })
    )
    await writeFile(
      path.join(workspace, "src/experimental.ts"),
      "/** @stability experimental */\nexport const value = 1\n"
    )
    await writeFile(
      path.join(workspace, "src/Consumer.ts"),
      `
import * as Effect from "effect/Effect"
import { value } from "./experimental.js"
export const outside = Effect.succeed(value)
`
    )
    await writeFile(
      path.join(workspace, "src/internal/runtime.ts"),
      `
import * as Effect from "effect/Effect"
import { value } from "../experimental.js"
export const inside = (n: number) => Effect.gen(function*() { return n + value })
`
    )

    const options = { ...compiler.compilerOptions.plugins[0], diagnostics: true }
    delete options.name

    const child = Bun.spawn([
      "bun",
      path.join(root, "node_modules/@effect/tsgo/dist/effect-tsgo.cjs"),
      "diagnostics",
      "--project",
      path.join(workspace, "tsconfig.json"),
      "--format",
      "json",
      "--lspconfig",
      JSON.stringify(options)
    ], { cwd: root, stdout: "pipe", stderr: "pipe" })

    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ])

    expect(stderr).toBe("")
    expect(status).toBe(1)
    const { diagnostics } = JSON.parse(stdout)
    expect(diagnostics.some((d) => d.name === "experimentalApiUsage" && d.file.endsWith("/Consumer.ts"))).toBe(true)
    expect(diagnostics.some((d) => d.name === "experimentalApiUsage" && d.file.endsWith("/internal/runtime.ts"))).toBe(
      false
    )
    expect(diagnostics.some((d) =>
      d.name === "effectFnOpportunity" && d.severity === "error" &&
      d.file.endsWith("/internal/runtime.ts")
    )).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
