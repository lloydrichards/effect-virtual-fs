import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Effect } from "effect"
// External measurement reads host files directly; core itself has no host filesystem dependency.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import * as Fs from "node:fs/promises"
// oxlint-disable-next-line effecttsgo/node-builtin-import
import * as Path from "node:path"
import { fileURLToPath } from "node:url"

// External benchmark input preparation, not a host-tree API in core or a build source fallback.
const entries: Array<Vfs.Fixture["entries"][number]> = [{ kind: "directory", path: "/node_modules" }]
let sourceBytes = 0
let files = 0
for (const name of ["effect", "vite", "rolldown"]) {
  const root = Path.dirname(fileURLToPath(import.meta.resolve(`${name}/package.json`)))
  const pending = [{ host: root, virtual: `/node_modules/${name}` }]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) break
    entries.push({ kind: "directory", path: directory.virtual })
    for (const item of await Fs.readdir(directory.host, { withFileTypes: true })) {
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
const timings: Record<string, number> = {}
const measure = <A, E>(name: string, effect: Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    const start = performance.now()
    const value = yield* effect
    timings[name] = Number((performance.now() - start).toFixed(2))
    return value
  })
const result = await Effect.runPromise(Effect.gen(function*() {
  const volume = yield* measure("fixtureMs", Vfs.fromFixture({ entries }))
  const snapshot = yield* measure("captureMs", volume.snapshot())
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
    packages: ["effect", "vite", "rolldown"],
    files,
    entries: entries.length,
    sourceBytes,
    encodedBytes: encoded.length,
    encodedToSourceRatio: Number((encoded.length / sourceBytes).toFixed(3)),
    restoredManifestBytes: Number(metadata.size),
    timings,
    runtime: process.versions["bun"] === undefined ? `Node ${process.version}` : `Bun ${process.versions["bun"]}`,
    platform: `${process.platform}-${process.arch}`
  }
}))
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
