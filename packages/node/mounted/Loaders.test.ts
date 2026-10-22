// Loader state and routing comparisons run in isolated native processes.
/* eslint-disable effecttsgo/node-builtin-import */
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

it.each(["cjs", "esm", "routing"])(
  "should qualify %s against the built package in an isolated process",
  (kind) => {
    const output = execFileSync(process.execPath, [
      "--experimental-vfs",
      fileURLToPath(new URL("./loader-case.mjs", import.meta.url)),
      kind
    ], { encoding: "utf8", timeout: 15000 })

    expect(JSON.parse(output)).toMatchObject({ kind, node: "v26.11.1", result: "passed" })
  }
)
