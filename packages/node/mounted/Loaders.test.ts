// Loader state and the optional internal descriptor audit run in isolated native processes.
/* eslint-disable effecttsgo/node-builtin-import */
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

it.each(["cjs", "esm", "registry", "routing"])(
  "should qualify %s against the built package in an isolated process",
  (kind) => {
    const flags = kind === "registry" ? ["--expose-internals"] : []

    const output = execFileSync(process.execPath, [
      "--experimental-vfs",
      ...flags,
      fileURLToPath(new URL("./loader-case.mjs", import.meta.url)),
      kind
    ], { encoding: "utf8", timeout: 15000 })

    expect(JSON.parse(output)).toMatchObject({ kind, node: "v26.11.1", result: "passed" })
  }
)
