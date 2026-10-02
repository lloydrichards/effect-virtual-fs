/** Run after building core: bun run docs/research/issue-173/glob-benchmark.ts */
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
  bytes: new Uint8Array(65_536)
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

  const query: Search.GlobQuery = {
    root: "/",
    include: ["**/*.ts"],
    kinds: ["file"],
    limits: { maxResults: 100_000, maxResultBytes: ByteSize.bytes(1_048_576) }
  }

  let copiedBytes = 0

  const recipe = () => {
    copiedBytes = 0

    return run(
      Vfs.snapshotEntries(snapshot, "/").pipe(
        Stream.tap((entry) =>
          Effect.sync(() => {
            if (entry.kind === "file") copiedBytes += entry.bytes.length
          })
        ),
        Stream.filter((entry) => entry.kind === "file" && Predicate.isString(entry.path) && entry.path.endsWith(".ts")),
        Stream.runFold(() => 0, (n) => n + 1)
      )
    )
  }

  const recipeMeasurement = await sample(recipe)

  const searchMeasurement = await sample(() =>
    run(Search.scanGlob(snapshot, query).pipe(Stream.runFold(() => 0, (n) => n + 1)))
  )

  const report = await run(Search.glob(snapshot, query))

  if (recipeMeasurement.rows !== searchMeasurement.rows || !Predicate.isTagged("Complete")(report.completion)) {
    throw new Error(`Queries disagree or did not complete: ${label}`)
  }

  datasets.push({
    label,
    namespaceEntries: entries.length,
    recipe: { ...recipeMeasurement, copiedPayloadBytes: copiedBytes, decodedPayloadBytes: 0 },
    search: { ...searchMeasurement, copiedPayloadBytes: 0, decodedPayloadBytes: 0, work: report.work },
    copyingEvidence:
      "Recipe emitted payload lengths; Search's zero payload access is separately enforced by getter-trap tests."
  })
}

const result = {
  command: "bun run docs/research/issue-173/glob-benchmark.ts",
  recordedAt: new Date().toISOString(),
  revision: new TextDecoder().decode(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout).trim(),
  runtime: { bun: Bun.version, cpu: cpus()[0]?.model },
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

const output = resolve(tmpdir(), "effect-vfs-issue-256-glob-benchmark.json")

await Bun.write(
  output,
  JSON.stringify(result, (_, value) => Predicate.isBigInt(value) ? value.toString() : value, 2) + "\n"
)

process.stdout.write(`Wrote ${output}\n`)
