import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { ByteSize, Effect, Layer } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { cpus, release, totalmem } from "node:os"
import { LiveVolume, VirtualFileSystem as Vfs } from "../../packages/core/dist/index.js"

const output = process.argv[2]

assert.ok(output, "Usage: bun scripts/capacity/snapshot-observations.mjs output.json")

const workloads = [
  { files: 128, bytesPerFile: 4_096 },
  { files: 4, bytesPerFile: 1_048_576 }
]

const modes = /** @type {const} */ (["snapshot-backed", "live-image"])

const operations = /** @type {const} */ (["none", "stat", "read", "write"])

const rounds = 5

const cycles = 20

const probe = "/probe"

const create = { access: "write", create: "exclusive" }

const replace = { access: "write", truncate: true }

const measure = Effect.fnUntraced(
  /** @param {typeof modes[number]} mode
   * @param {typeof workloads[number]} workload
   */ function*(mode, workload) {
    let commits = 0
    /** @type {Uint8Array | undefined} */
    let image

    const store = Layer.succeed(
      LiveVolume.LiveImageStore,
      LiveVolume.LiveImageStore.of({
        loadOrCreate: (initial) => Effect.sync(() => image ??= initial),
        commit: (candidate) =>
          Effect.sync(() => {
            image = candidate
            commits++

            return "committed"
          })
      })
    )

    const options = {
      maxEntries: workload.files + 1,
      maxBytes: ByteSize.mebibytes(8),
      maxFileBytes: ByteSize.mebibytes(1)
    }

    const seeded = mode === "live-image"
      ? yield* LiveVolume.open({ maxImageBytes: ByteSize.mebibytes(16), volume: options }).pipe(Effect.provide(store))
      : yield* Vfs.make(options)

    const writer = yield* seeded.caller()
    const block = new Uint8Array(workload.bytesPerFile).fill(42)

    for (let file = 0; file < workload.files; file++) yield* writer.writeFile("/f" + file, block, create)
    yield* writer.writeFile(probe, Uint8Array.of(0), create)

    const volume = mode === "live-image" ? seeded : yield* Vfs.fromSnapshot(yield* seeded.snapshot, options)
    const caller = yield* volume.caller()
    let value = 0
    const writes = [Uint8Array.of(0), Uint8Array.of(1)]

    const work = {
      none: Effect.void,
      stat: caller.stat(probe),
      read: caller.readFile(probe),
      write: Effect.suspend(() => {
        value = 1 - value

        return caller.writeFile(probe, writes[value], replace)
      })
    }

    const trial = Effect.fnUntraced(/** @param {typeof operations[number]} operation */ function*(operation) {
      const beforeCommits = commits
      const firstStart = performance.now()
      const first = yield* volume.snapshot
      const operationStart = performance.now()
      const result = yield* work[operation]
      const secondStart = performance.now()
      const second = yield* volume.snapshot
      const end = performance.now()

      if (operation === "write") assert.notStrictEqual(second, first)
      else assert.strictEqual(second, first)

      if (operation === "read") assert.equal(result[0], value)

      if (operation === "stat") assert.equal(result.size, 1n)
      assert.equal(commits - beforeCommits, mode === "live-image" && operation === "write" ? 1 : 0)

      return {
        firstCaptureMs: operationStart - firstStart,
        operationMs: secondStart - operationStart,
        secondCaptureMs: end - secondStart
      }
    })

    const samples = []

    for (let round = 0; round < rounds; round++) {
      const order = operations.slice(round % operations.length).concat(operations.slice(0, round % operations.length))

      for (const operation of order) {
        // Warm the access time after any previous writes before measuring unchanged reads.
        if (operation === "read") yield* work.read

        for (let warmup = 0; warmup < 3; warmup++) yield* trial(operation)

        for (let sample = 0; sample < cycles; sample++) {
          samples.push({ round, operation, ...yield* trial(operation) })
        }
      }
    }

    return { mode, ...workload, samples }
  }
)

const results = await Effect.runPromise(
  Effect.forEach(workloads, (workload) => Effect.forEach(modes, (mode) => Effect.scoped(measure(mode, workload))))
    .pipe(Effect.provide(NodeCrypto.layer))
)

writeFileSync(
  output,
  JSON.stringify(
    {
      revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      runtime: process.versions.bun ?? process.version,
      platform: process.platform,
      arch: process.arch,
      kernel: release(),
      cpu: cpus()[0]?.model,
      ramBytes: totalmem(),
      rounds,
      cycles,
      results: results.flat()
    },
    null,
    2
  ) + "\n"
)
