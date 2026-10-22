// Exercise native Node arguments and wall-clock timestamps at the JavaScript boundary.
/* eslint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/node-builtin-import */
import { BytePath } from "@effect-vfs/core"
import * as Vfs from "@effect-vfs/core/VirtualFileSystem"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Scope from "effect/Scope"
import { constants } from "node:fs"
import { constants as osConstants } from "node:os"
import { setImmediate } from "node:timers/promises"
import { VirtualProvider } from "node:vfs"
import { afterEach, describe, expect, it } from "vitest"
import * as NodeVfs from "../src/NodeVirtualProvider.js"

const scopes: Array<Scope.Closeable> = []

const make = async (options?: NodeVfs.Options, volumeOptions: Vfs.VolumeOptions = { execution: "sync" }) => {
  const volume = await Effect.runPromise(Vfs.make(volumeOptions).pipe(Effect.provide(NodeCrypto.layer)))
  const scope = Scope.makeUnsafe()
  scopes.push(scope)

  const provider = await Effect.runPromise(
    NodeVfs.bind(volume, options).pipe(Effect.provideService(Scope.Scope, scope))
  )

  const caller = await Effect.runPromise(volume.caller())

  return { volume, scope, provider, caller }
}

afterEach(async () => {
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void))
})

interface ExpectedError {
  code: string
  syscall?: string
  path?: string
}

const error = (code: string, syscall?: string, path?: string) => {
  const expected: ExpectedError = { code }

  if (syscall !== undefined) expected.syscall = syscall

  if (path !== undefined) expected.path = path

  return expect.objectContaining(expected)
}

describe("direct Node provider", () => {
  it("should share one volume with Effect callers in both directions", async () => {
    const { provider, caller } = await make()
    expect(provider).toBeInstanceOf(VirtualProvider)
    expect(provider.supportsSymlinks).toBe(true)
    expect(provider.supportsWatch).toBe(false)
    provider.writeFileSync("/file", "node")
    expect(Buffer.from(await Effect.runPromise(caller.readFile("/file"))).toString()).toBe("node")
    await Effect.runPromise(caller.writeFile("/file", Buffer.from("effect"), { access: "write", truncate: true }))
    expect(await provider.readFile("/file", "utf8")).toBe("effect")
  })
  it("should reject cooperative, copied and malformed inputs", async () => {
    const { scope, volume: eligible } = await make()
    const volume = await Effect.runPromise(Vfs.make().pipe(Effect.provide(NodeCrypto.layer)))

    const bind = (candidate: Vfs.Volume) =>
      Effect.runPromise(Effect.result(NodeVfs.bind(candidate)).pipe(Effect.provideService(Scope.Scope, scope)))

    expect(await bind(volume)).toMatchObject({ _tag: "Failure", failure: { code: "InvalidArgument", field: "volume" } })
    expect(await bind({ ...eligible })).toMatchObject({ _tag: "Failure", failure: { code: "InvalidArgument" } })
    // SAFETY: Deliberately bypass types to test the public decoder.
    expect(
      await Effect.runPromise(
        Effect.result(NodeVfs.bind(eligible, { readonly: "yes" } as never)).pipe(
          Effect.provideService(Scope.Scope, scope)
        )
      )
    ).toMatchObject({ _tag: "Failure", failure: { code: "InvalidArgument", field: "options" } })
  })
  it("should bind overlays to their existing engine", async () => {
    const { volume, provider, scope } = await make()
    provider.writeFileSync("/file", "base")

    const overlay = await Effect.runPromise(
      Vfs.makeOverlay(await Effect.runPromise(volume.snapshot), { execution: "sync" }).pipe(
        Effect.provide(NodeCrypto.layer)
      )
    )

    const other = await Effect.runPromise(NodeVfs.bind(overlay).pipe(Effect.provideService(Scope.Scope, scope)))
    other.writeFileSync("/file", "overlay")
    expect(other.readFileSync("/file", "utf8")).toBe("overlay")
    expect(provider.readFileSync("/file", "utf8")).toBe("base")
  })
  it("should decode numeric flags without implicit creation or truncation", async () => {
    const { provider } = await make()
    provider.writeFileSync("/file", "abc")
    const handle = provider.openSync("/file", constants.O_WRONLY)
    handle.writeSync(Buffer.from("X"))
    handle.closeSync()
    expect(provider.readFileSync("/file", "utf8")).toBe("Xbc")
    expect(() => provider.openSync("/absent", constants.O_WRONLY)).toThrow(error("ENOENT", "open", "/absent"))
    const created = provider.openSync("/new", constants.O_RDONLY | constants.O_CREAT)
    expect(created.readFileSync("utf8")).toBe("")
    expect(() => created.writeSync(Buffer.from("x"))).toThrow(error("EBADF"))
    created.closeSync()
    expect(() => provider.openSync("/file", "wx")).toThrow(error("EEXIST"))
    expect(provider.readFileSync("/file", "utf8")).toBe("Xbc")
  })
  it.each([0x40000000, 3, -1, 2 ** 32, "bad"])("should reject unsupported flags %s before mutation", async (flags) => {
    const { provider } = await make()
    expect(() => provider.openSync("/new", flags)).toThrow(error("EINVAL", "open"))
    await expect(provider.open("/new", flags)).rejects.toMatchObject({ code: "EINVAL" })
    await setImmediate()
    expect(provider.existsSync("/new")).toBe(false)
  })
  it("should enforce final-component noFollow and support directory handles", async () => {
    const { provider } = await make()
    provider.mkdirSync("/dir")
    provider.writeFileSync("/dir/file", "x")
    provider.symlinkSync("dir", "/parent")
    provider.symlinkSync("dir/file", "/link")
    expect(() => provider.openSync("/link", constants.O_NOFOLLOW)).toThrow(error("ELOOP"))
    const file = provider.openSync("/parent/file", constants.O_NOFOLLOW)
    expect(file.readFileSync("utf8")).toBe("x")
    file.closeSync()
    expect(() => provider.openSync("/dir/file", constants.O_DIRECTORY)).toThrow(error("ENOTDIR"))
    const dir = provider.openSync("/dir", constants.O_DIRECTORY)
    expect(dir.statSync().isDirectory()).toBe(true)
    expect(() => dir.readSync(Buffer.alloc(1))).toThrow(error("EISDIR"))
    dir.closeSync()
    expect(provider.readlinkSync("/link")).toBe("dir/file")
    expect(provider.realpathSync("/parent/file")).toBe("/dir/file")
  })
  it("should keep cursors independent from positioned I/O and truncation", async () => {
    const { provider } = await make()
    provider.writeFileSync("/file", "abcdef")
    const handle = provider.openSync("/file", "r+")
    const out = Buffer.alloc(2)
    expect(handle.readSync(out)).toBe(2)
    expect(out.toString()).toBe("ab")
    expect(handle.readSync(out, 0, 2, 4)).toBe(2)
    expect(out.toString()).toBe("ef")
    expect(handle.position).toBe(2)
    expect(handle.readSync(out, 0, 2, 0x7fffffffffffffffn)).toBe(0)
    expect(handle.position).toBe(2)
    expect(() => handle.readSync(out, 0, 2, 0x8000000000000000n)).toThrow(error("EINVAL"))
    handle.writeSync(Buffer.from("X"), 0, 1, 5)
    expect(handle.position).toBe(2)
    handle.truncateSync(1)
    expect(handle.position).toBe(2)
    expect(handle.readSync(out)).toBe(0)
    handle.truncateSync(5)
    expect(handle.position).toBe(2)
    handle.writeSync(Buffer.from("Y"))
    expect(provider.readFileSync("/file")).toEqual(Buffer.from([97, 0, 89, 0, 0]))
    handle.closeSync()
  })
  it("should append at EOF with explicit positions while preserving the cursor", async () => {
    const { provider } = await make()
    provider.writeFileSync("/file", "a")
    const handle = provider.openSync("/file", "a+")
    handle.writeSync(Buffer.from("b"), 0, 1, 0)
    expect(handle.position).toBe(0)
    handle.writeSync(Buffer.from("c"))
    expect(handle.position).toBe(3)
    expect(provider.readFileSync("/file", "utf8")).toBe("abc")
    handle.closeSync()
  })
  it("should handle EOF, zero lengths and independent opens", async () => {
    const { provider } = await make()
    provider.writeFileSync("/file", "abc")
    const first = provider.openSync("/file", "r+"), second = provider.openSync("/file", "r+")
    const buffer = Buffer.alloc(1)
    first.readSync(buffer)
    expect(first.position).toBe(1)
    expect(second.position).toBe(0)
    expect(first.writeSync(Buffer.alloc(0), 0, 0, 99)).toBe(0)
    expect(first.statSync().size).toBe(3)
    expect(first.readSync(buffer, 0, 0)).toBe(0)
    expect(first.position).toBe(1)
    first.position = 10
    expect(first.readSync(buffer)).toBe(0)
    first.closeSync()
    second.closeSync()
  })
  it("should expose vector counts and promise result objects", async () => {
    const { provider } = await make()
    const handle = await provider.open("/file", "w+")
    const buffers = [Buffer.from("ab"), Buffer.from("cd")]
    expect(await handle.writev(buffers)).toEqual({ bytesWritten: 4, buffers })
    expect(handle.position).toBe(4)
    const output = [Buffer.alloc(1), Buffer.alloc(4)]
    expect(await handle.readv(output, 1)).toEqual({ bytesRead: 3, buffers: output })
    expect(Buffer.concat(output).subarray(0, 3).toString()).toBe("bcd")
    expect(handle.position).toBe(4)
    const buffer = Buffer.alloc(1)
    expect(await handle.read(buffer, 0, 1, 0)).toEqual({ bytesRead: 1, buffer })
    expect(await handle.write(Buffer.from("z"), 0, 1, 0)).toMatchObject({ bytesWritten: 1 })
    expect(handle.position).toBe(4)
    await handle.close()
  })
  it("should reject invalid ranges and vectors before changing content", async () => {
    const { provider } = await make()
    provider.writeFileSync("/file", "abc")
    const handle = provider.openSync("/file", "r+")
    expect(() => handle.writeSync(Buffer.from("X"), 0, 2)).toThrow(error("EINVAL"))
    expect(() => handle.writeSync(Buffer.from("X"), 0, 1, -2)).toThrow(error("EINVAL"))
    // SAFETY: Deliberately malformed vector input tests validation before any write.
    expect(() => handle.writevSync([Buffer.from("X"), null as never])).toThrow(error("EINVAL"))
    expect(provider.readFileSync("/file", "utf8")).toBe("abc")
    handle.closeSync()
  })
  it("should retain unlinked and replaced objects until the last close", async () => {
    const { provider, volume } = await make()
    provider.writeFileSync("/file", "old")
    const handle = provider.openSync("/file", "r+")
    provider.linkSync("/file", "/alias")
    handle.writeSync(Buffer.from("O"), 0, 1, 0)
    expect(provider.readFileSync("/alias", "utf8")).toBe("Old")
    provider.writeFileSync("/replacement", "new")
    provider.renameSync("/replacement", "/file")
    provider.unlinkSync("/alias")
    expect(handle.statSync().nlink).toBe(0)
    expect(handle.readFileSync("utf8")).toBe("Old")
    expect(provider.readFileSync("/file", "utf8")).toBe("new")
    expect((await Effect.runPromise(volume.usage)).usedBytes).toBe(6n)
    handle.closeSync()
    expect((await Effect.runPromise(volume.usage)).usedBytes).toBe(3n)
    expect(() => handle.statSync()).toThrow(error("EBADF"))
    expect(() => handle.closeSync()).toThrow(error("EBADF"))
  })
  it("should finalize handles and reject use after the provider scope closes", async () => {
    const { provider, volume, scope } = await make()
    provider.writeFileSync("/file", "owned")
    const handle = provider.openSync("/file", "r+")
    provider.unlinkSync("/file")
    await Effect.runPromise(Scope.close(scope, Exit.void))
    expect(handle.closed).toBe(true)
    expect(() => handle.readSync(Buffer.alloc(1))).toThrow(error("EBADF"))
    expect(() => provider.mkdirSync("/later")).toThrow(error("EBADF"))
    expect((await Effect.runPromise(volume.usage)).usedBytes).toBe(0n)
  })
  it("should preserve bigint metadata and no-follow directory kinds", async () => {
    const { provider, caller } = await make()
    provider.writeFileSync("/file", "123")
    provider.symlinkSync("file", "/sym")
    await Effect.runPromise(
      caller.utimes("/file", {
        access: { kind: "value", nanoseconds: 1234567890123456789n },
        modification: { kind: "value", nanoseconds: 1234567890123456790n }
      })
    )
    const stat = provider.statSync("/file", { bigint: true })
    expect(stat).toMatchObject({
      size: 3n,
      nlink: 1n,
      atimeNs: 1234567890123456789n,
      mtimeNs: 1234567890123456790n,
      mode: 0o100644n
    })
    expect(stat.isFile()).toBe(true)
    expect(provider.lstatSync("/sym").isSymbolicLink()).toBe(true)
    const entries = provider.readdirSync("/", { withFileTypes: true })
    expect(entries).toEqual([
      expect.objectContaining({ name: "file", parentPath: "/" }),
      expect.objectContaining({ name: "sym", parentPath: "/" })
    ])
    expect(provider.readdirSync("/", { encoding: "buffer" })).toEqual([Buffer.from("file"), Buffer.from("sym")])
  })
  it("should apply metadata hooks to open objects and symlinks independently", async () => {
    const { provider } = await make()
    provider.writeFileSync("/file", "x")
    provider.symlinkSync("file", "/sym")
    provider.chmodSync("/file", 0o600)
    provider.lchownSync("/sym", 31, 32)
    provider.lutimesSync("/sym", 10, 20)
    expect(provider.statSync("/file").mode).toBe(0o100600)
    expect(provider.lstatSync("/sym")).toMatchObject({ uid: 31, gid: 32, mtimeMs: 20000 })
    const handle = provider.openSync("/file", "r+")
    provider.unlinkSync("/file")
    await handle.chmod(0o640)
    await handle.chown(21, 22)
    await handle.chown(-1, 22)
    await handle.utimes(30, 40)
    await handle.sync()
    await handle.datasync()
    expect(await handle.stat()).toMatchObject({ mode: 0o100640, uid: 21, gid: 22, atimeMs: 30000, mtimeMs: 40000 })
    handle.closeSync()
  })
  it.each(["provider", "symlink", "handle"] as const)(
    "should use current time for negative numbers through %s timestamp hooks",
    async (target) => {
      const { provider } = await make()
      provider.writeFileSync("/file", "x")
      provider.symlinkSync("file", "/sym")
      const handle = provider.openSync("/file", "r+")

      const stat = () =>
        target === "symlink" ? provider.lstatSync("/sym", { bigint: true }) : handle.statSync({ bigint: true })

      const before = BigInt(Date.now())

      if (target === "provider") provider.utimesSync("/file", -1, -1)
      else if (target === "symlink") provider.lutimesSync("/sym", -1, -1)
      else handle.utimesSync(-1, -1)

      expect(stat().atimeMs).toBeGreaterThanOrEqual(before)
      expect(stat().atimeMs).toBeLessThanOrEqual(BigInt(Date.now()))
      expect(stat().mtimeMs).toBeGreaterThanOrEqual(before)
      expect(stat().mtimeMs).toBeLessThanOrEqual(BigInt(Date.now()))

      if (target === "provider") await provider.utimes("/file", -1, -1)
      else if (target === "symlink") await provider.lutimes("/sym", -1, -1)
      else await handle.utimes(-1, -1)

      expect(stat().atimeMs).toBeGreaterThanOrEqual(before)
      expect(stat().atimeMs).toBeLessThanOrEqual(BigInt(Date.now()))
      expect(stat().mtimeMs).toBeGreaterThanOrEqual(before)
      expect(stat().mtimeMs).toBeLessThanOrEqual(BigInt(Date.now()))

      if (target === "provider") provider.utimesSync("/file", new Date(-1000), "-2")
      else if (target === "symlink") provider.lutimesSync("/sym", new Date(-1000), "-2")
      else handle.utimesSync(new Date(-1000), "-2")

      expect(stat()).toMatchObject({ atimeMs: -1000n, mtimeMs: -2000n })

      if (target === "provider") await provider.utimes("/file", "-3", new Date(-4000))
      else if (target === "symlink") await provider.lutimes("/sym", "-3", new Date(-4000))
      else await handle.utimes("-3", new Date(-4000))

      expect(stat()).toMatchObject({ atimeMs: -3000n, mtimeMs: -4000n })
      handle.closeSync()
    }
  )
  it("should honor caller identity", async () => {
    const { provider } = await make({
      caller: { identity: { uid: 1000, gid: 1000, groups: [], privileged: false }, umask: 0o077 }
    })

    expect(() => provider.writeFileSync("/file", "x")).toThrow(error("EACCES"))
  })
  it("should report Node errno, syscall and both rename paths", async () => {
    const { provider } = await make()
    expect(() => provider.renameSync("/missing", "/dest")).toThrow(
      expect.objectContaining({
        code: "ENOENT",
        errno: -osConstants.errno.ENOENT,
        syscall: "rename",
        path: "/missing",
        dest: "/dest"
      })
    )
    await expect(provider.stat("/missing")).rejects.toMatchObject({ code: "ENOENT", syscall: "stat", path: "/missing" })
  })
  it("should deny readonly mutations without freezing the owner's volume", async () => {
    const { provider: owner, volume, scope } = await make()
    owner.writeFileSync("/file", "x")

    const provider = await Effect.runPromise(
      NodeVfs.bind(volume, { readonly: true }).pipe(Effect.provideService(Scope.Scope, scope))
    )

    const handle = provider.openSync("/file")

    for (
      const mutation of [
        () => provider.writeFileSync("/file", "bad"),
        () => provider.openSync("/new", constants.O_RDONLY | constants.O_CREAT),
        () => provider.mkdirSync("/d"),
        () => provider.unlinkSync("/file"),
        () => provider.renameSync("/file", "/other"),
        () => provider.linkSync("/file", "/alias"),
        () => provider.symlinkSync("file", "/sym"),
        () => provider.chmodSync("/file", 0o600),
        () => provider.chownSync("/file", 1, 1),
        () => provider.utimesSync("/file", 0, 0),
        () => provider.accessSync("/file", constants.W_OK),
        () => handle.chmodSync(0o600),
        () => handle.truncateSync(),
        () => handle.writeSync(Buffer.from("bad"))
      ]
    ) expect(mutation).toThrow(error("EROFS"))
    expect(provider.readFileSync("/file", "utf8")).toBe("x")
    owner.writeFileSync("/file", "owner")
    expect(handle.readFileSync("utf8")).toBe("owner")
    handle.closeSync()
  })
  it("should reject byte paths, lossy text and unrepresentable names", async () => {
    const { provider, caller } = await make()
    expect(() => provider.writeFileSync("/bad\ud800", "x")).toThrow(error("EINVAL"))
    // SAFETY: Buffer paths are deliberately unsupported at the provider boundary.
    expect(() => provider.statSync(Buffer.from("/") as never)).toThrow(error("EINVAL"))
    const raw = Effect.runSync(BytePath.fromBytes(new Uint8Array([47, 255])))
    await Effect.runPromise(caller.writeFile(raw, Buffer.from("x"), { access: "write", create: "exclusive" }))
    expect(() => provider.readdirSync("/")).toThrow(error("EILSEQ"))
    expect(() => provider.readdirSync("/", { encoding: "buffer" })).toThrow(error("EILSEQ"))
  })
  it("should implement derived operations and reject unsupported hooks", async () => {
    const { provider } = await make()
    await provider.mkdir("/dir")
    await provider.writeFile("/dir/file", "a")
    await provider.appendFile("/dir/file", "b")
    await provider.copyFile("/dir/file", "/copy", constants.COPYFILE_EXCL)
    expect(await provider.readFile("/copy", "utf8")).toBe("ab")
    await expect(provider.copyFile("/dir/file", "/copy", constants.COPYFILE_EXCL)).rejects.toMatchObject({
      code: "EEXIST"
    })
    expect(provider.readdirSync("/", { recursive: true })).toEqual(expect.arrayContaining(["copy", "dir", "dir/file"]))
    expect(() => provider.watch()).toThrow(error("ENOSYS"))
    expect(() => provider.watchAsync()).toThrow(error("ENOSYS"))
    const handle = provider.openSync("/copy")
    expect(handle).not.toHaveProperty("fd")

    for (
      const method of [
        "appendFile",
        "chmod",
        "chown",
        "datasync",
        "sync",
        "read",
        "readv",
        "readFile",
        "stat",
        "truncate",
        "utimes",
        "write",
        "writev",
        "writeFile"
      ] as const
    ) expect(handle[method]).toBeTypeOf("function")
    handle.closeSync()
    await provider.unlink("/copy")
    await provider.unlink("/dir/file")
    await provider.rmdir("/dir")
  })
  it("should preserve common namespace failures through both primitive pairs", async () => {
    const { provider } = await make()
    expect(() => provider.writeFileSync("/missing/file", "x")).toThrow(error("ENOENT"))
    await provider.mkdir("/tree/child", { recursive: true })
    await expect(provider.rmdir("/tree")).rejects.toMatchObject({ code: "ENOTEMPTY" })
    await provider.writeFile("/tree/file", "data")
    await provider.symlink("file", "/tree/sym")
    await provider.link("/tree/file", "/tree/hard")
    expect((await provider.lstat("/tree/sym")).isSymbolicLink()).toBe(true)
    expect(await provider.readlink("/tree/sym", {})).toBe("file")
    expect(await provider.realpath("/tree/sym", {})).toBe("/tree/file")
    await provider.access("/tree/file", constants.R_OK)
    await provider.chmod("/tree/file", 0o640)
    await provider.chown("/tree/file", 5, 6)
    await provider.lchmod("/tree/sym", 0o700)
    await provider.lchown("/tree/sym", 7, 8)
    await provider.utimes("/tree/file", 12, 13)
    await provider.lutimes("/tree/sym", 14, 15)
    expect((await provider.stat("/tree/file")).nlink).toBe(2)
    expect(await provider.lstat("/tree/sym")).toMatchObject({ uid: 7, gid: 8, mode: 0o120700, mtimeMs: 15000 })
    expect(await provider.readdir("/tree")).toEqual(expect.arrayContaining(["child", "file", "sym", "hard"]))
    await provider.rename("/tree/hard", "/moved")
    expect(await provider.exists("/moved")).toBe(true)
    provider.symlinkSync("loop", "/loop")
    expect(() => provider.statSync("/loop")).toThrow(error("ELOOP"))
    expect(() => provider.writeFileSync("/tree", "x")).toThrow(error("EISDIR"))
    expect(() => provider.openSync("/tree/file/child")).toThrow(error("ENOTDIR"))
  })

  it("should validate data and encoding before truncation and honor creation umask", async () => {
    const { provider } = await make({ caller: { umask: 0o077 } })
    provider.writeFileSync("/file", "keep")
    expect(provider.statSync("/file").mode).toBe(0o100600)
    // SAFETY: Invalid native input must be rejected before opening a writable handle.
    expect(() => provider.writeFileSync("/file", "erase", "invalid" as never)).toThrow(error("EINVAL"))
    // SAFETY: Test runtime validation rather than the TypeScript caller contract.
    expect(() => provider.writeFileSync("/new", 42 as never)).toThrow(error("EINVAL"))
    expect(provider.existsSync("/new")).toBe(false)
    expect(provider.readFileSync("/file", "utf8")).toBe("keep")
  })
  it("should finish failed writes before returning, including helper truncation already performed", async () => {
    const { provider, volume } = await make(undefined, { execution: "sync", maxFileBytes: ByteSize.bytes(2) })
    provider.writeFileSync("/file", "ok")
    expect(() => provider.writeFileSync("/file", "too long")).toThrow(error("EFBIG", "write"))
    expect(provider.readFileSync("/file", "utf8")).toBe("to")
    await setImmediate()
    expect(provider.readFileSync("/file", "utf8")).toBe("to")
    expect((await Effect.runPromise(volume.usage)).usedBytes).toBe(2n)
  })
  it.each(["sync", "promise"] as const)("should reject every sparse vector slot before %s I/O", async (mode) => {
    const { provider } = await make()
    provider.writeFileSync("/file", "abcdef")
    const handle = provider.openSync("/file", "r+")
    const output = Buffer.alloc(1, 63)
    const reads = new Array<Uint8Array>(2)
    reads[0] = output
    const writes = new Array<Uint8Array>(2)
    writes[0] = Buffer.from("X")

    if (mode === "sync") {
      expect(() => handle.readvSync(reads)).toThrow(error("EINVAL", "readv"))
      expect(() => handle.writevSync(writes)).toThrow(error("EINVAL", "writev"))
    } else {
      await expect(handle.readv(reads)).rejects.toMatchObject({ code: "EINVAL", syscall: "readv" })
      await expect(handle.writev(writes)).rejects.toMatchObject({ code: "EINVAL", syscall: "writev" })
    }

    expect(output).toEqual(Buffer.from("?"))
    expect(handle.position).toBe(0)
    expect(provider.readFileSync("/file", "utf8")).toBe("abcdef")
    handle.closeSync()
  })

  it("should normalize read option forms while preserving buffer identity and positioned cursors", async () => {
    const { provider } = await make()
    provider.writeFileSync("/file", "abcdef")
    const handle = await provider.open("/file", "r+")
    const buffer = Buffer.alloc(4, 46)
    const result = await handle.read({ buffer, offset: 1, length: 2, position: 2 })
    expect(result.buffer).toBe(buffer)
    expect(result.bytesRead).toBe(2)
    expect(buffer.toString()).toBe(".cd.")
    expect(handle.position).toBe(0)
    buffer.fill(46)
    expect(await handle.read(buffer, { offset: 1, length: 2 })).toEqual({ bytesRead: 2, buffer })
    expect(buffer.toString()).toBe(".ab.")
    expect(handle.position).toBe(2)
    expect(handle.readSync(buffer, { offset: 0, length: 1, position: 5 })).toBe(1)
    expect(buffer[0]).toBe(102)
    expect(handle.position).toBe(2)
    const allocated = await handle.read({ length: 1 })
    expect(allocated.buffer.subarray(0, allocated.bytesRead).toString()).toBe("c")
    expect((await handle.read()).bytesRead).toBe(3)
    await handle.close()
  })

  it("should normalize string writes and buffer options without changing explicit-position cursors", async () => {
    const { provider } = await make()
    provider.writeFileSync("/file", "abcdef")
    const handle = await provider.open("/file", "r+")
    expect(await handle.write("XY", 0, "utf8")).toEqual({ bytesWritten: 2, buffer: "XY" })
    expect(handle.position).toBe(0)
    expect(handle.writeSync("5a", 2, "hex")).toBe(1)
    expect(handle.position).toBe(0)
    const buffer = Buffer.from("!Q?")
    const result = await handle.write(buffer, { offset: 1, length: 1, position: 3 })
    expect(result.buffer).toBe(buffer)
    expect(result.bytesWritten).toBe(1)
    expect(handle.position).toBe(0)
    expect(handle.writeSync(buffer, { offset: 0, length: 1 })).toBe(1)
    expect(handle.position).toBe(1)
    expect(await handle.write("é")).toEqual({ bytesWritten: 2, buffer: "é" })
    expect(handle.position).toBe(3)
    expect(provider.readFileSync("/file", "utf8")).toBe("!éQef")
    await handle.close()
  })

  for (const mode of ["sync", "promise"] as const) {
    it.each(["missing-source", "missing-parent", "exclusive"] as const)(
      `should preserve copyfile error context for %s with ${mode} calls`,
      async (scenario) => {
        const { provider } = await make()
        provider.writeFileSync("/source", "source")
        provider.writeFileSync("/dest", "keep")
        const src = scenario === "missing-source" ? "/missing" : "/source"
        const dest = scenario === "missing-parent" ? "/missing/dest" : "/dest"
        const flags = scenario === "exclusive" ? constants.COPYFILE_EXCL : 0
        const code = scenario === "exclusive" ? "EEXIST" : "ENOENT"
        const expected = { code, errno: -osConstants.errno[code], syscall: "copyfile", path: src, dest }

        if (mode === "sync") {
          expect(() => provider.copyFileSync(src, dest, flags)).toThrow(expect.objectContaining(expected))
        } else await expect(provider.copyFile(src, dest, flags)).rejects.toMatchObject(expected)
        expect(provider.readFileSync("/dest", "utf8")).toBe("keep")
      }
    )
  }

  it("should use byte offsets for typed-array views and retain the original result buffer", async () => {
    const { provider } = await make()
    provider.writeFileSync("/file", "abcdef")
    const handle = await provider.open("/file", "r+")
    const bytes = new Uint8Array([0, 0, 0, 0, 0, 0])
    const view = new DataView(bytes.buffer, 1, 4)
    const result = await handle.read({ buffer: view, offset: 1, length: 2, position: 1 })
    expect(result.buffer).toBe(view)
    expect(bytes).toEqual(new Uint8Array([0, 0, 98, 99, 0, 0]))
    const words = new Uint16Array(new Uint8Array([88, 89, 90, 33]).buffer)
    expect(await handle.write(words, { offset: 1, length: 2, position: 2 })).toEqual({ bytesWritten: 2, buffer: words })
    expect(handle.position).toBe(0)
    handle.writeSync(Buffer.from("!"), undefined, 1, 5)
    expect(provider.readFileSync("/file", "utf8")).toBe("abYZe!")
    const first = new DataView(new ArrayBuffer(1))
    const outputs = [first, new Uint16Array(1)]
    expect(await handle.readv(outputs, 0)).toEqual({ bytesRead: 3, buffers: outputs })
    expect(first.getUint8(0)).toBe(97)
    await handle.close()
  })

  it("should reject invalid overload options before changing buffers, files or cursors", async () => {
    const { provider } = await make()
    provider.writeFileSync("/file", "abcdef")
    const handle = await provider.open("/file", "r+")
    const buffer = Buffer.from("??")
    await expect(handle.read({ buffer, offset: -1 })).rejects.toMatchObject({ code: "EINVAL" })
    await expect(handle.write(buffer, { length: 3 })).rejects.toMatchObject({ code: "EINVAL" })
    // SAFETY: Deliberately unsupported encoding must fail before writing any bytes.
    await expect(handle.write("erase", 0, "invalid" as never)).rejects.toMatchObject({ code: "EINVAL" })
    expect(buffer.toString()).toBe("??")
    expect(handle.position).toBe(0)
    expect(provider.readFileSync("/file", "utf8")).toBe("abcdef")
    await handle.close()
    await expect(handle.read({ buffer })).rejects.toMatchObject({ code: "EBADF" })
    await expect(handle.write("x")).rejects.toMatchObject({ code: "EBADF" })
  })
})
