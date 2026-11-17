import { spawnSync } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { discoverWorkspaces, publicEntries } from "./repository.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))

/** Both halves of a published entrypoint must be present in the actual archive. */
export async function validatePackedExports(directory, manifest) {
  for (const { subpath } of publicEntries({ directory, manifest })) {
    const target = manifest.exports[subpath]

    for (const field of ["types", "import"]) {
      const destination = path.resolve(directory, target[field])

      if (!destination || !destination.startsWith(`${directory}${path.sep}`)) {
        throw new Error(`${manifest.name}${subpath}: ${field} must name a file in the package`)
      }

      await access(destination).catch(() => {
        throw new Error(`${manifest.name}${subpath}: packed ${field} target is missing: ${target[field]}`)
      })
    }
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options })

  if (result.error) throw result.error

  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`)

  return result.stdout
}

async function dependencyRoot(workspace, name) {
  const require = createRequire(path.join(root, workspace.directory, "package.json"))

  try {
    return path.dirname(require.resolve(`${name}/package.json`))
  } catch {
    let directory = path.dirname(require.resolve(name))

    while (directory !== path.dirname(directory)) {
      try {
        if (JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")).name === name) return directory
      } catch (error) {
        if (error.code !== "ENOENT") throw error
      }

      directory = path.dirname(directory)
    }

    throw new Error(`Could not locate declared dependency ${name} for ${workspace.manifest.name}`)
  }
}

/** Compile every published entrypoint from packed output, without workspace source resolution. */
export async function checkConsumers() {
  const workspaces = await discoverWorkspaces()
  const published = workspaces.filter((workspace) => !workspace.manifest.private && publicEntries(workspace).length > 0)
  const byName = new Map(workspaces.map((workspace) => [workspace.manifest.name, workspace]))
  const temporary = await mkdtemp(path.join(tmpdir(), "effect-vfs-consumers-"))

  try {
    const archives = new Map()

    for (const workspace of published) {
      const archive = path.join(temporary, `${workspace.manifest.name.replaceAll("/", "-")}.tgz`)
      run("bun", ["pm", "pack", "--filename", archive, "--quiet"], { cwd: path.join(root, workspace.directory) })
      archives.set(workspace.manifest.name, archive)
    }

    const classic = createRequire(new URL("../../packages/effect-preview/package.json", import.meta.url))

    const compilers = [
      {
        version: JSON.parse(await readFile(classic.resolve("typescript-js/package.json"), "utf8")).version,
        binary: classic.resolve("typescript-js/bin/tsc")
      },
      {
        version: JSON.parse(await readFile(path.join(root, "node_modules/typescript/package.json"), "utf8")).version,
        binary: path.join(root, "node_modules/typescript/bin/tsc")
      }
    ]

    const plans = published.map((workspace) => ({ workspace, sdkFree: false }))
    const persistence = published.find(({ manifest }) => manifest.name === "@effect-vfs/persistence")

    if (persistence) plans.push({ workspace: persistence, sdkFree: true })

    for (const { workspace, sdkFree } of plans) {
      const name = workspace.manifest.name.replaceAll("/", "-")
      const consumer = path.join(temporary, sdkFree ? name + "-r2-store" : name)
      const modules = path.join(consumer, "node_modules")
      const staged = new Set()

      const stage = async (current) => {
        if (staged.has(current.manifest.name)) return
        staged.add(current.manifest.name)
        const destination = path.join(modules, current.manifest.name)
        await mkdir(destination, { recursive: true })
        const archive = archives.get(current.manifest.name)

        if (!archive) {
          throw new Error(`Published ${workspace.manifest.name} depends on private workspace ${current.manifest.name}`)
        }

        run("tar", ["-xzf", archive, "--strip-components=1", "-C", destination])
        await validatePackedExports(destination, current.manifest)
        const dependencies = { ...current.manifest.dependencies, ...current.manifest.peerDependencies }

        for (const name of Object.keys(dependencies)) {
          if (sdkFree && current === workspace && name !== "effect" && !byName.has(name)) continue

          if (byName.has(name)) await stage(byName.get(name))
          else {
            const target = path.join(modules, name)
            await mkdir(path.dirname(target), { recursive: true })
            await symlink(await realpath(await dependencyRoot(current, name)), target, "dir").catch((error) => {
              if (error.code !== "EEXIST") throw error
            })
          }
        }
      }

      await stage(workspace)
      // The native provider and persistence's public AWS client types require
      // Node types. Neutral packages must resolve without ambient Node types.
      const native = !sdkFree && ["@effect-vfs/node", "@effect-vfs/persistence"].includes(workspace.manifest.name)

      if (native) {
        const destination = path.join(modules, "@types/node")
        await mkdir(path.dirname(destination), { recursive: true })
        await symlink(await realpath(await dependencyRoot(workspace, "@types/node")), destination, "dir")
      }

      await writeFile(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }))
      const entries = publicEntries(workspace).filter((entry) => !sdkFree || entry.subpath === "./R2Store")

      const source = entries.map((entry, index) => {
        const specifier = workspace.manifest.name + (entry.subpath === "." ? "" : entry.subpath.slice(1))

        return `export * as Module${index} from ${JSON.stringify(specifier)}`
      }).join("\n")

      await writeFile(path.join(consumer, "index.ts"), `${source}\n`)
      const contracts = []

      const fixtures = sdkFree
        ? ["compatibility/node-next/r2-store.ts"]
        : ["compatibility/node-next/index.ts", "compatibility/index.ts"]

      for (const relative of fixtures) {
        const content = await readFile(path.join(root, workspace.directory, relative), "utf8").catch((error) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })

        if (content === undefined) continue
        const filename = `contract-${contracts.length}.ts`
        await writeFile(path.join(consumer, filename), content)
        contracts.push(filename)
      }

      await writeFile(
        path.join(consumer, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2023",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true,
            skipLibCheck: false,
            types: native ? ["node"] : [],
            lib: ["ES2023", "DOM"],
            noEmit: true
          },
          files: ["index.ts", ...contracts]
        })
      )

      if (sdkFree) {
        run("node", [
          "--input-type=module",
          "--eval",
          "import assert from \"node:assert/strict\";" +
          "import { Client, layer } from \"@effect-vfs/persistence/R2Store\";" +
          "assert.ok(Client && typeof layer === \"function\");" +
          "await assert.rejects(import(\"@aws-sdk/client-s3\"), { code: \"ERR_MODULE_NOT_FOUND\" });"
        ], { cwd: consumer })
      }

      for (const compiler of compilers) {
        run(process.execPath, [compiler.binary, "--project", path.join(consumer, "tsconfig.json")], { cwd: consumer })
        console.log(
          `${workspace.manifest.name}${
            sdkFree ? "/R2Store (SDK-free)" : ""
          }: ${entries.length} packed entrypoints passed TypeScript ${compiler.version}.`
        )
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkConsumers()
