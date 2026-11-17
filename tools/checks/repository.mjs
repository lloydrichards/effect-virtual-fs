import { access, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const root = fileURLToPath(new URL("../../", import.meta.url))

const config = "@repo/config-typescript"

const core = "@effect-vfs/core"

const preview = "@effect-vfs/effect-preview"

const memory = "@effect-vfs/memory"

const persistence = "@effect-vfs/persistence"

const nfs = "@effect-vfs/nfs"

const node = "@effect-vfs/node"

const library = (runtime, allowedDependencies) => ({
  kind: "library",
  runtime,
  effects: true,
  documentation: "public",
  allowedDependencies: [...allowedDependencies, config]
})

const application = (runtime, allowedDependencies) => ({
  kind: "application",
  runtime,
  effects: true,
  documentation: { reason: "Application entrypoints are not published library APIs." },
  allowedDependencies: [...allowedDependencies, config]
})

// Manifests discover packages and exports. This registry records only policy choices.
export const policies = {
  "packages/config-typescript": {
    kind: "configuration",
    runtime: "none",
    effects: { reason: "JSON compiler configuration has no Effect implementation." },
    documentation: { reason: "Compiler presets are configuration exports, not TypeScript APIs." },
    allowedDependencies: []
  },
  "packages/effect-preview": {
    kind: "generated",
    runtime: "mixed",
    effects: { reason: "Pinned upstream output is checked by sync, type, consumer and runtime suites." },
    documentation: { reason: "Private generated upstream snapshot; downstream public modules own documentation." },
    allowedDependencies: [config]
  },
  "packages/core": library("mixed", [preview]),
  "packages/memory": library("mixed", [core]),
  "packages/node": library("node", [core]),
  "packages/nfs": library("mixed", [core]),
  "packages/persistence": library("mixed", [core]),
  "apps/demo-agent-tools": application("bun", [core]),
  "apps/demo-alchemy": application("bun", [core, persistence]),
  "apps/demo-overlay": application("bun", [core]),
  "apps/demo-r2-nfs": application("bun", [core, nfs, persistence]),
  "apps/demo-typescript-workbench": application("node", [core, node]),
  "apps/docs": application("mixed", [core, memory, persistence]),
  "apps/nfs-preview": application("bun", [core, nfs]),
  "apps/scratchpad": application("bun", [core, memory, persistence]),
  "apps/virtual-build": application("bun", [core, memory])
}

export async function discoverWorkspaces(directory = root, registry = policies) {
  const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"))
  const found = new Set()

  for (const pattern of manifest.workspaces) {
    for await (const file of new Bun.Glob(`${pattern}/package.json`).scan({ cwd: directory })) {
      found.add(path.posix.dirname(file))
    }
  }

  return Promise.all(
    [...found].sort((a, b) => a.localeCompare(b)).map(async (workspace) => ({
      directory: workspace,
      manifest: JSON.parse(await readFile(path.join(directory, workspace, "package.json"), "utf8")),
      policy: registry[workspace]
    }))
  )
}

export function publicEntries(workspace) {
  const entries = workspace.manifest.exports

  if (entries === undefined) return []

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Reject unsupported manifest encodings rather than silently skipping public APIs.
  if (entries === null || typeof entries !== "object" || Array.isArray(entries)) {
    throw new Error(`${workspace.directory}: unsupported exports map; use explicit typed subpaths`)
  }

  return Object.entries(entries).flatMap(([subpath, target]) => {
    if (target === null) return []

    if (subpath === "./package.json" && target === "./package.json") return []

    const unsupported = () =>
      new Error(
        `${workspace.directory}: unsupported public export ${subpath}; use dist declarations and a matching import target`
      )

    // oxlint-disable anti-slop/no-runtime-typeof -- Public TS entries must have the supported declaration/import condition pair.
    if (
      typeof target !== "object" || Array.isArray(target) || typeof target.types !== "string" ||
      typeof target.import !== "string"
    ) {
      throw unsupported()
    }
    // oxlint-enable anti-slop/no-runtime-typeof

    if (
      (subpath !== "." && !subpath.startsWith("./")) || subpath.includes("*") ||
      !target.types.startsWith("./dist/") || !target.types.endsWith(".d.ts") ||
      target.types !== `./${path.posix.normalize(target.types)}` || target.types.includes("\\") ||
      target.types.slice("./dist/".length).split("/").some((part) => part === "." || part === "..") ||
      target.import !== target.types.replace(/\.d\.ts$/, ".js") ||
      Object.keys(target).some((condition) => condition !== "types" && condition !== "import")
    ) throw unsupported()

    return [{
      subpath,
      source: path.posix.join(
        workspace.directory,
        target.types.replace(/^\.\/dist\//, "src/").replace(/\.d\.ts$/, ".ts")
      )
    }]
  })
}

export async function validateInventory(workspaces, directory = root, registry = policies) {
  workspaces ??= await discoverWorkspaces(directory, registry)
  const errors = []
  const directories = new Set(workspaces.map((workspace) => workspace.directory))
  const names = new Set(workspaces.map((workspace) => workspace.manifest.name))

  if (names.size !== workspaces.length) errors.push("Workspace package names must be unique.")

  for (const stale of Object.keys(registry).filter((key) => !directories.has(key))) {
    errors.push(`Policy refers to missing workspace ${stale}`)
  }

  for (const workspace of workspaces) {
    const { manifest, policy } = workspace
    const prefix = workspace.directory

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- A manifest without a package name cannot participate in dependency validation.
    if (typeof manifest.name !== "string" || manifest.name.trim().length === 0) {
      errors.push(`${prefix}: missing workspace package name`)
    }

    if (!policy) {
      errors.push(`${prefix}: missing repository validation policy`)
      continue
    }

    if (!["library", "application", "generated", "configuration"].includes(policy.kind)) {
      errors.push(`${prefix}: invalid package kind`)
    }

    if (!["mixed", "bun", "node", "browser", "none"].includes(policy.runtime)) {
      errors.push(`${prefix}: invalid runtime policy`)
    }

    for (const [field, enabled] of [["effects", true], ["documentation", "public"]]) {
      if (policy[field] !== enabled && !policy[field]?.reason?.trim()) {
        errors.push(`${prefix}: ${field} needs an explicit policy or exclusion reason`)
      }
    }

    if (manifest.private !== true && policy.kind !== "library") {
      errors.push(`${prefix}: published package must have library policy`)
    }

    if (!Array.isArray(policy.allowedDependencies)) {
      errors.push(`${prefix}: missing dependency policy`)
      continue
    }

    for (const dependency of policy.allowedDependencies) {
      if (!names.has(dependency)) errors.push(`${prefix}: policy names unknown workspace ${dependency}`)
    }

    for (
      const dependency of Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies
      })
    ) {
      if (names.has(dependency) && !policy.allowedDependencies.includes(dependency)) {
        errors.push(`${prefix}: dependency on ${dependency} violates package direction`)
      }
    }

    if (policy.effects === true) {
      try {
        await access(path.join(directory, prefix, "tsconfig.json"))
      } catch {
        errors.push(`${prefix}: Effect diagnostics require tsconfig.json`)
      }
    }

    if (policy.kind !== "library") continue

    if (policy.documentation !== "public") errors.push(`${prefix}: published libraries require public documentation`)

    if (publicEntries(workspace).length === 0) errors.push(`${prefix}: published library has no typed public exports`)

    for (const entry of publicEntries(workspace)) {
      try {
        await access(path.join(directory, entry.source))
      } catch {
        errors.push(`${prefix}: ${entry.subpath} has no source ${entry.source}`)
      }
    }
  }

  if (errors.length > 0) throw new Error(errors.join("\n"))

  return [...workspaces]
}

if (import.meta.main) {
  const workspaces = await validateInventory()
  const published = workspaces.filter((workspace) => workspace.policy.kind === "library")
  console.log(
    `Repository policy covers ${workspaces.length} workspaces and ${
      published.reduce((sum, workspace) => sum + publicEntries(workspace).length, 0)
    } public entrypoints.`
  )
}
