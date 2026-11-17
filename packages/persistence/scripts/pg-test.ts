/* oxlint-disable effecttsgo/global-console, effecttsgo/node-builtin-import, effecttsgo/process-env -- Standalone test launcher checks its environment before synchronously delegating to Vitest and propagating its exit status. */
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

if (!process.env["VFS_PG_TEST_URL"]) {
  console.error("Set VFS_PG_TEST_URL to a disposable, migrated PostgreSQL database before running test:pg.")
  process.exit(1)
}

const result = spawnSync("bun", [
  "--bun",
  "run",
  "vitest",
  "run",
  "--config",
  "../../vitest.config.ts",
  "--project",
  "persistence",
  "PgLiveImageStore.test.ts"
], { cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: "inherit" })

if (result.error) throw result.error

process.exit(result.status ?? 1)
