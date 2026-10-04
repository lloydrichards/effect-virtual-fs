/* eslint-disable effecttsgo/global-console, effecttsgo/global-date, effecttsgo/node-builtin-import -- Native process APIs keep measurement and JSON output outside the measured Effect workload. */
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { ByteSize, Deferred, Effect, Fiber, Result, Stream } from "effect"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { cpus, totalmem } from "node:os"
import { setImmediate } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { VirtualFileSystem as Vfs } from "../../packages/core/dist/index.js"
import { withVolumeTestSeams } from "../../packages/core/dist/internal/testSeams.js"
import * as Memory from "../../packages/memory/dist/MemoryFileSystem.js"

const scenarios = [
  ...[1, 16, 64].flatMap((size) => ["partial", "growth"].map((kind) => `${kind}:${size}`)),
  ...[100, 1000, 10000].map((size) => `workspace:${size}`),
  ...[32, 128, 256].map((size) => `deep:${size}`),
  "bounded:1000",
  "admission:1000",
  "contention:8",
  "contention:128",
  "watch:10000",
  "adapter:1000"
]

const memory = () => process.memoryUsage()

const samples = []

const phases = []

const sample = () => samples.push(memory())

const phase = Effect.fnUntraced(
  /**
   * @template A, E, R
   * @param {string} name
   * @param {Effect.Effect<A, E, R>} work
   */ function*(name, work) {
    sample()
    const start = performance.now()
    const value = yield* work
    const elapsedMs = performance.now() - start
    sample()
    phases.push({ name, elapsedMs })

    return value
  }
)

const boundedQuotas = {
  maxBytes: ByteSize.mebibytes(8),
  maxFileBytes: ByteSize.mebibytes(1),
  maxEntries: 1000,
  maxPathBytes: ByteSize.bytes(1024),
  maxPendingOperations: 64,
  maxWatchEvents: 256
}

const quotas = {
  maxBytes: ByteSize.mebibytes(128),
  maxFileBytes: ByteSize.mebibytes(64),
  maxEntries: 12000,
  maxPathBytes: ByteSize.bytes(4096),
  maxPendingOperations: 64,
  maxWatchEvents: 256
}

const writeOptions = { access: "write", create: "ifMissing", truncate: true }

const workload = Effect.fnUntraced(/** @param {string} scenario */ function*(scenario) {
  const [kind, input] = scenario.split(":")
  const size = Number(input)
  const volume = yield* Vfs.make(kind === "bounded" ? boundedQuotas : quotas)
  const caller = yield* volume.caller()

  if (kind === "partial" || kind === "growth") {
    const file = yield* caller.open("/large.bin", { access: "readWrite", create: "exclusive" })
    const target = size * 1024 * 1024
    const block = new Uint8Array(kind === "partial" ? 4096 : 1024 * 1024).fill(7)

    if (kind === "partial") yield* file.truncate(BigInt(target))
    const latencies = []
    yield* phase(
      kind,
      Effect.gen(function*() {
        const count = kind === "partial" ? 100 : size

        for (let index = 0; index < count; index++) {
          const start = performance.now()
          assert.equal(yield* file.pwrite(block, BigInt(kind === "partial" ? 0 : index * block.length)), block.length)
          latencies.push(performance.now() - start)
          sample()
        }
      })
    )
    const bytes = yield* caller.readFile("/large.bin")
    assert.equal(bytes.length, target)
    assert.equal(bytes[0], 7)
    assert.equal(bytes[target - 1], kind === "partial" ? 0 : 7)
    latencies.sort((a, b) => a - b)

    return {
      operations: latencies.length,
      p50Ms: latencies[Math.floor(latencies.length * .5)],
      p95Ms: latencies[Math.floor(latencies.length * .95)]
    }
  }

  if (kind === "bounded" || kind === "workspace" || kind === "deep" || kind === "adapter") {
    yield* phase(
      "populate",
      Effect.gen(function*() {
        if (kind === "deep") {
          yield* caller.mkdir("/d".repeat(size), { recursive: true })
        } else {
          for (let index = 0; index < size; index++) {
            yield* caller.writeFile(`/f${index}`, new Uint8Array(4096), writeOptions)

            if (index % 100 === 0) sample()
          }
        }
      })
    )
    global.gc()
    const populatedMemory = memory()
    const count = yield* phase("walk", Stream.runCount(caller.walk("/")))
    assert.equal(count, size)

    if (kind === "workspace" || kind === "bounded") {
      const base = yield* phase("snapshot", volume.snapshot)
      yield* caller.writeFile("/f0", new Uint8Array([1]), writeOptions)
      const ours = yield* volume.snapshot
      const overlay = yield* Vfs.makeOverlay(base)
      yield* (yield* overlay.caller()).writeFile("/f1", new Uint8Array([2]), writeOptions)
      const theirs = (yield* overlay.capture()).snapshot
      const deltaResult = yield* phase("delta", Effect.result(Vfs.diffSnapshots(base, ours)))

      if (Result.isFailure(deltaResult)) {
        assert.equal(size, 10000)
        assert.equal(deltaResult.failure.code, "LimitExceeded")
        assert.equal(deltaResult.failure.field, "identityBytes")

        return {
          entries: count,
          populatedMemory,
          deltaRejected: { code: deltaResult.failure.code, field: deltaResult.failure.field }
        }
      }

      const a = deltaResult.success
      const b = yield* Vfs.diffSnapshots(base, theirs)
      const merged = yield* phase("merge", Vfs.mergeSnapshotDeltas(base, a, b))
      assert.equal(merged.conflicts.length, 0)

      const restored = yield* Vfs.fromSnapshot(
        yield* Vfs.applySnapshotDelta(base, merged.delta),
        kind === "bounded" ? boundedQuotas : quotas
      )

      const reader = yield* restored.caller()
      assert.deepEqual(yield* reader.readFile("/f0"), new Uint8Array([1]))
      assert.deepEqual(yield* reader.readFile("/f1"), new Uint8Array([2]))
      global.gc()
      sample()
    }

    if (kind === "adapter") {
      const fs = yield* Memory.bind(volume)
      yield* phase(
        "adapter-read",
        Effect.gen(function*() {
          for (let index = 0; index < size; index++) assert.equal((yield* fs.readFile(`/f${index}`)).length, 4096)
        })
      )
    }

    return { entries: count, populatedMemory }
  }

  if (kind === "admission") {
    const registered = yield* Deferred.make()
    const release = yield* Deferred.make()

    const watching = yield* volume.watch().pipe(
      withVolumeTestSeams({
        afterSubscribe: Deferred.succeed(registered, undefined).pipe(Effect.andThen(Deferred.await(release)))
      }),
      Effect.forkChild({ startImmediately: true })
    )

    yield* Deferred.await(registered)
    const waiting = []

    for (let index = 0; index < 64; index++) {
      waiting.push(yield* caller.stat("/").pipe(Effect.forkChild({ startImmediately: true })))
    }

    yield* Effect.yieldNow
    yield* phase(
      "full-admission-rejections",
      Effect.gen(function*() {
        for (let index = 0; index < size; index++) {
          const error = yield* Effect.flip(caller.mkdir("/rejected"))
          assert.equal(error.code, "VolumeBusy")
          sample()
        }
      })
    )
    yield* Deferred.succeed(release, undefined)
    const registeredWatch = yield* Fiber.join(watching)

    assert.ok(registeredWatch)

    for (const fiber of waiting) yield* Fiber.join(fiber)
    yield* caller.mkdir("/recovered")
    assert.equal((yield* caller.readDirectory("/")).value.length, 1)

    return { admitted: 65, rejected: size, recovered: true, controlledGate: true }
  }

  if (kind === "contention") {
    yield* caller.writeFile("/f", new Uint8Array(4096), writeOptions)
    let succeeded = 0
    let rejected = 0
    const latencies = []
    yield* phase(
      "competing-operations",
      Effect.forEach(Array.from({ length: 1000 }, (_, i) => i), (index) =>
        Effect.gen(function*() {
          const start = performance.now()

          const result = yield* Effect.result(
            index % 4 === 0
              ? caller.writeFile("/f", new Uint8Array(4096).fill(index % 256), writeOptions)
              : caller.readFile("/f")
          )

          latencies.push(performance.now() - start)

          if (Result.isFailure(result)) {
            assert.equal(result.failure.code, "VolumeBusy")
            rejected++
          } else {
            succeeded++

            if (index % 4 !== 0) assert.equal(result.success.length, 4096)
          }

          sample()
        }), { concurrency: size })
    )
    assert.equal(succeeded + rejected, 1000)
    assert.ok(succeeded > 0)

    if (size === 8) assert.equal(rejected, 0)

    latencies.sort((a, b) => a - b)

    return { succeeded, rejected, p50Ms: latencies[500], p95Ms: latencies[950] }
  }

  const watch = yield* volume.watch()
  yield* phase(
    "stalled-watch-writes",
    Effect.gen(function*() {
      for (let index = 0; index < size; index++) {
        yield* caller.writeFile("/f", new Uint8Array([index % 256]), writeOptions)

        if (index % 100 === 0) sample()
      }
    })
  )
  const events = yield* phase("drain-overflow", Stream.runCollect(Stream.take(watch, 256)))
  assert.equal(events.length, 256)
  assert.equal(events[255]._tag, "Rescan")
  const recovered = yield* phase("rescan", caller.readFile("/f"))
  assert.equal(recovered[0], (size - 1) % 256)
  yield* caller.writeFile("/f", new Uint8Array([42]), writeOptions)
  const next = yield* Stream.runCollect(Stream.take(watch, 1))
  assert.equal(next[0]._tag, "Update")

  return { writes: size, retainedEvents: events.length, recovered: true }
})

if (process.argv[2] === "--worker") {
  const scenario = process.argv[3]
  // One same-input warmup, then collect after its resources and references are released.
  await Effect.runPromise(workload(scenario).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)))
  samples.length = 0
  phases.length = 0
  await setImmediate()
  global.gc()
  await setImmediate()
  global.gc()
  const baseline = memory()
  const start = performance.now()
  const facts = await Effect.runPromise(workload(scenario).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)))
  const elapsedMs = performance.now() - start
  await setImmediate()
  global.gc()
  await setImmediate()
  global.gc()
  const afterCleanup = memory()

  const sampledPeak = Object.fromEntries(
    Object.keys(baseline).map((key) => [key, Math.max(baseline[key], ...samples.map((s) => s[key]))])
  )

  console.log(
    JSON.stringify({
      scenario,
      elapsedMs,
      phases,
      facts,
      baseline,
      sampledPeak,
      afterCleanup,
      processPeakRssBytes: process.resourceUsage().maxRSS * 1024
    })
  )
} else {
  const output = process.argv[2]
  assert.ok(output, "Usage: node --expose-gc scripts/capacity/measure.mjs output.json")
  const results = []

  for (const scenario of scenarios) {
    for (let repeat = 0; repeat < 3; repeat++) {
      const child = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), "--worker", scenario], {
        encoding: "utf8",
        timeout: 120000
      })

      assert.equal(child.status, 0, `${scenario}: ${child.stderr || child.error}`)
      results.push({ repeat, ...JSON.parse(child.stdout) })
    }

    console.error(`Measured ${scenario}`)
  }

  const commit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()
  writeFileSync(
    output,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        commit,
        sourceDigests: Object.fromEntries(
          [
            "packages/core/src/internal/virtualFileSystem.ts",
            "packages/core/src/internal/directoryEntries.ts",
            "packages/core/src/internal/inodeTable.ts",
            "packages/core/dist/internal/virtualFileSystem.js",
            "packages/core/dist/internal/directoryEntries.js",
            "scripts/capacity/measure.mjs"
          ].flatMap((path) => existsSync(new URL(`../../${path}`, import.meta.url))
            ? [[path, createHash("sha256").update(readFileSync(new URL(`../../${path}`, import.meta.url))).digest("hex")]]
            : [])
        ),
        node: process.version,
        effect:
          JSON.parse(readFileSync(new URL("../../node_modules/effect/package.json", import.meta.url), "utf8")).version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0].model,
        hardwareThreads: cpus().length,
        totalMemoryBytes: totalmem(),
        warmups: 1,
        repetitions: 3,
        quotas: {
          maxBytes: 134217728,
          maxFileBytes: 67108864,
          maxEntries: 12000,
          maxPathBytes: 4096,
          maxPendingOperations: 64,
          maxWatchEvents: 256
        },
        results
      },
      null,
      2
    ) + "\n"
  )
}
