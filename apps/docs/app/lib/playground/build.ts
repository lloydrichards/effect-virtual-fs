import { Effect, SynchronizedRef } from "effect"
import { build, initialize } from "esbuild-wasm"
import wasmURL from "esbuild-wasm/esbuild.wasm?url"
import { PlaygroundError } from "./error"
import type { FileAccess } from "./volume"

const initialized = SynchronizedRef.makeUnsafe(false)

const ensureInitialized = SynchronizedRef.updateEffect(
  initialized,
  (ready) =>
    ready ? Effect.succeed(true) : Effect.tryPromise({
      try: () => initialize({ wasmURL, worker: false }),
      catch: PlaygroundError.fromCause
    }).pipe(Effect.as(true))
).pipe(Effect.uninterruptible)

export const buildWorkspace = Effect.fnUntraced(function*(workspace: FileAccess) {
  yield* ensureInitialized
  const runPluginEffect = Effect.runPromiseWith(yield* Effect.context())
  const reads = new Set<string>()

  const result = yield* Effect.tryPromise({
    try: () =>
      build({
        entryPoints: ["/main.js"],
        format: "esm",
        bundle: true,
        write: false,
        minifySyntax: true,
        logLevel: "silent",
        plugins: [{
          name: "effect-vfs",
          setup(plugin) {
            plugin.onResolve({ filter: /.*/ }, ({ path, importer }) => {
              if (!path.startsWith("/") && !path.startsWith("./") && !path.startsWith("../")) {
                return { errors: [{ text: `Use a relative or absolute virtual file path for ${path}` }] }
              }

              const directory = importer.slice(0, importer.lastIndexOf("/") + 1)

              return runPluginEffect(
                workspace.resolve(path.startsWith("/") ? path : directory + path).pipe(
                  Effect.map((resolved) => ({ namespace: "vfs", path: resolved }))
                )
              )
            })
            plugin.onLoad({ filter: /.*/, namespace: "vfs" }, ({ path }) => {
              return runPluginEffect(
                workspace.read(path).pipe(Effect.map((contents) => {
                  reads.add(path)

                  return { contents, loader: "js" as const }
                }))
              )
            })
          }
        }]
      }),
    catch: PlaygroundError.fromCause
  })

  return { code: result.outputFiles[0]!.text, reads: [...reads] }
})
