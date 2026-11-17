import { root } from "./repository.mjs"

// CI and local validation share this order. Build declarations before type-aware checks.
const phases = [
  { name: "Repository checks", command: ["bun", "run", "check"] },
  { name: "Build", command: ["bun", "run", "build"] },
  { name: "Lint", command: ["bun", "run", "lint"] },
  { name: "Effect diagnostics", command: ["bun", "run", "lint:effects"] },
  { name: "Types", command: ["bun", "run", "type-check"] },
  { name: "Tests", command: ["bun", "run", "test"] },
  { name: "Documentation", command: ["bun", "run", "docs:check"] },
  { name: "Published consumers", command: ["bun", "tools/checks/consumers.mjs"] }
]

const args = process.argv.slice(2)

if (args.length > 0 && (args.length !== 1 || args[0] !== "--list")) {
  throw new Error("Usage: bun run validate [--list]")
}

for (const { name, command } of phases) {
  console.log(`${name}: ${command.join(" ")}`)

  if (args[0] === "--list") continue

  const child = Bun.spawn(command, { cwd: root, stdout: "inherit", stderr: "inherit" })
  const status = await child.exited

  if (status !== 0) process.exit(status)
}

console.log("Generated API: verify committed reference is unchanged")

if (args[0] !== "--list") {
  const result = Bun.spawnSync(["git", "status", "--porcelain", "--", "apps/docs/app/content/api"], { cwd: root })

  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || "Could not check generated API reference")

  if (result.stdout.toString().trim() !== "") {
    throw new Error("API reference changed. Review and commit the output of bun run docs:check.")
  }
}
