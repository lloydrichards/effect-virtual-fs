/** Run from the repository root: bun run docs/research/issue-173/benchmark.ts */
// Native fixture I/O and Promise orchestration keep the measurement harness
// outside the Effect operations being timed. The timestamp is result metadata.
/* oxlint-disable effecttsgo/async-function, effecttsgo/node-builtin-import, effecttsgo/global-date */
import { BytePath, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { TreeTransfer } from "@effect-vfs/memory"
import { BunCrypto } from "@effect/platform-bun"
import { ByteSize, Effect, Option, Predicate, Stream } from "effect"
import effectPackage from "effect/package.json" with { type: "json" }
import { createHash } from "node:crypto"
import { lstat, readFile, readlink } from "node:fs/promises"
import { arch, cpus, platform, release, tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import corePackage from "../../../packages/core/package.json" with { type: "json" }
import memoryPackage from "../../../packages/memory/package.json" with { type: "json" }

const root = resolve(import.meta.dir, "../../..")

const utf8 = new TextEncoder()

const decoder = new TextDecoder()

const iterations = 5

const warmups = 2

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const makeVolume = (entries: ReadonlyArray<Vfs.Fixture["entries"][number]>) =>
  Effect.runPromise(Vfs.fromFixture({ entries }).pipe(Effect.provide(BunCrypto.layer)))

type Counts = { entries: number; copiedBytes: number; decodedBytes: number; results: number }

type Measurement = {
  label: string
  medianMs: number
  minMs: number
  maxMs: number
  samplesMs: Array<number>
  counts?: Counts
  memoryDelta?: Record<string, number>
}

const freshCounts = (): Counts => ({ entries: 0, copiedBytes: 0, decodedBytes: 0, results: 0 })

const median = (values: Array<number>) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!

const rounded = (n: number) => Math.round(n * 1000) / 1000

const memoryFields: ReadonlyArray<keyof ReturnType<typeof process.memoryUsage>> = [
  "heapUsed",
  "rss",
  "external",
  "arrayBuffers"
]

async function measure<A>(label: string, action: () => Promise<A>, getCounts?: () => Counts): Promise<Measurement> {
  for (let n = 0; n < warmups; n++) await action()
  const samplesMs: Array<number> = []
  let memoryDelta: Record<string, number> = {}

  for (let n = 0; n < iterations; n++) {
    Bun.gc(true)
    const before = process.memoryUsage()
    const start = performance.now()
    await action()
    samplesMs.push(performance.now() - start)
    const after = process.memoryUsage()
    memoryDelta = Object.fromEntries(
      memoryFields.map((key) => [key, after[key] - before[key]])
    )
  }

  const measurement: Measurement = {
    label,
    medianMs: rounded(median(samplesMs)),
    minMs: rounded(Math.min(...samplesMs)),
    maxMs: rounded(Math.max(...samplesMs)),
    samplesMs: samplesMs.map(rounded),
    memoryDelta
  }

  if (getCounts !== undefined) measurement.counts = getCounts()

  return measurement
}

async function loadTrackedFixture() {
  const start = performance.now()
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root })

  if (listed.exitCode !== 0) throw new Error("git ls-files failed")
  const paths = new TextDecoder().decode(listed.stdout).split("\0").filter(Boolean).sort()
  const directories = new Set<string>()
  const files: Array<Vfs.Fixture["entries"][number]> = []
  const hash = createHash("sha256")
  const skipped: Array<string> = []

  for (const path of paths) {
    const absolute = resolve(root, path)
    let stat

    try {
      stat = await lstat(absolute)
    } catch {
      skipped.push(path)
      continue
    }

    let parent = dirname(path)

    while (parent !== ".") {
      directories.add(`/${parent}`)
      parent = dirname(parent)
    }

    hash.update(path).update("\0")

    if (stat.isSymbolicLink()) {
      const target = await readlink(absolute)
      hash.update(target)
      files.push({ kind: "symlink", path: `/${path}`, target })
    } else if (stat.isFile()) {
      const bytes = new Uint8Array(await readFile(absolute))
      hash.update(bytes)
      files.push({ kind: "file", path: `/${path}`, bytes })
    } else skipped.push(path)
  }

  const entries: Array<Vfs.Fixture["entries"][number]> = [
    ...[...directories].sort((a, b) => a.length - b.length || a.localeCompare(b)).map((path) => ({
      kind: "directory" as const,
      path
    })),
    ...files
  ]

  return {
    entries,
    importMs: rounded(performance.now() - start),
    hash: hash.digest("hex"),
    trackedPaths: paths.length,
    skipped
  }
}

function synthetic(fileCount: number, bytesPerFile: number, selectedEvery: number) {
  const entries: Array<Vfs.Fixture["entries"][number]> = []
  const payload = new Uint8Array(bytesPerFile).fill(0x61)
  payload.set(utf8.encode("Effect.gen benchmark\n"))

  for (let group = 0; group < Math.ceil(fileCount / 100); group++) {
    const directory = `/group-${String(group).padStart(4, "0")}`
    entries.push({ kind: "directory", path: directory })

    for (let index = group * 100; index < Math.min(fileCount, group * 100 + 100); index++) {
      entries.push({
        kind: "file",
        path: `${directory}/file-${String(index).padStart(6, "0")}.${index % selectedEvery === 0 ? "ts" : "bin"}`,
        bytes: payload
      })
    }
  }

  return entries
}

async function benchDataset(label: string, entries: Array<Vfs.Fixture["entries"][number]>, importMs: number) {
  const fileEntries = entries.filter((entry) => entry.kind === "file")
  const payloadBytes = fileEntries.reduce((sum, entry) => sum + entry.bytes.length, 0)
  const fixtureBuild = await measure("fixture-to-volume", () => makeVolume(entries))
  const volume = await makeVolume(entries)
  const caller = await run(volume.caller())
  const snapshot = await run(volume.snapshot)
  let counts = freshCounts()

  const transferred = () =>
    TreeTransfer.fromSnapshot(snapshot, "/").pipe(Stream.tap((entry) =>
      Effect.sync(() => {
        counts.entries++

        if (entry.kind === "file") counts.copiedBytes += entry.bytes.length
      })
    ))

  const files = () =>
    transferred().pipe(
      Stream.filter((entry): entry is Extract<TreeTransfer.Entry, { kind: "file" }> => entry.kind === "file")
    )

  const paths = () =>
    files().pipe(Stream.filter((entry) => Predicate.isString(entry.path) && entry.path.endsWith(".ts")))

  const text = () =>
    paths().pipe(Stream.filter((entry) => {
      counts.decodedBytes += entry.bytes.length

      return decoder.decode(entry.bytes).includes("Effect.gen")
    }))

  const collectCount = <A, E>(stream: Stream.Stream<A, E>) =>
    stream.pipe(
      Stream.runFold(() => 0, (sum) => sum + 1),
      Effect.tap((n) =>
        Effect.sync(() => {
          counts.results = n
        })
      )
    )

  const query = <A, E>(label: string, stream: () => Stream.Stream<A, E>) =>
    measure(label, () => {
      counts = freshCounts()

      return run(collectCount(stream()))
    }, () => counts)

  const snapshotCapture = await measure("snapshot-capture", () => run(volume.snapshot))

  const firstResult = await measure("first-ts-content-result", async () => {
    counts = freshCounts()
    const result = await run(text().pipe(Stream.runHead))
    counts.results = Option.isSome(result) ? 1 : 0
  }, () => counts)

  const measurements = [
    fixtureBuild,
    snapshotCapture,
    firstResult,
    await query("all-file-entries-no-decoding", files),
    await query("ts-path-filter-no-decoding", paths),
    await query("ts-path-filter-and-content-decode", text),
    await measure("core-snapshotEntries-ts-path-filter", () =>
      run(
        Vfs.snapshotEntries(snapshot, "/").pipe(
          Stream.filter((entry) =>
            entry.kind === "file" && Predicate.isString(entry.path) && entry.path.endsWith(".ts")
          ),
          Stream.runFold(() => 0, (sum) => sum + 1)
        )
      )),
    await measure("caller-walk-ts-path-filter", () =>
      run(
        caller.walk("/").pipe(
          Stream.filter((entry) =>
            entry.kind === "file" && Option.getOrElse(BytePath.toStringOption(entry.path), () => "").endsWith(".ts")
          ),
          Stream.runFold(() => 0, (sum) => sum + 1)
        )
      )),
    await measure("caller-walk-ts-filter-then-read-content", () =>
      run(
        caller.walk("/").pipe(
          Stream.filter((entry) =>
            entry.kind === "file" && Option.getOrElse(BytePath.toStringOption(entry.path), () => "").endsWith(".ts")
          ),
          Stream.mapEffect((entry) => caller.readFile(entry.reference)),
          Stream.filter((bytes) => decoder.decode(bytes).includes("Effect.gen")),
          Stream.runFold(() => 0, (sum) => sum + 1)
        )
      ))
  ]

  const repeatedQueries = await measure("ten-repeated-ts-content-queries-same-snapshot", async () => {
    let results = 0

    for (let index = 0; index < 10; index++) {
      counts = freshCounts()
      results += await run(collectCount(text()))
    }

    return results
  })

  measurements.push(repeatedQueries)
  process.stdout.write(
    `${label}: ${fileEntries.length} files, ${payloadBytes} bytes; content median ${measurements[5]!.medianMs} ms\n`
  )

  return { label, fileCount: fileEntries.length, fixtureEntries: entries.length, payloadBytes, importMs, measurements }
}

async function probes() {
  const volume = await makeVolume([
    { kind: "file", path: "/a.bin", bytes: utf8.encode("needle") },
    { kind: "hardLink", path: "/z.ts", target: "/a.bin" },
    { kind: "file", path: "/zz-large.bin", bytes: new Uint8Array(1024) }
  ])

  const snapshot = await run(volume.snapshot)

  const emitted = await run(
    TreeTransfer.fromSnapshot(snapshot, "/").pipe(
      Stream.map((entry) => {
        if (entry.kind === "hardLink") return { kind: entry.kind, path: entry.path, target: entry.target }

        return { kind: entry.kind, path: entry.path }
      }),
      Stream.runCollect
    )
  )

  const naiveAliasMatches = await run(
    TreeTransfer.fromSnapshot(snapshot, "/").pipe(
      Stream.filter((entry) =>
        entry.kind === "file" && entry.path === "/z.ts" && decoder.decode(entry.bytes).includes("needle")
      ),
      Stream.runCollect
    )
  )

  const limits = { ...TreeTransfer.TreeTransferLimits.default, maxFileBytes: ByteSize.bytes(10) }

  const headBeforeLarge = await run(
    TreeTransfer.fromSnapshot(snapshot, "/", { limits }).pipe(
      Stream.filter((entry) => entry.kind === "file"),
      Stream.runHead
    )
  )

  const fullScan = await run(TreeTransfer.fromSnapshot(snapshot, "/", { limits }).pipe(Stream.runDrain, Effect.flip))

  const walkAliasMatches = await run(
    (await run(volume.caller())).walk("/").pipe(
      Stream.filter((entry) =>
        entry.kind === "file" && Option.getOrElse(BytePath.toStringOption(entry.path), () => "") === "z.ts"
      ),
      Stream.runCollect
    )
  )

  if (
    naiveAliasMatches.length !== 0 || !Option.isSome(headBeforeLarge) || fullScan.code !== "LimitExceeded" ||
    walkAliasMatches.length !== 1
  ) {
    throw new Error("Snapshot laziness or hard-link probe changed; inspect semantics before interpreting timings")
  }

  return {
    emitted,
    naiveAliasMatches: naiveAliasMatches.length,
    headSucceedsBeforeOversizedFile: Option.isSome(headBeforeLarge),
    fullScanError: { code: fullScan.code, field: "field" in fullScan ? fullScan.field : undefined },
    callerWalkAliasMatches: walkAliasMatches.length
  }
}

const tracked = await loadTrackedFixture()

const datasets = [await benchDataset("tracked-repository", tracked.entries, tracked.importMs)]

for (
  const spec of [{ files: 1000, bytes: 4096, selectedEvery: 10 }, { files: 10000, bytes: 4096, selectedEvery: 10 }, {
    files: 1000,
    bytes: 65536,
    selectedEvery: 100
  }]
) {
  const start = performance.now()
  const entries = synthetic(spec.files, spec.bytes, spec.selectedEvery)
  datasets.push(
    await benchDataset(
      `synthetic-${spec.files}-files-${spec.bytes}-bytes-select-1-in-${spec.selectedEvery}`,
      entries,
      rounded(performance.now() - start)
    )
  )
}

const result = {
  recordedAt: new Date().toISOString(),
  command: "bun run docs/research/issue-173/benchmark.ts",
  revision: new TextDecoder().decode(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout).trim(),
  runtime: {
    bun: Bun.version,
    effect: effectPackage.version,
    core: corePackage.version,
    memory: memoryPackage.version,
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: cpus()[0]?.model
  },
  sampling: {
    warmups,
    iterations,
    collection: "runFold count, no retained result array",
    memory: "last sample end-minus-start; GC forced before sample, not an allocation profiler"
  },
  fixture: {
    hash: tracked.hash,
    trackedPaths: tracked.trackedPaths,
    skipped: tracked.skipped,
    inventory: "git ls-files; current working-tree bytes including tracked dirty files; untracked files excluded"
  },
  probes: await probes(),
  datasets
}

const outputPath = resolve(tmpdir(), "effect-vfs-issue-173-benchmark-latest.json")

await Bun.write(outputPath, `${JSON.stringify(result, null, 2)}\n`)

process.stdout.write(`Wrote ${outputPath}\n`)
