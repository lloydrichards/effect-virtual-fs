import compiler from "../../packages/config-typescript/base.json" with { type: "json" }
import { root, validateInventory } from "./repository.mjs"

const selected = process.argv.slice(2)

const workspaces = await validateInventory()

for (const requested of selected) {
  if (!workspaces.some((workspace) => workspace.directory === requested || workspace.manifest.name === requested)) {
    throw new Error(`Unknown Effect diagnostic workspace: ${requested}`)
  }
}

for (const workspace of workspaces) {
  if (selected.length > 0 && !selected.includes(workspace.directory) && !selected.includes(workspace.manifest.name)) {
    continue
  }

  if (workspace.policy.effects !== true) {
    console.log(`${workspace.directory}: ${workspace.policy.effects.reason}`)
    continue
  }

  // Oxlint and editors use the same policy. Only the dedicated pass enables diagnostics here.
  const options = { ...compiler.compilerOptions.plugins[0], diagnostics: true }
  delete options.name

  console.log(`Effect diagnostics: ${workspace.directory}`)

  const result = Bun.spawn([
    "bun",
    "run",
    "effect-tsgo",
    "diagnostics",
    "--project",
    `${workspace.directory}/tsconfig.json`,
    "--lspconfig",
    JSON.stringify(options)
  ], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit"
  })

  const status = await result.exited

  if (status !== 0) process.exit(status)
}
