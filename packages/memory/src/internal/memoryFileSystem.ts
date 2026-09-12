/**
 * Implements the Effect `FileSystem` adapter over `@effect-vfs/core`.
 *
 * This module owns string-path conversion, Effect cursor compatibility, error
 * translation, recursive helpers, temporary resources, globbing, and watches.
 *
 * @internal
 */
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as ByteSize from "effect/ByteSize"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { badArgument, type PlatformError, systemError, type SystemErrorTag } from "effect/PlatformError"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import { compileGlobPatterns, matchesGlob } from "./glob.js"

const argumentError = (method: string, description: string) =>
  badArgument({ module: "FileSystem", method, description })
const resourceError = (method: string, pathOrDescriptor: string | number, description?: string) =>
  systemError({
    module: "FileSystem",
    method,
    pathOrDescriptor,
    _tag: "BadResource",
    ...(description === undefined ? {} : { description })
  })
const translate = (error: Vfs.FsError, method: string, pathOrDescriptor: string | number): PlatformError => {
  if (error.code === "InvalidArgument") return argumentError(method, error.code)
  const tags: Partial<Record<Vfs.FsCode, SystemErrorTag>> = {
    NotFound: "NotFound",
    AlreadyExists: "AlreadyExists",
    AccessDenied: "PermissionDenied",
    InvalidPathEncoding: "InvalidData",
    UnrepresentableName: "InvalidData",
    PathTooLong: "InvalidData"
  }
  return systemError({
    module: "FileSystem",
    method,
    pathOrDescriptor,
    _tag: tags[error.code] ?? "BadResource",
    description: error.code
  })
}
const mapped = <A, R>(effect: Effect.Effect<A, Vfs.FsError, R>, method: string, path: string | number) =>
  effect.pipe(Effect.mapError((error) => translate(error, method, path)))
const info = Effect.fnUntraced(function*(
  value: Vfs.Metadata,
  pathOrDescriptor: string | number
): Effect.fn.Return<FileSystem.File.Info, PlatformError> {
  const date = (field: "atimeNs" | "mtimeNs" | "birthtimeNs") => {
    const result = DateTime.make(Number(value[field] / 1_000_000n))
    return Option.isSome(result)
      ? Effect.succeed(Option.some(DateTime.toDateUtc(result.value)))
      : Effect.fail(systemError({
        module: "FileSystem",
        method: "stat",
        pathOrDescriptor,
        _tag: "InvalidData",
        description: `${field} cannot be represented as a JavaScript Date`
      }))
  }
  return {
    type: value.kind === "file" ? "File" : value.kind === "directory" ? "Directory" : "SymbolicLink",
    ino: Option.some(Number(value.ino)),
    dev: 0,
    mode: value.mode | (value.kind === "file" ? 0o100000 : value.kind === "directory" ? 0o40000 : 0o120000),
    uid: Option.some(value.uid),
    gid: Option.some(value.gid),
    nlink: Option.some(value.nlink),
    rdev: Option.some(0),
    size: ByteSize.bytes(value.size),
    blksize: Option.none(),
    blocks: Option.none(),
    atime: yield* date("atimeNs"),
    mtime: yield* date("mtimeNs"),
    birthtime: yield* date("birthtimeNs")
  }
})
const validateMode = (mode: number | undefined, method: string) =>
  mode === undefined || (Number.isInteger(mode) && mode >= 0 && mode <= 0xffffffff)
    ? Effect.void
    : Effect.fail(argumentError(method, "mode must be an unsigned 32-bit integer"))
const sizeInput = (size: number | undefined, method: string) => {
  const number = Number(size ?? 0)
  return Number.isSafeInteger(number) && number >= 0
    ? Effect.succeed(BigInt(number))
    : Effect.fail(argumentError(method, "size must be a non-negative safe integer"))
}
const openOptions = Effect.fnUntraced(function*(flag: FileSystem.OpenFlag, mode: number | undefined, method: string) {
  if (!["r", "r+", "w", "wx", "w+", "wx+", "a", "ax", "a+", "ax+"].includes(flag)) {
    return yield* argumentError(method, "Unsupported open flag")
  }
  yield* validateMode(mode, method)
  const create = flag.startsWith("w") || flag.startsWith("a")
  return {
    access: flag === "r" ? "read" : flag.endsWith("+") ? "readWrite" : "write",
    create: create ? flag.includes("x") ? "exclusive" : "ifMissing" : "never",
    ...(create ? { mode: (mode ?? 0o644) & 0o7777 } : {}),
    append: flag.startsWith("a"),
    truncate: flag.startsWith("w")
  } satisfies Vfs.OpenOptions
})
const childPath = (parent: string, name: string) => parent === "/" ? `/${name}` : `${parent}/${name}`
const textPath = Effect.fnUntraced(function*(path: Vfs.BytePath, method: string) {
  const bytes = yield* Vfs.pathToBytes(path)
  return yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    catch: () => new Vfs.FsError({ code: "UnrepresentableName", operation: method })
  })
})

/** @internal */
export const bind = Effect.fn("MemoryFileSystem.bind")(function*(volume: Vfs.Volume, options?: Vfs.RootCallerOptions) {
  const caller = yield* volume.caller({ ...options, umask: options?.umask ?? 0 })
  let nextDescriptor = 3
  let nextTemporary = 1
  const makeDirectory = Effect.fn("MemoryFileSystem.makeDirectory")(
    function*(path: string, options?: { recursive?: boolean | undefined; mode?: number | undefined }) {
      yield* validateMode(options?.mode, "makeDirectory")
      const mode = (options?.mode ?? 0o755) & 0o7777
      if (!options?.recursive) return yield* mapped(caller.mkdir(path, { mode }), "makeDirectory", path)
      return yield* mapped(
        Effect.scoped(Effect.gen(function*() {
          if (path === "") return yield* new Vfs.FsError({ code: "NotFound", operation: "makeDirectory" })
          let base = yield* caller.openDirectory("/")
          const components = path.split("/").filter((part) => part.length > 0)
          for (const [index, name] of components.entries()) {
            const result = yield* Effect.result(caller.mkdir(name, { relativeTo: base, mode }))
            if (result._tag === "Failure" && result.failure.code !== "AlreadyExists") return yield* result.failure
            const next = yield* caller.openDirectory(name, { relativeTo: base }).pipe(
              Effect.mapError((error) =>
                error.code === "NotDirectory" && index === components.length - 1
                  ? new Vfs.FsError({ code: "AlreadyExists", operation: "makeDirectory" })
                  : error
              )
            )
            yield* base.close
            base = next
          }
        })),
        "makeDirectory",
        path
      )
    }
  )
  const open: FileSystem.FileSystem["open"] = Effect.fn("MemoryFileSystem.open")(function*(path, options) {
    const chosen = yield* openOptions(options?.flag ?? "r", options?.mode, "open")
    const handle = yield* mapped(caller.open(path, chosen), "open", path)
    const fd = nextDescriptor++
    let position = 0n
    let closed = false
    const gate = Semaphore.makeUnsafe(1)
    const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) => gate.withPermit(Effect.uninterruptible(effect))
    yield* Effect.addFinalizer(() =>
      locked(Effect.sync(() => {
        closed = true
      }))
    )
    const read = Effect.fnUntraced(function*(length: number, method: string) {
      if (closed) return yield* resourceError(method, fd)
      if (length > 0 && (position < 0n || position > BigInt(Number.MAX_SAFE_INTEGER))) {
        return yield* resourceError(method, fd, "Invalid file position")
      }
      const bytes = yield* mapped(handle.pread(length, length === 0 ? 0n : position), method, fd)
      position += BigInt(bytes.length)
      return bytes
    })
    const write = Effect.fnUntraced(function*(input: Uint8Array, method: string, all: boolean) {
      // Copy the view so writes accept ArrayBuffer- and SharedArrayBuffer-backed input.
      const bytes = new Uint8Array(input)
      return yield* locked(Effect.gen(function*() {
        if (closed) return yield* resourceError(method, fd)
        if (bytes.length > 0 && (position < 0n || position > BigInt(Number.MAX_SAFE_INTEGER))) {
          return yield* resourceError(method, fd, "Invalid file position")
        }
        let total = 0
        do {
          const part = bytes.subarray(total)
          const written = yield* mapped(
            chosen.append ? handle.write(part) : handle.pwrite(part, bytes.length === 0 ? 0n : position),
            method,
            fd
          )
          total += written
          if (!chosen.append) position += BigInt(written)
        } while (all && total < bytes.length)
        return total
      }))
    })
    return {
      [FileSystem.FileTypeId]: FileSystem.FileTypeId,
      stat: mapped(handle.stat, "stat", fd).pipe(Effect.flatMap((value) => info(value, fd))),
      sync: mapped(handle.sync, "sync", fd),
      seek: Effect.fn("MemoryFile.seek")(function*(offset, from) {
        return yield* locked(Effect.sync(() => {
          if (closed) return 0n
          position = from === "start" ? offset : position + offset
          return position
        }))
      }),
      read: Effect.fn("MemoryFile.read")(function*(buffer) {
        return yield* locked(Effect.gen(function*() {
          const bytes = yield* read(buffer.length, "read")
          buffer.set(bytes)
          return bytes.length
        }))
      }),
      readAlloc: Effect.fn("MemoryFile.readAlloc")(function*(size) {
        const length = yield* sizeInput(size, "readAlloc")
        return yield* locked(
          Effect.map(
            read(Number(length), "readAlloc"),
            (bytes) => bytes.length === 0 ? Option.none() : Option.some(bytes)
          )
        )
      }),
      truncate: Effect.fn("MemoryFile.truncate")(function*(length) {
        const size = yield* sizeInput(length, "truncate")
        return yield* locked(Effect.gen(function*() {
          yield* mapped(handle.truncate(size), "truncate", fd)
          if (!chosen.append && position > size) position = size
        }))
      }),
      write: (buffer) => write(buffer, "write", false),
      writeAll: (buffer) => Effect.asVoid(write(buffer, "writeAll", true))
    } satisfies FileSystem.File
  })
  const walk = Effect.fnUntraced(function*(path: string) {
    const root = yield* caller.openDirectory(path)
    const pending: Array<{ base: Vfs.DirectoryHandle; prefix: string }> = [{ base: root, prefix: "" }]
    const output: Array<{ relative: string; base: Vfs.DirectoryHandle; name: string; metadata: Vfs.Metadata }> = []
    while (pending.length > 0) {
      const next = pending.pop()
      if (next === undefined) break
      const names = yield* caller.readDirectory(".", { relativeTo: next.base })
      for (const name of names) {
        const relative = next.prefix === "" ? name : `${next.prefix}/${name}`
        const metadata = yield* caller.lstat(name, { relativeTo: next.base })
        output.push({ relative, base: next.base, name, metadata })
        if (metadata.kind === "directory") {
          pending.push({ base: yield* caller.openDirectory(name, { relativeTo: next.base }), prefix: relative })
        }
      }
    }
    return output
  })
  const remove: FileSystem.FileSystem["remove"] = Effect.fn("MemoryFileSystem.remove")(function*(path, options) {
    const name = path.split("/").filter((part) => part.length > 0).at(-1)
    if (name === undefined || name === "." || name === "..") {
      return yield* resourceError("remove", path, "Cannot remove root or dot entries")
    }
    const action = Effect.scoped(Effect.gen(function*() {
      const node = yield* caller.lstat(path)
      if (node.kind !== "directory") return yield* caller.unlink(path)
      if (options?.recursive) {
        const entries = yield* walk(path)
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i]
          if (entry === undefined) continue
          const relative = { relativeTo: entry.base }
          yield* entry.metadata.kind === "directory"
            ? caller.rmdir(entry.name, relative)
            : caller.unlink(entry.name, relative)
        }
      }
      yield* caller.rmdir(path)
    }))
    return yield* mapped(
      options?.force ? action.pipe(Effect.catchIf((error) => error.code === "NotFound", () => Effect.void)) : action,
      "remove",
      path
    )
  })
  const readDirectory: FileSystem.FileSystem["readDirectory"] = Effect.fn("MemoryFileSystem.readDirectory")(
    function*(path, options) {
      return yield* mapped(
        options?.recursive
          ? Effect.scoped(walk(path)).pipe(Effect.map((entries) => entries.map((entry) => entry.relative).sort()))
          : caller.readDirectory(path).pipe(Effect.map((names) => [...names].sort())),
        "readDirectory",
        path
      )
    }
  )
  const writeCopiedFile = (
    destination: Vfs.PathInput,
    bytes: Uint8Array,
    mode: number,
    options: Pick<Vfs.WriteFileOptions, "relativeTo" | "create" | "replaceFinalSymlink">
  ) =>
    caller.writeFile(destination, bytes, {
      ...options,
      access: "write",
      truncate: true,
      mode,
      finalMode: mode
    })
  const copy: FileSystem.FileSystem["copy"] = Effect.fn("MemoryFileSystem.copy")(
    function*(source, destination, options) {
      return yield* mapped(
        Effect.scoped(Effect.gen(function*() {
          const sourceNode = yield* caller.lstat(source)
          const existing = yield* Effect.result(caller.lstat(destination))
          if (existing._tag === "Failure" && existing.failure.code !== "NotFound") return yield* existing.failure
          if (existing._tag === "Success" && existing.success.ino === sourceNode.ino) {
            return yield* new Vfs.FsError({ code: "InvalidArgument", operation: "copy" })
          }
          if (existing._tag === "Success" && !options?.overwrite) {
            return yield* new Vfs.FsError({ code: "AlreadyExists", operation: "copy" })
          }
          if (sourceNode.kind === "file") {
            const bytes = yield* caller.readFile(source)
            yield* writeCopiedFile(destination, bytes, sourceNode.mode, {
              create: options?.overwrite ? "ifMissing" : "exclusive",
              replaceFinalSymlink: true
            })
          } else if (sourceNode.kind === "symlink") {
            if (existing._tag === "Success") {
              yield* caller.unlink(destination)
            }
            yield* caller.symlink(yield* caller.readLink(source), destination)
          } else {
            const canonicalSource = yield* caller.realPath(source)
            const trimmed = destination.replace(/\/+$/, "") || "/"
            const slash = trimmed.lastIndexOf("/")
            const parentPath = slash <= 0 ? "/" : trimmed.slice(0, slash)
            const parent = yield* caller.realPath(parentPath)
            if (parent === canonicalSource || parent.startsWith(`${canonicalSource}/`)) {
              return yield* new Vfs.FsError({ code: "InvalidArgument", operation: "copy" })
            }
            const entries = yield* walk(source)
            if (existing._tag === "Failure") {
              yield* caller.mkdir(destination, { mode: sourceNode.mode })
            } else if (existing.success.kind !== "directory") {
              return yield* new Vfs.FsError({ code: "NotDirectory", operation: "copy" })
            }
            const copiedNodes = new Map<bigint, { base: Vfs.DirectoryHandle; name: string }>()
            const directoryTimes: Array<{ base: Vfs.DirectoryHandle; name: string; metadata: Vfs.Metadata }> = []
            const bases = new Map<string, Vfs.DirectoryHandle>([["", yield* caller.openDirectory(destination)]])
            for (const entry of entries) {
              const split = entry.relative.lastIndexOf("/")
              const parent = bases.get(split < 0 ? "" : entry.relative.slice(0, split))
              if (parent === undefined) {
                return yield* new Vfs.FsError({ code: "NotFound", operation: "copy" })
              }
              const relative = { relativeTo: parent }
              if (entry.metadata.kind === "directory") {
                const made = yield* Effect.result(caller.mkdir(entry.name, { ...relative, mode: entry.metadata.mode }))
                if (made._tag === "Failure" && (!options?.overwrite || made.failure.code !== "AlreadyExists")) {
                  return yield* made.failure
                }
                bases.set(entry.relative, yield* caller.openDirectory(entry.name, relative))
              } else if (entry.metadata.kind === "file") {
                const previous = copiedNodes.get(entry.metadata.ino)
                const existing = yield* Effect.result(caller.lstat(entry.name, relative))
                if (previous !== undefined && existing._tag === "Failure" && existing.failure.code === "NotFound") {
                  yield* caller.link(previous.name, entry.name, {
                    sourceRelativeTo: previous.base,
                    destinationRelativeTo: parent
                  })
                } else {
                  yield* writeCopiedFile(
                    entry.name,
                    yield* caller.readFile(entry.name, { relativeTo: entry.base }),
                    entry.metadata.mode,
                    {
                      ...relative,
                      create: options?.overwrite ? "ifMissing" : "exclusive",
                      replaceFinalSymlink: true
                    }
                  )
                  copiedNodes.set(entry.metadata.ino, { base: parent, name: entry.name })
                }
              } else {
                const previous = copiedNodes.get(entry.metadata.ino)
                const existing = yield* Effect.result(caller.lstat(entry.name, relative))
                if (existing._tag === "Success") {
                  if (!options?.overwrite) {
                    return yield* new Vfs.FsError({ code: "AlreadyExists", operation: "copy" })
                  }
                  yield* caller.unlink(entry.name, relative)
                } else if (existing.failure.code !== "NotFound") return yield* existing.failure
                if (previous !== undefined) {
                  yield* caller.link(previous.name, entry.name, {
                    sourceRelativeTo: previous.base,
                    destinationRelativeTo: parent
                  })
                } else {
                  yield* caller.symlink(
                    yield* caller.readLink(entry.name, { relativeTo: entry.base }),
                    entry.name,
                    relative
                  )
                  copiedNodes.set(entry.metadata.ino, { base: parent, name: entry.name })
                }
              }
              if (options?.preserveTimestamps && entry.metadata.kind === "directory") {
                directoryTimes.push({ base: parent, name: entry.name, metadata: entry.metadata })
              }
              if (options?.preserveTimestamps && entry.metadata.kind !== "directory") {
                yield* caller.utimes(entry.name, {
                  access: { kind: "value", nanoseconds: entry.metadata.atimeNs },
                  modification: { kind: "value", nanoseconds: entry.metadata.mtimeNs }
                }, { ...relative, followFinalSymlink: false })
              }
            }
            for (const directory of directoryTimes.reverse()) {
              yield* caller.utimes(directory.name, {
                access: { kind: "value", nanoseconds: directory.metadata.atimeNs },
                modification: { kind: "value", nanoseconds: directory.metadata.mtimeNs }
              }, { relativeTo: directory.base })
            }
          }
          if (options?.preserveTimestamps) {
            yield* caller.utimes(destination, {
              access: { kind: "value", nanoseconds: sourceNode.atimeNs },
              modification: { kind: "value", nanoseconds: sourceNode.mtimeNs }
            }, { followFinalSymlink: false })
          }
        })),
        "copy",
        source
      )
    }
  )
  const copyFile: FileSystem.FileSystem["copyFile"] = Effect.fn("MemoryFileSystem.copyFile")(
    function*(source, destination) {
      return yield* mapped(
        Effect.gen(function*() {
          const metadata = yield* caller.stat(source)
          if (metadata.kind !== "file") return yield* new Vfs.FsError({ code: "IsDirectory", operation: "copyFile" })
          const target = yield* Effect.result(caller.stat(destination))
          if (target._tag === "Success" && target.success.ino === metadata.ino) return
          yield* writeCopiedFile(destination, yield* caller.readFile(source), metadata.mode, { create: "ifMissing" })
        }),
        "copyFile",
        source
      )
    }
  )
  const temp = Effect.fnUntraced(
    function*(
      method: string,
      file: boolean,
      options?: { directory?: string | undefined; prefix?: string | undefined; suffix?: string | undefined }
    ) {
      for (const value of [options?.prefix ?? "", options?.suffix ?? ""]) {
        if (value.includes("/") || value.includes("\0")) {
          return yield* argumentError(method, "temporary fragments cannot contain separators")
        }
      }
      const parent = yield* mapped(caller.realPath(options?.directory ?? "/tmp"), method, options?.directory ?? "/tmp")
      while (true) {
        const directory = childPath(
          parent,
          `${options?.prefix ?? ""}${(nextTemporary++).toString(36).padStart(8, "0")}`
        )
        const result = yield* Effect.result(caller.mkdir(directory))
        if (result._tag === "Failure") {
          if (result.failure.code === "AlreadyExists") continue
          return yield* translate(result.failure, method, directory)
        }
        if (!file) return directory
        const path = childPath(directory, `${(nextTemporary++).toString(36).padStart(8, "0")}${options?.suffix ?? ""}`)
        yield* mapped(
          caller.writeFile(path, new Uint8Array(0), { access: "write", create: "exclusive", mode: 0o644 }),
          method,
          path
        ).pipe(Effect.onError(() => remove(directory, { recursive: true, force: true }).pipe(Effect.orDie)))
        return path
      }
    }
  )
  return FileSystem.make({
    access: (path) => mapped(Effect.asVoid(caller.stat(path)), "access", path),
    stat: (path) => mapped(caller.stat(path), "stat", path).pipe(Effect.flatMap((value) => info(value, path))),
    chmod: Effect.fn("MemoryFileSystem.chmod")(function*(path, mode) {
      yield* validateMode(mode, "chmod")
      yield* mapped(caller.chmod(path, mode & 0o7777), "chmod", path)
    }),
    chown: Effect.fn("MemoryFileSystem.chown")(function*(path, uid, gid) {
      if (![uid, gid].every((id) => Number.isInteger(id) && id >= 0 && id <= 0xffffffff)) {
        return yield* argumentError("chown", "owner IDs must be unsigned 32-bit integers")
      }
      yield* mapped(caller.chown(path, { uid, gid }), "chown", path)
    }),
    utimes: Effect.fn("MemoryFileSystem.utimes")(function*(path, atime, mtime) {
      const access = typeof atime === "number" ? atime * 1000 : atime.getTime()
      const modification = typeof mtime === "number" ? mtime * 1000 : mtime.getTime()
      if (![access, modification].every((value) => Number.isFinite(value) && Math.abs(value) <= 8.64e15)) {
        return yield* argumentError("utimes", "timestamps must be valid dates")
      }
      yield* mapped(
        caller.utimes(path, {
          access: { kind: "value", nanoseconds: BigInt(Math.trunc(access)) * 1_000_000n },
          modification: { kind: "value", nanoseconds: BigInt(Math.trunc(modification)) * 1_000_000n }
        }),
        "utimes",
        path
      )
    }),
    open,
    makeDirectory,
    readDirectory,
    remove,
    copy,
    copyFile,
    readFile: (path) => mapped(caller.readFile(path), "readFile", path),
    writeFile: Effect.fn("MemoryFileSystem.writeFile")(function*(path, data, options) {
      const bytes = new Uint8Array(data)
      const chosen = yield* openOptions(options?.flag ?? "w", options?.mode, "writeFile")
      yield* mapped(caller.writeFile(path, bytes, chosen), "writeFile", path)
    }),
    readLink: (path) => mapped(caller.readLink(path), "readLink", path),
    realPath: (path) => mapped(caller.realPath(path), "realPath", path),
    rename: Effect.fn("MemoryFileSystem.rename")(
      function*(source, destination) {
        const sourceInfo = yield* caller.lstat(source)
        const target = sourceInfo.kind === "directory" && destination.endsWith("/")
          ? destination.replace(/\/+$/, "") || "/"
          : destination
        yield* caller.rename(source, target)
      },
      (effect, source) => mapped(effect, "rename", source)
    ),
    link: (source, destination) => mapped(caller.link(source, destination), "link", source),
    symlink: (target, path) => mapped(caller.symlink(target, path), "symlink", path),
    truncate: Effect.fn("MemoryFileSystem.truncate")(function*(path, length) {
      yield* mapped(caller.truncate(path, yield* sizeInput(length, "truncate")), "truncate", path)
    }),
    makeTempDirectory: (options) => temp("makeTempDirectory", false, options),
    makeTempFile: (options) => temp("makeTempFile", true, options),
    makeTempDirectoryScoped: (options) =>
      Effect.acquireRelease(
        temp("makeTempDirectoryScoped", false, options),
        (path) => remove(path, { recursive: true, force: true }).pipe(Effect.orDie)
      ),
    makeTempFileScoped: (options) =>
      Effect.acquireRelease(
        temp("makeTempFileScoped", true, options),
        (path) => remove(path.slice(0, path.lastIndexOf("/")), { recursive: true, force: true }).pipe(Effect.orDie)
      ),
    watch: (path, options) =>
      Stream.unwrap(Effect.gen(function*() {
        const stream = yield* volume.watch
        const resolved = yield* mapped(caller.realPath(path), "stat", path)
        const prefix = new TextEncoder().encode(resolved)
        return stream.pipe(
          Stream.filterEffect((event) =>
            mapped(Vfs.pathToBytes(event.path), "watch", path).pipe(Effect.map((bytes) => {
              if (!prefix.every((byte, index) => bytes[index] === byte)) return false
              if (bytes.length === prefix.length) return true
              const start = resolved === "/" ? 1 : prefix.length + 1
              if (resolved !== "/" && bytes[prefix.length] !== 47) return false
              return options?.recursive === true || !bytes.subarray(start).includes(47)
            }))
          ),
          Stream.mapEffect((event) =>
            mapped(textPath(event.path, "watch"), "watch", path).pipe(
              Effect.map((name) => ({ _tag: event._tag, path: name }))
            )
          )
        )
      })),
    glob: Effect.fn("MemoryFileSystem.glob")(function*(pattern, options) {
      const include = yield* compileGlobPatterns("glob", pattern)
      const exclude = (yield* Effect.forEach(options?.exclude ?? [], (pattern) => compileGlobPatterns("glob", pattern)))
        .flat()
      return yield* mapped(
        Effect.scoped(Effect.gen(function*() {
          const entries = yield* walk(options?.root ?? "/")
          if (exclude.some((pattern) => matchesGlob(pattern, [], true))) return []
          const output = include.some((pattern) => matchesGlob(pattern, [], true)) ? ["."] : []
          const excludedDirectories: Array<string> = []
          for (const entry of entries) {
            const parts = entry.relative.split("/")
            const directory = entry.metadata.kind === "directory"
            const excluded = excludedDirectories.some((prefix) => entry.relative.startsWith(`${prefix}/`)) ||
              exclude.some((pattern) => matchesGlob(pattern, parts, directory))
            if (excluded) {
              if (directory) excludedDirectories.push(entry.relative)
              continue
            }
            if (include.some((pattern) => matchesGlob(pattern, parts, directory))) output.push(entry.relative)
          }
          return output.sort()
        })),
        "glob",
        options?.root ?? "/"
      )
    })
  })
})

/** @internal */
export const make: Effect.Effect<FileSystem.FileSystem> = Effect.gen(function*() {
  const volume = yield* Vfs.fromFixture({ entries: [{ kind: "directory", path: "/tmp" }] })
  return yield* bind(volume)
}).pipe(Effect.orDie)

/** @internal */
export const layer = Layer.effect(FileSystem.FileSystem, make)
