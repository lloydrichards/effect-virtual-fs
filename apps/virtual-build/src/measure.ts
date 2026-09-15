import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { ByteSize, Clock, Console, Effect, FileSystem, Path, Schema } from "effect"

const PackageManifest = Schema.fromJsonString(Schema.Struct({ version: Schema.String }))

const Json = Schema.fromJsonString(Schema.Unknown, { space: 2 })

const packageNames = ["effect", "vite", "rolldown"] as const

type TimingName = "fixtureMs" | "captureMs" | "encodeMs" | "decodeMs" | "restoreMs"

interface Timings extends Partial<Record<TimingName, number>> {
  preparationMs: number
}

const program = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const preparationStarted = yield* Clock.monotonicTimeNanos
  const beforePreparationRssBytes = yield* Effect.sync(() => process.memoryUsage().rss)
  const packages: Array<{ name: string; version: string }> = []
  const entries: Array<Vfs.Fixture["entries"][number]> = [{ kind: "directory", path: "/node_modules" }]
  let sourceBytes = 0
  let files = 0

  for (const name of packageNames) {
    const manifestPath = yield* path.fromFileUrl(new URL(import.meta.resolve(`${name}/package.json`)))
    const root = path.dirname(manifestPath)

    const manifest = yield* fileSystem.readFileString(manifestPath).pipe(
      Effect.flatMap(Schema.decodeEffect(PackageManifest))
    )

    packages.push({ name, version: manifest.version })

    const pending = [{ host: root, virtual: `/node_modules/${name}` }]

    while (pending.length > 0) {
      const directory = pending.pop()

      if (directory === undefined) break
      entries.push({ kind: "directory", path: directory.virtual })
      const children = yield* fileSystem.readDirectory(directory.host)
      children.sort()

      for (const child of children) {
        if (child === "node_modules") continue
        const host = path.join(directory.host, child)
        const canonicalHost = yield* fileSystem.realPath(host)

        if (path.normalize(canonicalHost) !== path.normalize(host)) continue

        const virtualPath = `${directory.virtual}/${child}`
        const metadata = yield* fileSystem.stat(host)

        if (metadata.type === "Directory") {
          pending.push({ host, virtual: virtualPath })
        } else if (metadata.type === "File") {
          const bytes = yield* fileSystem.readFile(host)
          sourceBytes += bytes.length
          files++
          entries.push({ kind: "file", path: virtualPath, bytes })
        }
      }
    }
  }

  const timings: Timings = {
    preparationMs: Number((Number((yield* Clock.monotonicTimeNanos) - preparationStarted) / 1_000_000).toFixed(2))
  }

  const measure = Effect.fnUntraced(function*<A, E, R>(name: TimingName, effect: Effect.Effect<A, E, R>) {
    const start = yield* Clock.monotonicTimeNanos
    const value = yield* effect
    timings[name] = Number((Number((yield* Clock.monotonicTimeNanos) - start) / 1_000_000).toFixed(2))

    return value
  })

  const volume = yield* measure("fixtureMs", Vfs.fromFixture({ entries }))
  const snapshot = yield* measure("captureMs", volume.snapshot)
  const encoded = yield* measure("encodeMs", Vfs.encodeSnapshot(snapshot))

  const decoded = yield* measure(
    "decodeMs",
    Vfs.decodeSnapshot(encoded, {
      maxEncodedBytes: ByteSize.bytes(encoded.length),
      maxRecords: entries.length + 1,
      maxEntries: entries.length,
      maxDecodedBytes: ByteSize.bytes(sourceBytes + entries.length * 512)
    })
  )

  const restored = yield* measure("restoreMs", Vfs.fromSnapshot(decoded))
  const caller = yield* restored.caller()
  const metadata = yield* caller.stat("/node_modules/vite/package.json")

  const runtime = yield* Effect.sync(() => ({
    afterRestorationRssBytes: process.memoryUsage().rss,
    peakRssBytes: process.versions["bun"] === undefined ? process.resourceUsage().maxRSS * 1024 : null,
    peakSource: process.versions["bun"] === undefined
      ? "Node process.resourceUsage().maxRSS (KiB) multiplied by 1024"
      : "Unavailable: run with Node for the verified peak RSS metric",
    name: process.versions["bun"] === undefined ? `Node ${process.version}` : `Bun ${process.versions["bun"]}`,
    platform: `${process.platform}-${process.arch}`
  }))

  const report = {
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
      afterRestorationRssBytes: runtime.afterRestorationRssBytes,
      peakRssBytes: runtime.peakRssBytes,
      peakSource: runtime.peakSource,
      peakScope: "Process lifetime through restoration, including imports, host fixture preparation and all phases",
      collection: "No forced garbage collection; fixture input and pipeline values coexist as runtime liveness permits"
    },
    runtime: runtime.name,
    platform: runtime.platform
  }

  yield* Console.log(yield* Schema.encodeEffect(Json)(report))
})

program.pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)
