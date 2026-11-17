// Snapshot updates read a user-supplied checkout; regeneration and CI never fetch a moving branch.
/* eslint-disable effecttsgo/node-builtin-import */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"

const args = process.argv.slice(2)

const [checkout, commit, base] = args

if (args.length !== 3 || !checkout || !/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(base)) {
  throw new Error("Usage: bun scripts/refresh.mjs /path/to/effect-checkout <head-sha> <base-sha>")
}

const git = (...args) =>
  execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })

for (const revision of [commit, base]) {
  if (git("rev-parse", "--verify", `${revision}^{commit}`).trim() !== revision) {
    throw new Error(`Unknown commit: ${revision}`)
  }
}

const snapshot = JSON.parse(await readFile(new URL("../upstream/files.json", import.meta.url), "utf8"))

// Import only this PR's filesystem and prerequisite families. A new upstream dependency needs review.
const selected =
  /^packages\/effect\/(?:src\/(?:virtual-file-system\/.*\.ts|(?:BytePath|Bytes|DateTime|Schema)\.ts)|test\/(?:virtual-file-system\/.*\.test\.ts|(?:BytePath|Bytes|DateTime\.UnixNano)\.test\.ts|schema\/(?:BytePath\.test\.ts|representation\/toCodeDocument\.test\.ts))|typetest\/(?:virtual-file-system\/.*\.tst\.ts|(?:BytePath|DateTime\.UnixNano)\.tst\.ts))$/

const paths = git("diff", "--name-only", base, commit, "--", "packages/effect").trim().split("\n").filter((path) =>
  selected.test(path)
).sort()

if (!paths.includes("packages/effect/src/virtual-file-system/VirtualFileSystem.ts")) {
  throw new Error("The selected range contains no filesystem port")
}

const files = paths.map((filename) => {
  const diff = git("diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", base, commit, "--", filename)
  const start = diff.indexOf("@@")

  if (start < 0) throw new Error(`No source patch: ${filename}`)

  return { filename, patch: diff.slice(start).trimEnd() }
})

const next = { ...snapshot, commit, base, files }

const manifest = {
  repository: next.repository,
  commit,
  base,
  pullRequest: next.pullRequest,
  files: Object.fromEntries(
    files.map((
      { filename, patch }
    ) => [filename.replace("packages/effect/", ""), createHash("sha256").update(patch).digest("hex")])
  )
}

const license = git("show", `${commit}:LICENSE`)

await writeFile(new URL("../upstream/files.json", import.meta.url), JSON.stringify(next, null, 2) + "\n")

await writeFile(new URL("../upstream/manifest.json", import.meta.url), JSON.stringify(manifest, null, 2) + "\n")

await writeFile(new URL("../LICENSE", import.meta.url), license)

process.stdout.write(
  `Saved ${files.length} upstream patches from ${commit}. Review the snapshot, then run sync and qualification.\n`
)
