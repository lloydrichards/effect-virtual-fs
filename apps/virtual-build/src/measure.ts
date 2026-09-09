import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Effect, Schema } from "effect"
// External measurement reads host files directly; core itself has no host filesystem dependency.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import * as Fs from "node:fs/promises"
// oxlint-disable-next-line effecttsgo/node-builtin-import
import * as Path from "node:path"
import { fileURLToPath } from "node:url"

// External benchmark input preparation, not a host-tree API in core or a build source fallback.
const preparationStarted = performance.now()
const beforePreparationRssBytes = process.memoryUsage().rss
const packages: Array<{ name: string; version: string }> = []
const entries: Array<Vfs.Fixture["entries"][number]> = [{ kind: "directory", path: "/node_modules" }]
let sourceBytes = 0
let files = 0
for (const name of ["effect", "vite", "rolldown"]) {
  const root = Path.dirname(fileURLToPath(import.meta.resolve(`${name}/package.json`)))
  const manifest = Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ version: Schema.String })))(
    await Fs.readFile(Path.join(root, "package.json"), "utf8")
  )
  packages.push({ name, version: manifest.version })
  const pending = [{ host: root, virtual: `/node_modules/${name}` }]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) break
    entries.push({ kind: "directory", path: directory.virtual })
    const children = await Fs.readdir(directory.host, { withFileTypes: true })
    children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const item of children) {
      if (item.name === "node_modules") continue
      const host = Path.join(directory.host, item.name)
      const path = `${directory.virtual}/${item.name}`
      if (item.isDirectory()) pending.push({ host, virtual: path })
      else if (item.isFile()) {
        const bytes = await Fs.readFile(host)
        sourceBytes += bytes.length
        files++
        entries.push({ kind: "file", path, bytes })
      }
    }
  }
}
const timings: Record<string, number> = { preparationMs: Number((performance.now() - preparationStarted).toFixed(2)) }
const measure = Effect.fnUntraced(function*<A, E>(name: string, effect: Effect.Effect<A, E>) {
  const start = performance.now()
  const value = yield* effect
  timings[name] = Number((performance.now() - start).toFixed(2))
  return value
})
const result = await Effect.runPromise(Effect.gen(function*() {
  const volume = yield* measure("fixtureMs", Vfs.fromFixture({ entries }))
  const snapshot = yield* measure("captureMs", volume.snapshot)
  const encoded = yield* measure("encodeMs", Vfs.encodeSnapshot(snapshot))
  const decoded = yield* measure(
    "decodeMs",
    Vfs.decodeSnapshot(encoded, {
      maxEncodedBytes: encoded.length,
      maxRecords: entries.length + 1,
      maxEntries: entries.length,
      maxDecodedBytes: sourceBytes + entries.length * 512
    })
  )
  const restored = yield* measure("restoreMs", Vfs.fromSnapshot(decoded))
  const caller = yield* restored.caller()
  const metadata = yield* caller.stat("/node_modules/vite/package.json")
  return {
    packages,
    workload: "Selected installed package trees; nested node_modules and nonregular entries excluded",
    files,
    entries: entries.length,
    sourceBytes,
    encodedBytes: encoded.length,
    encodedToSourceRatio: Number((encoded.length / sourceBytes).toFixed(3)),
    restoredManifestBytes: Number(metadata.size),
    timings,
    memory: {
      beforePreparationRssBytes,
      afterRestorationRssBytes: process.memoryUsage().rss,
      peakRssBytes: process.versions["bun"] === undefined ? process.resourceUsage().maxRSS * 1024 : null,
      peakSource: process.versions["bun"] === undefined
        ? "Node process.resourceUsage().maxRSS (KiB) multiplied by 1024"
        : "Unavailable: run with Node for the verified peak RSS metric",
      peakScope: "Process lifetime through restoration, including imports, host fixture preparation and all phases",
      collection: "No forced garbage collection; fixture input and pipeline values coexist as runtime liveness permits"
    },
    runtime: process.versions["bun"] === undefined ? `Node ${process.version}` : `Bun ${process.versions["bun"]}`,
    platform: `${process.platform}-${process.arch}`
  }
}))
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
