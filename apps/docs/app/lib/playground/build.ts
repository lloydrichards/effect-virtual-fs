import { build, initialize } from "esbuild-wasm"
import wasmURL from "esbuild-wasm/esbuild.wasm?url"
import type { Workspace } from "./volume"

let ready: Promise<void> | undefined

export async function buildWorkspace(workspace: Workspace) {
  ready ??= initialize({ wasmURL }).catch((error) => {
    ready = undefined
    throw error
  })
  await ready
  const reads = new Set<string>()

  const result = await build({
    entryPoints: ["/main.js"],
    format: "esm",
    bundle: true,
    write: false,
    minifySyntax: true,
    logLevel: "silent",
    plugins: [{
      name: "effect-vfs",
      setup(plugin) {
        plugin.onResolve({ filter: /.*/ }, async ({ path, importer }) => {
          if (!path.startsWith("/") && !path.startsWith("./") && !path.startsWith("../")) {
            return { errors: [{ text: `Use a relative or absolute virtual file path for ${path}` }] }
          }

          const directory = importer.slice(0, importer.lastIndexOf("/") + 1)

          return { namespace: "vfs", path: await workspace.resolve(path.startsWith("/") ? path : directory + path) }
        })
        plugin.onLoad({ filter: /.*/, namespace: "vfs" }, async ({ path }) => {
          const contents = await workspace.read(path)
          reads.add(path)

          return { contents, loader: "js" }
        })
      }
    }]
  })

  return { code: result.outputFiles[0]!.text, reads: [...reads] }
}
