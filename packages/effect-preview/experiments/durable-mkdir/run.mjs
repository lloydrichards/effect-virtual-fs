// Exercise the built workspace packages with disposable on-disk images.
/* eslint-disable effecttsgo/node-builtin-import */
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const cwd = await mkdtemp(join(tmpdir(), "effect-vfs-durable-checks-"))

try {
  for (const script of ["check.mjs", "reopen.mjs", "cleanup.mjs"]) {
    execFileSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], { cwd, stdio: "inherit" })
  }
} finally {
  await rm(cwd, { recursive: true, force: true })
}
