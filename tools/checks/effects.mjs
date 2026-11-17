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

  // These diagnostics are not all applied by Oxlint in the pinned TSGo version.
  const options = {
    diagnostics: true,
    effectFn: ["untraced"],
    diagnosticSeverity: {
      effectFnOpportunity: "error",
      lazyEffect: "error",
      allOfMapToForEach: "error"
    }
  }

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
