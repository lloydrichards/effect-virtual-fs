// Qualification identifies the exact runtime and source candidate, not a broad support range.
/* eslint-disable effecttsgo/node-builtin-import */
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { release } from "node:os"
import { beforeAll, expect } from "vitest"

beforeAll(() => {
  expect(process.versions.node).toBe("26.11.1")
  process.stdout.write(
    JSON.stringify({
      node: process.version,
      os: process.platform,
      release: release(),
      arch: process.arch,
      effect: createRequire(import.meta.url)("effect/package.json").version,
      dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).length > 0,
      candidate: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    }) + "\n"
  )
})
