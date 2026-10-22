// Qualify the real Node routing boundary, including native callbacks and promise wrappers.
/* eslint-disable effecttsgo/async-function, effecttsgo/node-builtin-import, effecttsgo/new-promise */
import { BytePath } from "@effect-vfs/core"
import * as Effect from "effect/Effect"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import { setImmediate } from "node:timers/promises"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { mount, type Mounted } from "./fixture.js"

const mounted: Array<Mounted> = []

const make = async (options?: Parameters<typeof mount>[0]) => {
  const fixture = await mount(options)
  mounted.push(fixture)

  return fixture
}

afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.close()
})

describe("mounted node:fs", () => {
  it("should share writes, links and bigint metadata with Effect callers", async () => {
    const m = await make()
    fs.mkdirSync(m.path("/tree"))
    fs.writeFileSync(m.path("/tree/file"), "Node")
    expect(Buffer.from(await Effect.runPromise(m.caller.readFile("/tree/file"))).toString()).toBe("Node")
    await Effect.runPromise(
      m.caller.writeFile("/tree/file", Buffer.from("Effect"), { access: "write", create: "never", truncate: true })
    )
    expect(await fsp.readFile(m.path("/tree/file"), "utf8")).toBe("Effect")
    await fsp.link(m.path("/tree/file"), m.path("/hard"))
    fs.symlinkSync("tree/file", m.path("/sym"))
    expect(fs.readlinkSync(m.path("/sym"))).toBe("tree/file")
    expect(fs.realpathSync(m.path("/sym"))).toBe(m.path("/tree/file"))
    expect(fs.lstatSync(m.path("/sym")).isSymbolicLink()).toBe(true)
    const info = await Effect.runPromise(m.caller.stat("/hard"))
    expect(fs.statSync(m.path("/hard"), { bigint: true }).ino).toBe(info.ino)
    expect(fs.readdirSync(m.path("/tree"), { withFileTypes: true })[0]?.isFile()).toBe(true)
  })

  it("should route callback APIs and return asynchronous errors once", async () => {
    const m = await make()
    await promisify(fs.writeFile)(m.path("/file"), "callback")
    await promisify(fs.appendFile)(m.path("/file"), "+")
    expect(await promisify(fs.readFile)(m.path("/file"), "utf8")).toBe("callback+")
    let synchronous = true
    let calls = 0

    const failed = new Promise<void>((resolve) => {
      fs.open(m.path("/missing"), "r", (cause) => {
        calls++
        expect(synchronous).toBe(false)
        expect(cause).toMatchObject({ code: "ENOENT", syscall: "open" })
        resolve()
      })
    })

    synchronous = false
    await failed
    await setImmediate()
    expect(calls).toBe(1)
    const fd = m.ownFd(await promisify(fs.open)(m.path("/file"), "r"))
    const buffer = Buffer.alloc(8)
    expect((await promisify(fs.read)(fd, buffer, 0, 8, 0)).bytesRead).toBe(8)
    expect(buffer.toString()).toBe("callback")
  })

  it("should preserve numeric flags, positioned cursors, append and truncation", async () => {
    const m = await make()
    const fd = m.ownFd(fs.openSync(m.path("/file"), fs.constants.O_CREAT | fs.constants.O_RDWR, 0o600))
    fs.writeSync(fd, "abcdef")
    fs.ftruncateSync(fd, 2)
    fs.writeSync(fd, "Z")
    expect(fs.readFileSync(m.path("/file"))).toEqual(Buffer.from([97, 98, 0, 0, 0, 0, 90]))
    const handle = m.ownHandle(await fsp.open(m.path("/file"), "r+"))
    const first = Buffer.alloc(1)
    await handle.read(first, 0, 1, 1)
    expect(first.toString()).toBe("b")
    await handle.read(first, 0, 1, null)
    expect(first.toString()).toBe("a")
    await handle.writev([Buffer.from("x"), Buffer.from("y")], 0)
    await handle.sync()
    await handle.datasync()
    expect((await handle.stat({ bigint: true })).size).toBe(7n)
    const append = m.ownHandle(await fsp.open(m.path("/file"), "a+"))
    await append.write("!", 0)
    expect((await fsp.readFile(m.path("/file"), "utf8")).endsWith("!")).toBe(true)
    expect(() => fs.openSync(m.path("/file"), "wx")).toThrow(expect.objectContaining({ code: "EEXIST" }))
    expect(() => fs.openSync(m.path("/file"), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)).toThrow(
      expect.objectContaining({ code: "ENOTDIR" })
    )
    fs.symlinkSync("file", m.path("/sym"))
    expect(() => fs.openSync(m.path("/sym"), fs.constants.O_NOFOLLOW)).toThrow(
      expect.objectContaining({ code: "ELOOP" })
    )
    await expect(fsp.readFile(m.path("/missing"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(() => fs.statSync(m.path("/file/child"))).toThrow(expect.objectContaining({ code: "ENOENT" }))
  })

  it("should keep open objects alive across unlink and rename replacement", async () => {
    const m = await make()
    fs.writeFileSync(m.path("/old"), "old")
    fs.writeFileSync(m.path("/new"), "new")
    const fd = m.ownFd(fs.openSync(m.path("/new"), "r"))
    const handle = m.ownHandle(await fsp.open(m.path("/old"), "r"))
    fs.renameSync(m.path("/old"), m.path("/new"))
    fs.unlinkSync(m.path("/new"))
    expect(fs.readFileSync(fd, "utf8")).toBe("new")
    expect(await handle.readFile("utf8")).toBe("old")
    expect(fs.fstatSync(fd).nlink).toBe(0)
    expect((await Effect.runPromise(m.volume.usage)).usedBytes).toBe(6n)
    await m.close()
    expect((await Effect.runPromise(m.volume.usage)).usedBytes).toBe(0n)
    expect(() => fs.fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }))
    expect(() => fs.statSync(m.path("/"))).toThrow()
  })

  it("should enforce readonly and text-name limits through global routing", async () => {
    const m = await make({ readonly: true })
    await Effect.runPromise(
      m.caller.writeFile("/file", Buffer.from("shared"), { access: "write", create: "exclusive" })
    )
    expect(fs.readFileSync(m.path("/file"), "utf8")).toBe("shared")
    await expect(fsp.writeFile(m.path("/file"), "no")).rejects.toMatchObject({ code: "EROFS" })
    const handle = m.ownHandle(await fsp.open(m.path("/file"), "r"))
    await expect(handle.truncate(0)).rejects.toMatchObject({ code: "EROFS" })
    expect(() => fs.watch(m.path("/file"))).toThrow()
    await Effect.runPromise(
      m.caller.writeFile(await Effect.runPromise(BytePath.fromBytes(new Uint8Array([47, 255]))), Buffer.from("byte"), {
        access: "write",
        create: "exclusive"
      })
    )
    expect(() => fs.readdirSync(m.path("/"), { encoding: "buffer" })).toThrow(
      expect.objectContaining({ code: "EILSEQ" })
    )
  })
})

it.each(["sync", "callback", "promise"] as const)(
  "should enforce exclusive creation and append flags through %s APIs",
  async (api) => {
    const m = await make()

    const write = async (flag: string, text: string) => {
      if (api === "sync") fs.writeFileSync(m.path("/file"), text, { flag })
      else if (api === "callback") await promisify(fs.writeFile)(m.path("/file"), text, { flag })
      else await fsp.writeFile(m.path("/file"), text, { flag })
    }

    await write("wx", "first")
    await expect(write("wx", "replacement")).rejects.toMatchObject({ code: "EEXIST" })
    await write("a", "+append")
    expect(fs.readFileSync(m.path("/file"), "utf8")).toBe("first+append")
    await fsp.copyFile(m.path("/file"), m.path("/copy"))
    await expect(fsp.copyFile(m.path("/file"), m.path("/copy"), fs.constants.COPYFILE_EXCL)).rejects.toMatchObject({
      code: "EEXIST",
      syscall: "copyfile"
    })
    await fsp.chmod(m.path("/copy"), 0o600)
    await fsp.utimes(m.path("/copy"), 12, 13)
    expect(fs.statSync(m.path("/copy"))).toMatchObject({ mode: 0o100600, atimeMs: 12000, mtimeMs: 13000 })
  }
)
