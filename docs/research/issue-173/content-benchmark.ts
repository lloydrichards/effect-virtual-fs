/** Run after building core: bun run docs/research/issue-173/content-benchmark.ts */
// Native fixture loading is outside the timed public-API searches.
/* oxlint-disable effecttsgo/async-function, effecttsgo/node-builtin-import, effecttsgo/global-date */
import { Search, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { ByteSize, Effect, Predicate, Stream } from "effect"
import { createHash } from "node:crypto"
import { lstat, readFile, readlink } from "node:fs/promises"
import { cpus, tmpdir } from "node:os"
import { dirname, resolve } from "node:path"

const root = resolve(import.meta.dir, "../../..")

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const round = (n: number) => Math.round(n * 1_000) / 1_000

const names = new TextDecoder().decode(Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root }).stdout).split("\0")
  .filter(Boolean)

const directories = new Set<string>()

const files: Array<Vfs.Fixture["entries"][number]> = []

const hash = createHash("sha256")

for (const name of names.sort()) {
  let parent = dirname(name)

  while (parent !== ".") {
    directories.add(`/${parent}`)
    parent = dirname(parent)
  }

  const info = await lstat(resolve(root, name))
  hash.update(name).update("\0")

  if (info.isSymbolicLink()) {
    const target = await readlink(resolve(root, name))
    files.push({ kind: "symlink", path: `/${name}`, target })
    hash.update(target)
  } else {
    const bytes = new Uint8Array(await readFile(resolve(root, name)))
    files.push({ kind: "file", path: `/${name}`, bytes })
    hash.update(bytes)
  }
}

const tracked: Vfs.Fixture["entries"] = [
  ...[...directories].map((path) => ({ kind: "directory" as const, path })),
  ...files
]

const synthetic: Vfs.Fixture["entries"] = Array.from({ length: 1_000 }, (_, i) => ({
  kind: "file",
  path: `/f-${String(i).padStart(4, "0")}.${i % 100 === 0 ? "ts" : "bin"}`,
  bytes: (() => {
    const bytes = new Uint8Array(65_536).fill(0x61)
    bytes.set(new TextEncoder().encode("Effect.gen benchmark\n"))

    return bytes
  })()
}))

async function sample(action: () => Promise<number>) {
  for (let i = 0; i < 2; i++) await action()
  const samples: Array<number> = []
  let rows = 0

  for (let i = 0; i < 5; i++) {
    Bun.gc(true)
    const start = performance.now()
    rows = await action()
    samples.push(round(performance.now() - start))
  }

  return { rows, medianMs: [...samples].sort((a, b) => a - b)[2]!, samplesMs: samples }
}

const datasets: Array<unknown> = []

for (
  const [label, entries] of [["tracked-working-tree", tracked], ["selective-1000-files-64KiB", synthetic]] as const
) {
  const volume = await Effect.runPromise(Vfs.fromFixture({ entries }).pipe(Effect.provide(BunCrypto.layer)))
  const snapshot = await run(volume.snapshot)

  const query: Search.ContentQuery = {
    root: "/",
    include: ["**/*.ts"],
    pattern: Search.Pattern.cases.Literal.make({ pattern: "Effect.gen" }),
    limits: {
      maxResults: 100_000,
      maxResultBytes: ByteSize.megabytes(64),
      maxLineEvaluations: 1_000_000,
      maxScannedBytes: ByteSize.gigabytes(1)
    }
  }

  let copiedBytes = 0
  let selectedBytes = 0
  let recipeLines = 0
  let invalidFiles = 0
  let binaryFiles = 0
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

  const recipe = () => {
    copiedBytes = 0
    selectedBytes = 0
    recipeLines = 0
    invalidFiles = 0
    binaryFiles = 0

    return run(
      Vfs.snapshotEntries(snapshot, "/").pipe(
        Stream.tap((entry) =>
          Effect.sync(() => {
            if (entry.kind === "file") copiedBytes += entry.bytes.length
          })
        ),
        Stream.filter((entry) => entry.kind === "file" && Predicate.isString(entry.path) && entry.path.endsWith(".ts")),
        Stream.map((entry) => {
          if (entry.kind !== "file" || entry.bytes.length > 1_048_576) return 0
          selectedBytes += entry.bytes.length
          let text: string

          try {
            text = decoder.decode(entry.bytes)
          } catch {
            invalidFiles++

            return 0
          }

          if (entry.bytes.includes(0)) {
            binaryFiles++

            return 0
          }

          if (text.length === 0) return 0
          const lines = text.split("\n")

          if (text.endsWith("\n")) lines.pop()
          let count = 0

          for (const line of lines) if (line.includes("Effect.gen")) count++
          recipeLines += count

          return count > 0 ? 1 : 0
        }),
        Stream.runFold(() => 0, (n, hit) => n + hit)
      )
    )
  }

  const recipeMeasurement = await sample(recipe)

  const filesMeasurement = await sample(() =>
    run(Search.scanFiles(snapshot, query).pipe(Stream.runFold(() => 0, (n) => n + 1)))
  )

  const linesMeasurement = await sample(() =>
    run(Search.scanLines(snapshot, query).pipe(Stream.runFold(() => 0, (n) => n + 1)))
  )

  const countsMeasurement = await sample(() =>
    run(Search.scanCountLines(snapshot, query).pipe(Stream.runFold(() => 0, (n) => n + 1)))
  )

  const filesReport = await run(Search.files(snapshot, query))
  const linesReport = await run(Search.lines(snapshot, query))
  const countsReport = await run(Search.countLines(snapshot, query))
  const exactCount = countsReport.results.reduce((total, row) => total + row.count, 0)

  if (
    recipeMeasurement.rows !== filesMeasurement.rows || recipeLines !== linesMeasurement.rows ||
    exactCount !== recipeLines || countsMeasurement.rows !== filesMeasurement.rows ||
    [filesReport, linesReport, countsReport].some((report) => !Predicate.isTagged("Complete")(report.completion)) ||
    selectedBytes !== Number(filesReport.work.scannedBytes) ||
    invalidFiles !== filesReport.skips.invalidUtf8Files || binaryFiles !== filesReport.skips.binaryFiles
  ) throw new Error(`Content queries disagree or did not complete: ${label}`)

  datasets.push({
    label,
    namespaceEntries: entries.length,
    recipe: {
      ...recipeMeasurement,
      copiedPayloadBytes: copiedBytes,
      selectedPayloadBytes: selectedBytes,
      matchingLines: recipeLines
    },
    files: { ...filesMeasurement, work: filesReport.work, skips: filesReport.skips },
    lines: { ...linesMeasurement, work: linesReport.work, skips: linesReport.skips },
    counts: { ...countsMeasurement, matchingLines: exactCount, work: countsReport.work, skips: countsReport.skips },
    copyingEvidence:
      "Recipe materializes snapshot file payloads before selection. Search borrows immutable bytes; scalar classification and guarded tests establish no payload copies, while line/excerpt strings allocate. scannedBytes charges the full selected eligible file once, not every internal byte pass. Recipe splits all selected text and counts all lines; files mode can stop matching early."
  })
}

const result = {
  command: "bun run docs/research/issue-173/content-benchmark.ts",
  recordedAt: new Date().toISOString(),
  revision: new TextDecoder().decode(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout).trim(),
  runtime: { bun: Bun.version, cpu: cpus()[0]?.model },
  implementation: await Promise.all([
    "packages/core/src/Search.ts",
    "packages/core/src/internal/searchContent.ts",
    "packages/core/dist/Search.js",
    "packages/core/dist/internal/searchContent.js"
  ].map(async (path) => ({
    path,
    sha256: createHash("sha256").update(await readFile(resolve(root, path))).digest("hex")
  }))),
  fixture: {
    hash: hash.digest("hex"),
    trackedPaths: names.length,
    inventory: "git ls-files; current tracked working-tree bytes; untracked new files excluded"
  },
  sampling: {
    warmups: 2,
    iterations: 5,
    collection: "Stream.runFold count; output caps raised for full scan; GC before each measured sample"
  },
  limitations: "One machine; no allocation profiler, tail-latency, browser, deadline or physical durability evidence.",
  datasets
}

const output = resolve(tmpdir(), "effect-vfs-issue-257-content-benchmark.json")

await Bun.write(
  output,
  JSON.stringify(result, (_, value) => Predicate.isBigInt(value) ? value.toString() : value, 2) + "\n"
)

process.stdout.write(`Wrote ${output}\n`)
