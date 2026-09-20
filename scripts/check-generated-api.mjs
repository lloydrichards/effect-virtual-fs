const result = Bun.spawnSync(["git", "status", "--porcelain", "--", "apps/docs/app/content/api"])

if (result.exitCode !== 0) {
  throw new Error(result.stderr.toString() || "Could not check generated API reference")
}

if (result.stdout.toString().trim() !== "") {
  throw new Error("API reference is stale. Run 'bun run docs:check' and commit the result.")
}
