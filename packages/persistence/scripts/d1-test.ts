/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/process-env -- Standalone launcher builds the Worker and runs workerd integration under Node with inherited environment. */
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("../", import.meta.url))

for (
  const [command, args] of [
    ["bun", ["build", "test/fixtures/d1-worker.ts", "--target=browser", "--outfile=.cache/d1/worker.js"]],
    ["node", [
      "../../node_modules/vitest/vitest.mjs",
      "run",
      "--config",
      "../../vitest.config.ts",
      "--project",
      "persistence",
      "D1LiveImageStore.test.ts"
    ]]
  ] as const
) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, VFS_D1_TEST: "1" } })

  if (result.error) throw result.error

  if (result.status !== 0) process.exit(result.status ?? 1)
}
