/* eslint-disable effecttsgo/node-builtin-import -- This benchmark measures file-content models outside the VFS runtime. */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { cpus, release, totalmem } from "node:os"
import { fileURLToPath } from "node:url"

const kib = 1_024

const mib = 1_024 * kib

const dense = {
  make: (size) => new Uint8Array(size),
  write(bytes, position, input) {
    const next = new Uint8Array(Math.max(bytes.length, position + input.length))
    next.set(bytes)
    next.set(input, position)

    return { contents: next, allocated: next.length, copied: bytes.length }
  },
  export: (bytes) => bytes.slice()
}

const paged = (pageSize) => ({
  make: (size) => ({
    size,
    pages: Array.from({ length: Math.ceil(size / pageSize) }, () => new Uint8Array(pageSize))
  }),
  write({ size, pages }, position, input) {
    const nextSize = Math.max(size, position + input.length)
    const next = pages.slice()
    let allocated = 0
    let copied = 0

    // These workloads write within the file or append without a gap.
    for (let offset = 0; offset < input.length;) {
      const index = Math.floor((position + offset) / pageSize)
      const start = (position + offset) % pageSize
      const count = Math.min(input.length - offset, pageSize - start)
      const previous = pages[index]
      const page = new Uint8Array(pageSize)

      if (previous !== undefined && count < pageSize) {
        page.set(previous)
        copied += previous.length
      }

      page.set(input.subarray(offset, offset + count), start)
      next[index] = page
      allocated += page.length
      offset += count
    }

    return { contents: { size: nextSize, pages: next }, allocated, copied }
  },
  export({ size, pages }) {
    const bytes = new Uint8Array(size)

    for (const [index, page] of pages.entries()) {
      const offset = index * pageSize
      bytes.set(page.subarray(0, size - offset), offset)
    }

    return bytes
  }
})

const models = { dense, "pages-4k": paged(4 * kib), "pages-64k": paged(64 * kib) }

const trial = (model, scenario, sizeMiB) => {
  const storage = models[model]
  const partial = scenario === "partial"
  const input = new Uint8Array(partial ? 4 * kib : mib).fill(7)
  const initialSize = partial ? sizeMiB * mib : 0
  let contents = storage.make(initialSize)
  // Retain the initial generation to check that the writes preserve its bytes.
  const previous = contents
  const latencies = []
  const samples = [process.memoryUsage()]
  let allocated = 0
  let copied = 0

  for (let index = 0; index < (partial ? 100 : sizeMiB); index++) {
    const start = performance.now()
    const next = storage.write(contents, partial ? 0 : index * input.length, input)
    latencies.push(performance.now() - start)
    contents = next.contents
    allocated += next.allocated
    copied += next.copied
    samples.push(process.memoryUsage())
  }

  latencies.sort((a, b) => a - b)
  const writePeakRssBytes = process.resourceUsage().maxRSS * kib
  const start = performance.now()
  const exported = storage.export(contents)
  const exportMs = performance.now() - start
  const exportPeakRssBytes = process.resourceUsage().maxRSS * kib

  assert.equal(exported.length, sizeMiB * mib)
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
  const digest = hash(exported)

  // Compute expected identities after collecting memory measurements.
  const expected = new Uint8Array(exported.length)
  expected.fill(7, 0, partial ? input.length : expected.length)
  assert.equal(digest, hash(expected))
  assert.equal(hash(storage.export(previous)), hash(new Uint8Array(initialSize)))

  return {
    model,
    scenario,
    sizeMiB,
    operations: latencies.length,
    p50Ms: latencies[Math.floor(latencies.length * 0.5)],
    p95Ms: latencies[Math.floor(latencies.length * 0.95)],
    exportMs,
    allocated,
    copied,
    writePeakRssBytes,
    exportPeakRssBytes,
    sampledRssBytes: Math.max(...samples.map(({ rss }) => rss)),
    sampledHeapUsedBytes: Math.max(...samples.map(({ heapUsed }) => heapUsed)),
    digest
  }
}

if (process.argv[2] === "--worker") {
  const [, , , model, scenario, size] = process.argv
  process.stdout.write(JSON.stringify(trial(model, scenario, Number(size))) + "\n")
} else {
  const output = process.argv[2]
  assert.ok(output, "Usage: bun scripts/capacity/file-content-models.mjs output.json")
  const script = fileURLToPath(import.meta.url)
  const results = []

  for (const size of [1, 16, 64]) {
    for (const scenario of ["partial", "growth"]) {
      for (let round = 0; round < 4; round++) {
        const names = Object.keys(models)
        const order = names.slice(round % names.length).concat(names.slice(0, round % names.length))

        for (const model of order) {
          const run = spawnSync(process.execPath, [script, "--worker", model, scenario, String(size)], {
            encoding: "utf8",
            timeout: 120_000
          })

          assert.equal(run.status, 0, run.error?.message ?? run.stderr)

          if (round !== 0) results.push({ round, ...JSON.parse(run.stdout) })
        }
      }
    }
  }

  writeFileSync(
    output,
    JSON.stringify(
      {
        revision: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
        runtime: process.versions.bun ?? process.version,
        platform: process.platform,
        arch: process.arch,
        kernel: release(),
        cpu: cpus()[0]?.model,
        ramBytes: totalmem(),
        results
      },
      null,
      2
    ) + "\n"
  )
}
