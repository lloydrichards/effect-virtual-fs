// Native build I/O is outside timed callbacks and temporary artifacts are removed on failure.
/* oxlint-disable effecttsgo/async-function, effecttsgo/node-builtin-import, effecttsgo/new-promise */
import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { cpus, platform, release, tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type * as VirtualFileSystem from "../dist/VirtualFileSystem.js"
import type { ConfinementControls } from "./config.ts"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

async function command(args: readonly [string, ...Array<string>], cwd = repo) {
  const child = spawn(args[0], args.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] })
  const outputChunks: Array<Buffer> = []
  const errorChunks: Array<Buffer> = []
  child.stdout.on("data", (chunk) => outputChunks.push(chunk))
  child.stderr.on("data", (chunk) => errorChunks.push(chunk))

  const status = await new Promise((resolve, reject) => {
    child.on("error", reject)
    child.on("close", resolve)
  })

  const output = Buffer.concat(outputChunks)
  const error = Buffer.concat(errorChunks).toString()

  assert.equal(status, 0, `${args.join(" ")}: ${error}`)

  return Buffer.from(output)
}

async function loadCore(
  temp: string,
  label: string,
  sourceTreeHashes: Record<string, string>,
  sourceBundleHashes: Record<string, string>
) {
  const source = resolve(temp, label, "packages/core/src")
  const hash = createHash("sha256")

  for (
    const path of (await readdir(source, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile()).map((entry) => resolve(entry.parentPath, entry.name)).sort()
  ) {
    hash.update(path.slice(source.length + 1)).update("\0").update(await readFile(path)).update("\0")
  }

  sourceTreeHashes[label] = hash.digest("hex")

  const output = resolve(temp, label, "bundle/core.mjs")
  await command([
    "bun",
    "build",
    resolve(temp, label, "packages/core/src/VirtualFileSystem.ts"),
    "--outfile",
    output,
    "--target",
    process.versions["bun"] ? "bun" : "node",
    "--external",
    "effect",
    "--external",
    "effect/*"
  ])
  sourceBundleHashes[label] = createHash("sha256").update(await readFile(output)).digest("hex")

  // SAFETY: These isolated bundles come from core VirtualFileSystem sources. The
  // harness uses only fromFixture and checks operation results on both revisions.
  return import(/* @vite-ignore */ pathToFileURL(output).href) as Promise<Pick<typeof VirtualFileSystem, "fromFixture">>
}

export async function prepareSources(controls: ConfinementControls) {
  const temp = await mkdtemp(resolve(tmpdir(), "production-confinement-"))

  try {
    const baselineRef = (await command(["git", "rev-parse", controls.baseline])).toString().trim()
    await symlink(resolve(repo, "node_modules"), resolve(temp, "node_modules"), "dir")
    await mkdir(resolve(temp, "baseline"))
    await writeFile(resolve(temp, "baseline.tar"), await command(["git", "archive", baselineRef, "packages/core/src"]))
    await command(["tar", "-xf", resolve(temp, "baseline.tar"), "-C", resolve(temp, "baseline")])

    if (controls.baselinePatch !== undefined) {
      await command(["git", "apply", resolve(repo, controls.baselinePatch)], resolve(temp, "baseline"))
    }

    await cp(resolve(repo, "packages/core/src"), resolve(temp, "current/packages/core/src"), { recursive: true })
    const sourceTreeHashes: Record<string, string> = {}
    const sourceBundleHashes: Record<string, string> = {}
    const baseline = await loadCore(temp, "baseline", sourceTreeHashes, sourceBundleHashes)
    const current = await loadCore(temp, "current", sourceTreeHashes, sourceBundleHashes)

    return {
      baseline,
      current,
      metadata: {
        baseline: baselineRef,
        baselinePatch: controls.baselinePatch,
        sourceTreeHashes,
        sourceBundleHashes,
        runtime: process.versions["bun"] ? `Bun ${process.versions["bun"]}` : `Node ${process.versions.node}`,
        platform: platform(),
        osRelease: release(),
        cpu: cpus()[0]?.model
      },
      close: () => rm(temp, { recursive: true, force: true })
    }
  } catch (error) {
    await rm(temp, { recursive: true, force: true })
    throw error
  }
}

export async function writeReport(output: string, contents: string) {
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, contents)
}
