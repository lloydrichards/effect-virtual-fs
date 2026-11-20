// The timed operation is a complete native stream pipeline through a mounted provider.
/* eslint-disable effecttsgo/async-function, effecttsgo/node-builtin-import */
import { createReadStream, createWriteStream, readFileSync } from "node:fs"
import { Readable, Writable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { create } from "node:vfs"
import { expect, test } from "vitest"
import { mount, type Mountable } from "../mounted/fixture.js"

const chunkSize = 64 * 1024

const payload = Buffer.alloc(8 * 1024 * 1024)

const chunks = Array.from(
  { length: payload.length / chunkSize },
  (_, index) => payload.subarray(index * chunkSize, (index + 1) * chunkSize).fill(index + 1)
)

const read = async (path: string) => {
  let transferred = 0

  await pipeline(
    createReadStream(path, { highWaterMark: chunkSize }),
    new Writable({
      highWaterMark: chunkSize,
      write(chunk: Buffer, _encoding, done) {
        transferred += chunk.length
        done()
      }
    })
  )

  return transferred
}

const write = (path: string) =>
  pipeline(
    Readable.from(chunks, { objectMode: false, highWaterMark: chunkSize }),
    createWriteStream(path, { highWaterMark: chunkSize })
  )

const workloads = [
  { name: "stream read 8 MiB in 64 KiB chunks", run: read },
  { name: "stream write 8 MiB in 64 KiB chunks", run: write }
]

test.for(workloads.flatMap((workload) => [1, 2].map((round) => ({ ...workload, round }))))(
  "$name (round $round)",
  async ({ round, run }, { bench, onTestFinished }) => {
    const effect = await mount()
    onTestFinished(() => effect.close())

    // SAFETY: Node 26.11.1 exposes mount and unmount on the VFS instance.
    const node = create() as Mountable
    const nodeRoot = node.mount()
    onTestFinished(() => node.unmount())
    const effectPath = effect.path("/stream.bin")
    const nodePath = `${nodeRoot}/stream.bin`

    for (const path of [effectPath, nodePath]) {
      await write(path)

      if (run === read) {
        const received: Array<Buffer> = []

        for await (const chunk of createReadStream(path, { highWaterMark: chunkSize })) received.push(chunk)
        expect(Buffer.concat(received).equals(payload)).toBe(true)
        expect(await read(path)).toBe(payload.length)
      } else {
        expect(readFileSync(path).equals(payload)).toBe(true)
      }
    }

    const candidates = [
      bench("Effect VFS provider", { async: true }, () => run(effectPath)),
      bench("Node MemoryProvider", { async: true }, () => run(nodePath))
    ]

    if (round === 2) candidates.reverse()
    await bench.compare(...candidates, { time: 500 })

    if (run === write) {
      for (const path of [effectPath, nodePath]) expect(readFileSync(path).equals(payload)).toBe(true)
    }
  }
)
