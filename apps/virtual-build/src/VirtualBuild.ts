import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Data, Effect, Schema } from "effect"
import { build, type Plugin } from "vite"

export class BuildError extends Data.TaggedError("BuildError")<{ readonly cause: unknown }> {}
class VirtualModuleError extends Data.TaggedError("VirtualModuleError")<{ readonly message: string }> {}
const prefix = "\0effect-vfs:"
const PackageManifest = Schema.Struct({ type: Schema.Literal("module"), exports: Schema.String })

/** Bounded demonstration: explicit JS files and root node_modules packages with a string exports entry. */
export const buildVirtual = Effect.fn("VirtualBuild.build")(function*(caller: Vfs.Caller, entry: string) {
  const reads: Array<string> = []
  const source = Effect.fnUntraced(function*(path: string) {
    const bytes = yield* caller.readFile(path)
    reads.push(path)
    return yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      catch: () => new Vfs.FsError({ code: "InvalidPathEncoding", operation: "build", path })
    })
  })
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>())
  // Vite invokes these callbacks outside the Effect fiber; preserve its service context.
  const run = <A>(effect: Effect.Effect<A, Vfs.FsError>, path: string) =>
    runPromise(effect.pipe(
      Effect.mapError((error) => new VirtualModuleError({ message: `Virtual module ${path}: ${error.code}` }))
    ))
  const plugin: Plugin = {
    name: "effect-vfs-demonstration",
    enforce: "pre",
    resolveId(specifier, importer) {
      return runPromise(Effect.gen(function*() {
        let path: string
        if (specifier.startsWith("effect-vfs:")) path = specifier.slice("effect-vfs:".length)
        else if (importer?.startsWith(prefix)) {
          if (specifier.startsWith(".")) {
            const parent = importer.slice(prefix.length)
            path = `${parent.slice(0, parent.lastIndexOf("/") + 1)}${specifier}`
          } else if (specifier.startsWith("/")) path = specifier
          else {
            if (!/^(?:@[A-Za-z0-9_-]+\/)?[A-Za-z0-9_-]+$/.test(specifier)) {
              return yield* new VirtualModuleError({ message: `Unsupported virtual package specifier: ${specifier}` })
            }
            const manifestPath = `/node_modules/${specifier}/package.json`
            const json = yield* source(manifestPath)
            const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(PackageManifest))(json)
            if (
              !manifest.exports.startsWith("./") || manifest.exports.split("/").includes("..") ||
              !manifest.exports.endsWith(".js")
            ) return yield* new VirtualModuleError({ message: `Unsupported exports in ${manifestPath}` })
            path = `/node_modules/${specifier}/${manifest.exports.slice(2)}`
          }
        } else return null
        return prefix +
          (yield* caller.realPath(path).pipe(
            Effect.mapError((error) => new VirtualModuleError({ message: `Virtual module ${path}: ${error.code}` }))
          ))
      }))
    },
    load(id) {
      if (!id.startsWith(prefix)) return null
      const path = id.slice(prefix.length)
      return run(source(path), path)
    }
  }
  const result = yield* Effect.tryPromise({
    try: () =>
      build({
        configFile: false,
        envFile: false,
        publicDir: false,
        logLevel: "silent",
        plugins: [plugin],
        build: {
          write: false,
          minify: false,
          rolldownOptions: { input: `effect-vfs:${entry}` },
          lib: { entry: `effect-vfs:${entry}`, formats: ["es"], fileName: "virtual" }
        }
      }),
    catch: (cause) => new BuildError({ cause })
  })
  const outputs = Array.isArray(result) ? result : [result]
  const chunks = outputs.flatMap((output) =>
    "output" in output ? output.output.filter((chunk) => chunk.type === "chunk") : []
  )
  if (chunks.length !== 1 || chunks[0] === undefined) {
    return yield* new BuildError({ cause: "The bounded demo requires exactly one output chunk" })
  }
  return { code: chunks[0].code, reads }
})
const text = (value: string) => new TextEncoder().encode(value)
export const demoFixture: Vfs.Fixture = {
  entries: [
    { kind: "directory", path: "/__effect_vfs_demo__" },
    {
      kind: "file",
      path: "/__effect_vfs_demo__/main.js",
      bytes: text("import { value as dependency } from './value.js'; export const value = dependency + 22")
    },
    { kind: "file", path: "/__effect_vfs_demo__/value.js", bytes: text("export const value = 20") },
    { kind: "file", path: "/__effect_vfs_demo__/package.js", bytes: text("export { value } from 'only-in-vfs'") },
    { kind: "directory", path: "/node_modules" },
    { kind: "directory", path: "/node_modules/only-in-vfs" },
    {
      kind: "file",
      path: "/node_modules/only-in-vfs/package.json",
      bytes: text("{\"name\":\"only-in-vfs\",\"type\":\"module\",\"exports\":\"./index.js\"}")
    },
    { kind: "file", path: "/node_modules/only-in-vfs/index.js", bytes: text("export const value = 'virtual-package'") }
  ]
}
