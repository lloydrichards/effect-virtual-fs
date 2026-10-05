// The baseline and candidate are loaded from isolated generated bundles, so their
// Effect channels are unavailable to static analysis. Runtime assertions verify
// their public operation results; production typed APIs are checked separately.
/* oxlint-disable effecttsgo/any-unknown-in-error-context */
// CLI environment knobs configure benchmark orchestration, outside timed Effects.
/* oxlint-disable effecttsgo/process-env */
// Native async I/O manages isolated build artifacts and emits benchmark JSON.
// Those orchestration steps are outside the timed Effect filesystem batches.
/* oxlint-disable effecttsgo/async-function, effecttsgo/node-builtin-import, effecttsgo/global-console, effecttsgo/new-promise, eslint/no-console */
import { strict as assert } from "node:assert"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { cpus, platform, release, tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import * as Effect from "effect/Effect"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

const temp = await mkdtemp(resolve(tmpdir(), "production-confinement-"))

const iterations = Number(process.env.CONFINEMENT_BENCH_ITERATIONS ?? 1200)

const rounds = Number(process.env.CONFINEMENT_BENCH_ROUNDS ?? 7)

const fileBytes = Number(process.env.CONFINEMENT_BENCH_FILE_BYTES ?? 4)

const depths = (process.env.CONFINEMENT_BENCH_DEPTHS ?? "1,8,64").split(",").map(Number)

for (const value of [iterations, rounds, fileBytes, ...depths]) assert.ok(Number.isSafeInteger(value) && value > 0)

const bytes = new Uint8Array(fileBytes).fill(100)

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

async function command(args, cwd = repo) {
  const child = spawn(args[0], args.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] })
  const outputChunks = []
  const errorChunks = []
  child.stdout.on("data", (chunk) => outputChunks.push(chunk))
  child.stderr.on("data", (chunk) => errorChunks.push(chunk))

  const status = await new Promise((resolve, reject) => {
    child.on("error", reject)
    child.on("close", resolve)
  })

  const output = Buffer.concat(outputChunks)
  const error = Buffer.concat(errorChunks).toString()

  assert.equal(status, 0, `${args.join(" ")}: ${error}`)

  return Buffer.from(output)
}

const baselineRef = (await command(["git", "rev-parse", process.env.CONFINEMENT_BENCH_BASELINE ?? "HEAD"])).toString().trim()

const baselinePatch = process.env.CONFINEMENT_BENCH_BASELINE_PATCH

const compareConfined = process.env.CONFINEMENT_BENCH_BASELINE_CONFINED === "1"

const sourceBundleHashes = {}

const sourceTreeHashes = {}

async function loadCore(label) {
  const source = resolve(temp, label, "packages/core/src")
  const hash = createHash("sha256")

  for (const path of (await readdir(source, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile()).map((entry) => resolve(entry.parentPath, entry.name)).sort()) {
    hash.update(path.slice(source.length + 1)).update("\0").update(await readFile(path)).update("\0")
  }

  sourceTreeHashes[label] = hash.digest("hex")

  const output = resolve(temp, label, "bundle/core.mjs")
  await command(["bun", "build", resolve(temp, label, "packages/core/src/VirtualFileSystem.ts"),
    "--outfile", output, "--target", process.versions.bun ? "bun" : "node",
    "--external", "effect", "--external", "effect/*"])
  sourceBundleHashes[label] = createHash("sha256").update(await readFile(output)).digest("hex")

  return import(pathToFileURL(output).href)
}

try {
  await symlink(resolve(repo, "node_modules"), resolve(temp, "node_modules"), "dir")
  await mkdir(resolve(temp, "baseline"))
  const archive = await command(["git", "archive", baselineRef, "packages/core/src"])
  await writeFile(resolve(temp, "baseline.tar"), archive)
  await command(["tar", "-xf", resolve(temp, "baseline.tar"), "-C", resolve(temp, "baseline")])

  if (baselinePatch !== undefined) {
    await command(["git", "apply", resolve(repo, baselinePatch)], resolve(temp, "baseline"))
  }

  await cp(resolve(repo, "packages/core/src"), resolve(temp, "current/packages/core/src"), { recursive: true })
  const [baseline, current] = await Promise.all([loadCore("baseline"), loadCore("current")])
  const reports = []

  for (const depth of depths) {
    const directories = Array.from({ length: depth }, (_, index) => `/tenant/${Array.from({ length: index + 1 }, () => "d").join("/")}`)
    const physicalPath = `${directories.at(-1)}/file`

    const fixture = { entries: [
      { kind: "directory", path: "/tenant" },
      ...directories.map((path) => ({ kind: "directory", path })),
      { kind: "file", path: physicalPath, bytes }
    ] }

    const samples = new Map()

    const setup = (vfs, confined) => Effect.gen(function*() {
      const volume = yield* vfs.fromFixture(fixture)
      const owner = yield* volume.caller()
      const caller = confined ? yield* owner.withRoot("/tenant") : owner
      const path = confined ? physicalPath.slice("/tenant".length) : physicalPath
      const handle = yield* caller.open(path, { access: "readWrite" })

      return { caller, path, handle }
    })

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const contexts = {
        baseline: yield* setup(baseline, false),
        ordinary: yield* setup(current, false),
        confined: yield* setup(current, true)
      }

      if (compareConfined) {
        contexts.baselineConfined = yield* setup(baseline, true)
      }

      for (const workload of ["path-read", "handle-read", "handle-read-write"]) {
        const batch = (context) => Effect.gen(function*() {
          let checksum = 0

          for (let index = 0; index < iterations; index++) {
            const data = workload === "path-read"
              ? yield* context.caller.readFile(context.path)
              : (yield* context.handle.pread(fileBytes, 0n)).bytes

            assert.equal(data.length, fileBytes)
            assert.equal(data.at(-1), 100)
            checksum += data[0]

            if (workload === "handle-read-write") assert.equal(yield* context.handle.pwrite(bytes, 0n), fileBytes)
          }

          assert.equal(checksum, iterations * 100)
        })

        for (const [label, context] of Object.entries(contexts)) {
          for (let warmup = 0; warmup < 3; warmup++) yield* batch(context)
          samples.set(`${workload}:${label}`, [])
        }

        for (let round = 0; round < rounds; round++) {
          const order = round % 2 === 0 ? Object.entries(contexts) : Object.entries(contexts).reverse()

          for (const [label, context] of order) {
            const start = performance.now()
            yield* batch(context)
            samples.get(`${workload}:${label}`).push(performance.now() - start)
          }
        }

        const timing = Object.fromEntries(Object.keys(contexts).map((label) => {
          const values = samples.get(`${workload}:${label}`)

          return [label, { medianMs: median(values), samplesMs: values }]
        }))

        reports.push({ depth, workload, timing,
          ordinaryRegressionPercent: (timing.ordinary.medianMs / timing.baseline.medianMs - 1) * 100,
          confinedChangePercent: timing.baselineConfined === undefined ? undefined : (timing.confined.medianMs / timing.baselineConfined.medianMs - 1) * 100,
          confinedOverOrdinaryPercent: (timing.confined.medianMs / timing.ordinary.medianMs - 1) * 100
        })
      }
    })).pipe(Effect.provide(NodeCrypto.layer)))
  }

  const result = { runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`, platform: platform(), osRelease: release(), cpu: cpus()[0]?.model, sourceBundleHashes, sourceTreeHashes, baseline: baselineRef, baselinePatch,
    iterations, rounds, warmupRounds: 3, depths, fileBytes, reports,
    limitations: "Single runtime process, copied actual sources bundled independently; memory backend with real Effect batch execution. Excludes fixture/acquisition time. No allocation or package-wide performance claim. Confined path omits the physical tenant prefix." }

  const output = process.env.CONFINEMENT_BENCH_OUTPUT ?? resolve(tmpdir(), "production-confinement-benchmark.json")
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify({ output, runtime: result.runtime, iterations, rounds, reports: reports.map(({ depth, workload, ordinaryRegressionPercent, confinedChangePercent, confinedOverOrdinaryPercent, timing }) => ({ depth, workload, ordinaryRegressionPercent, confinedChangePercent, confinedOverOrdinaryPercent, baselineMs: timing.baseline.medianMs, ordinaryMs: timing.ordinary.medianMs, confinedMs: timing.confined.medianMs })) }, null, 2))
} finally {
  await rm(temp, { recursive: true, force: true })
}
