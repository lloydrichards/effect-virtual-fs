// Native stream events and promises are the behavior under test.
/* eslint-disable effecttsgo/async-function, effecttsgo/node-builtin-import, effecttsgo/new-promise */
import * as Effect from "effect/Effect"
import { once } from "node:events"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import { Readable } from "node:stream"
import { finished, pipeline } from "node:stream/promises"
import { setImmediate } from "node:timers/promises"
import { expect, it } from "vitest"
import { mount } from "./fixture.js"

it("should stream through paths, numeric descriptors and promise handles", async () => {
  const m = await mount()

  try {
    const output = m.ownStream(fs.createWriteStream(m.path("/file"), { highWaterMark: 2 }))
    await pipeline(Readable.from(["abc", "def", "ghi"]), output)
    const read = m.ownStream(fs.createReadStream(m.path("/file"), { start: 2, end: 5, highWaterMark: 2 }))
    const chunks: Array<Buffer> = []

    for await (const chunk of read) chunks.push(Buffer.from(chunk))

    expect(Buffer.concat(chunks).toString()).toBe("cdef")
    const fd = m.ownFd(fs.openSync(m.path("/file"), "r"))
    const descriptor = m.ownStream(fs.createReadStream(m.path("/file"), { fd, autoClose: false, start: 6 }))
    const tail: Array<Buffer> = []

    for await (const chunk of descriptor) tail.push(Buffer.from(chunk))

    expect(Buffer.concat(tail).toString()).toBe("ghi")
    expect(fs.fstatSync(fd).size).toBe(9)
    const handle = m.ownHandle(await fsp.open(m.path("/file"), "a+"))
    const writer = m.ownStream(handle.createWriteStream({ autoClose: false }))
    writer.end("!")
    await finished(writer, { cleanup: true })
    const readerHandle = m.ownHandle(await fsp.open(m.path("/file"), "r"))
    const reader = m.ownStream(readerHandle.createReadStream({ autoClose: false }))
    const all: Array<Buffer> = []

    for await (const chunk of reader) all.push(Buffer.from(chunk))

    expect(Buffer.concat(all).toString()).toBe("abcdefghi!")
    expect(Buffer.from(await Effect.runPromise(m.caller.readFile("/file"))).toString()).toBe("abcdefghi!")
  } finally {
    await m.close()
  }
})

it("should destroy failed and aborted streams without later writes", async () => {
  const m = await mount()

  try {
    const missing = fs.createReadStream(m.path("/missing"))
    await expect(finished(missing, { cleanup: true })).rejects.toMatchObject({ code: "ENOENT" })
    expect(missing.closed).toBe(true)
    const output = fs.createWriteStream(m.path("/file"), { highWaterMark: 1 })
    const opened = once(output, "open")
    const done = finished(output, { cleanup: true })
    await opened
    output.write("committed")
    const closed = new Promise<void>((resolve) => output.once("close", resolve))
    output.destroy(new Error("stop"))
    await expect(done).rejects.toThrow("stop")
    await closed
    const before = fs.readFileSync(m.path("/file"))
    await setImmediate()
    expect(fs.readFileSync(m.path("/file"))).toEqual(before)
    expect(output.closed).toBe(true)
    const controller = new AbortController()
    const aborted = fs.createReadStream(m.path("/file"), { signal: controller.signal })
    const stopped = finished(aborted, { cleanup: true })
    controller.abort()
    await expect(stopped).rejects.toMatchObject({ name: "AbortError" })
    expect(aborted.closed).toBe(true)
  } finally {
    await m.close()
  }
})

it("should drain streams that are still opening before returning from teardown", async () => {
  const m = await mount()
  const writer = m.ownStream(fs.createWriteStream(m.path("/pending")))
  writer.write("queued")
  await m.close()
  expect(writer.closed).toBe(true)
  const bytes = await Effect.runPromise(m.caller.readFile("/pending"))
  await setImmediate()
  expect(await Effect.runPromise(m.caller.readFile("/pending"))).toEqual(bytes)
})
