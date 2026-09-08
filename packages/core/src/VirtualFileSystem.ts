/** Runtime-neutral virtual filesystem with independently scoped capabilities. */
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as SchemaIssue from "effect/SchemaIssue"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"

const BytePathId = Symbol("@effect-vfs/core/BytePath")
const VolumeId = Symbol("@effect-vfs/core/Volume")
const CallerId = Symbol("@effect-vfs/core/Caller")
const FileHandleId = Symbol("@effect-vfs/core/FileHandle")
const DirectoryHandleId = Symbol("@effect-vfs/core/DirectoryHandle")

export interface BytePath {
  readonly [BytePathId]: true
}
export type PathInput = string | BytePath

export const FsCode = Schema.Literals([
  "NotFound",
  "AlreadyExists",
  "NotEmpty",
  "NotDirectory",
  "AccessDenied",
  "InvalidHandle",
  "ForeignHandle",
  "ClosedCaller",
  "InvalidArgument",
  "InvalidPathEncoding",
  "PathTooLong",
  "NoSpace",
  "IsDirectory",
  "FileTooLarge",
  "NoData",
  "SymlinkLoop"
])
export type FsCode = typeof FsCode.Type
export class FsError extends Data.TaggedError("FsError")<{
  readonly code: FsCode
  readonly operation: string
  readonly path?: PathInput
}> {}
export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  readonly field: string
}> {}

const Natural = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)
const Mode = Natural.check(Schema.isLessThanOrEqualTo(0o7777))
export const Identity = Schema.Struct({
  uid: Natural,
  gid: Natural,
  groups: Schema.Array(Natural),
  privileged: Schema.Boolean
})
export type Identity = typeof Identity.Type
export const RootCallerOptions = Schema.Struct({
  identity: Schema.optionalKey(Identity),
  umask: Schema.optionalKey(Natural.check(Schema.isLessThanOrEqualTo(0o777)))
})
export type RootCallerOptions = typeof RootCallerOptions.Type
export const VolumeOptions = Schema.Struct({
  maxEntries: Schema.optionalKey(Natural),
  maxBytes: Schema.optionalKey(Natural),
  maxFileBytes: Schema.optionalKey(Natural.check(Schema.isLessThanOrEqualTo(0xffffffff))),
  maxPathBytes: Schema.optionalKey(Natural.check(Schema.isGreaterThanOrEqualTo(1)))
})
export type VolumeOptions = typeof VolumeOptions.Type
export const Metadata = Schema.Struct({
  kind: Schema.Literals(["directory", "file", "symlink"]),
  ino: Schema.BigInt,
  nlink: Natural,
  size: Schema.BigInt,
  uid: Natural,
  gid: Natural,
  mode: Mode,
  atimeNs: Schema.BigInt,
  mtimeNs: Schema.BigInt,
  ctimeNs: Schema.BigInt,
  birthtimeNs: Schema.BigInt
})
export type Metadata = typeof Metadata.Type

export interface RelativeOptions {
  readonly relativeTo?: DirectoryHandle
}
export interface DirectoryHandle {
  readonly [DirectoryHandleId]: true
  // oxlint-disable-next-line effecttsgo/lazy-effect -- Reviewed resource API uses explicit method calls.
  readonly stat: () => Effect.Effect<Metadata, FsError>
  // oxlint-disable-next-line effecttsgo/lazy-effect -- Explicit close is distinct from scope release.
  readonly close: () => Effect.Effect<void, FsError>
}
export const SeekMode = Schema.Literals(["start", "current", "end", "data", "hole"])
export type SeekMode = typeof SeekMode.Type
export const OpenSettings = Schema.Struct({
  access: Schema.Literals(["read", "write", "readWrite"]),
  create: Schema.optionalKey(Schema.Literals(["never", "ifMissing", "exclusive"])),
  mode: Schema.optionalKey(Mode),
  append: Schema.optionalKey(Schema.Boolean),
  truncate: Schema.optionalKey(Schema.Boolean),
  followFinalSymlink: Schema.optionalKey(Schema.Boolean)
})
export type OpenOptions = typeof OpenSettings.Type & RelativeOptions
export interface FileHandle {
  readonly [FileHandleId]: true
  readonly read: (maximumBytes: number) => Effect.Effect<Uint8Array, FsError>
  readonly pread: (maximumBytes: number, offset: bigint) => Effect.Effect<Uint8Array, FsError>
  readonly write: (bytes: Uint8Array) => Effect.Effect<number, FsError>
  readonly pwrite: (bytes: Uint8Array, offset: bigint) => Effect.Effect<number, FsError>
  readonly seek: (offset: bigint, mode: SeekMode) => Effect.Effect<bigint, FsError>
  readonly truncate: (length: bigint) => Effect.Effect<void, FsError>
  // oxlint-disable-next-line effecttsgo/lazy-effect -- Explicit capability operation.
  readonly stat: () => Effect.Effect<Metadata, FsError>
  // oxlint-disable-next-line effecttsgo/lazy-effect -- Volatile validation, not persistence.
  readonly sync: () => Effect.Effect<void, FsError>
  // oxlint-disable-next-line effecttsgo/lazy-effect -- Explicit close differs from scope cleanup.
  readonly close: () => Effect.Effect<void, FsError>
}
export interface Caller {
  readonly [CallerId]: true
  readonly stat: (path: PathInput, options?: RelativeOptions) => Effect.Effect<Metadata, FsError>
  readonly rename: (
    source: PathInput,
    destination: PathInput,
    options?: { readonly sourceRelativeTo?: DirectoryHandle; readonly destinationRelativeTo?: DirectoryHandle }
  ) => Effect.Effect<void, FsError>
  readonly open: (path: PathInput, options: OpenOptions) => Effect.Effect<FileHandle, FsError, Scope.Scope>
  readonly unlink: (path: PathInput, options?: RelativeOptions) => Effect.Effect<void, FsError>
  readonly rmdir: (path: PathInput, options?: RelativeOptions) => Effect.Effect<void, FsError>
  readonly mkdir: (
    path: PathInput,
    options?: RelativeOptions & { readonly mode?: number }
  ) => Effect.Effect<void, FsError>
  readonly withDirectory: (path: PathInput, options?: RelativeOptions) => Effect.Effect<Caller, FsError, Scope.Scope>
  readonly openDirectory: (
    path: PathInput,
    options?: RelativeOptions
  ) => Effect.Effect<DirectoryHandle, FsError, Scope.Scope>
}
export interface Volume {
  readonly [VolumeId]: true
  readonly caller: (options?: RootCallerOptions) => Effect.Effect<Caller, ConfigurationError>
}
export class CurrentFileSystem
  extends Context.Service<CurrentFileSystem, Caller>()("@effect-vfs/core/CurrentFileSystem")
{}

const bytePaths = new WeakMap<BytePath, Uint8Array>()
const failure = (code: FsCode, operation: string, path?: PathInput) =>
  new FsError({ code, operation, ...(path === undefined ? {} : { path }) })

// A zero-length view distinguishes a detached buffer from a valid empty buffer.
const attachedBuffer = (bytes: Uint8Array): boolean => {
  try {
    new Uint8Array(bytes.buffer, bytes.byteOffset, 0)
    return true
  } catch (error) {
    if (error instanceof TypeError) return false
    throw error
  }
}

/** Copies at execution; shared backing and detached views are rejected. */
export const pathFromBytes = Effect.fn("VirtualFileSystem.pathFromBytes")(function*(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)) {
    return yield* failure("InvalidArgument", "pathFromBytes")
  }
  if (!attachedBuffer(bytes)) return yield* failure("InvalidArgument", "pathFromBytes")
  const owned = new Uint8Array(bytes)
  if (owned.length === 0 || owned.includes(0)) return yield* failure("InvalidArgument", "pathFromBytes")
  const path: BytePath = Object.freeze({ [BytePathId]: true as const })
  bytePaths.set(path, owned)
  return path
})

export const pathToBytes = Effect.fn("VirtualFileSystem.pathToBytes")(function*(path: BytePath) {
  const bytes = bytePaths.get(path)
  if (bytes === undefined) return yield* failure("InvalidArgument", "pathToBytes")
  return new Uint8Array(bytes)
})

interface Directory {
  readonly kind: "directory"
  parent: Directory | undefined
  readonly entries: Map<string, Node>
  metadata: Metadata
}
interface RegularFile {
  readonly kind: "file"
  data: Uint8Array
  openCount: number
  metadata: Metadata
}
type Node = Directory | RegularFile
interface FileReference {
  readonly volume: symbol
  file: RegularFile | undefined
  closed: boolean
  offset: bigint
  readonly access: "read" | "write" | "readWrite"
  readonly append: boolean
}
const files = new WeakMap<FileHandle, FileReference>()
interface DirectoryReference {
  readonly volume: symbol
  directory: Directory | undefined
  closed: boolean
}
const handles = new WeakMap<DirectoryHandle, DirectoryReference>()

interface PreparedPath {
  readonly input: PathInput
  readonly absolute: boolean
  readonly trailingSlash: boolean
  readonly components: ReadonlyArray<string>
}

const wellFormed = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

const preparePath = (
  input: PathInput,
  operation: string,
  maxPathBytes: number | undefined
): Result.Result<PreparedPath, FsError> => {
  let bytes: Uint8Array | undefined
  if (typeof input === "string") {
    if (!wellFormed(input)) return Result.fail(failure("InvalidPathEncoding", operation, input))
    bytes = new TextEncoder().encode(input)
  } else if (typeof input === "object" && input !== null) {
    bytes = bytePaths.get(input)
  }
  if (bytes === undefined) return Result.fail(failure("InvalidArgument", operation))
  if (bytes.length === 0) return Result.fail(failure("NotFound", operation, input))
  if (bytes.includes(0)) return Result.fail(failure("InvalidArgument", operation, input))
  if (maxPathBytes !== undefined && bytes.length > maxPathBytes) {
    return Result.fail(failure("PathTooLong", operation, input))
  }
  const components: Array<string> = []
  let start = 0
  for (let index = 0; index <= bytes.length; index++) {
    if (index !== bytes.length && bytes[index] !== 47) continue
    if (index > start) {
      // Provisional component bound from decision 0019; names are compared as bytes.
      if (index - start > 255) return Result.fail(failure("PathTooLong", operation, input))
      components.push(Encoding.encodeHex(bytes.subarray(start, index)))
    }
    start = index + 1
  }
  return Result.succeed({ input, absolute: bytes[0] === 47, trailingSlash: bytes.at(-1) === 47, components })
}

const configurationField = (issue: SchemaIssue.Issue): string => {
  if (issue._tag === "Pointer") return issue.path.map(String).join(".")
  if (issue._tag === "Composite") return configurationField(issue.issues[0])
  return "options"
}
const decodeConfiguration = <A>(schema: Schema.Codec<A>, value: unknown) =>
  Schema.decodeUnknownResult(schema, { onExcessProperty: "error" })(value).pipe(
    Result.mapError((error) => new ConfigurationError({ field: configurationField(error.issue) }))
  )

const directoryMetadata = (ino: bigint, uid: number, gid: number, mode: number, now: bigint): Metadata => ({
  kind: "directory",
  ino,
  uid,
  gid,
  mode,
  nlink: 2,
  size: 0n,
  atimeNs: now,
  mtimeNs: now,
  ctimeNs: now,
  birthtimeNs: now
})

/** Each execution constructs a fresh volume and captures its Clock. */
export const make = Effect.fn("VirtualFileSystem.make")(function*(options?: VolumeOptions) {
  const decoded = decodeConfiguration(VolumeOptions, options === undefined ? {} : options)
  if (Result.isFailure(decoded)) return yield* decoded.failure
  const settings = { ...decoded.success }
  const clock = yield* Clock.clockWith(Effect.succeed)
  const volumeIdentity = Symbol()
  const gate = Semaphore.makeUnsafe(1)
  const root: Directory = {
    kind: "directory",
    parent: undefined,
    entries: new Map(),
    metadata: directoryMetadata(1n, 0, 0, 0o755, clock.currentTimeNanosUnsafe())
  }
  let nextInode = 2n
  let entries = 0
  let usedBytes = 0
  const maxFileBytes = settings.maxFileBytes ?? 0xffffffff

  // Permit waits stay interruptible. State transitions and resource registration do not.
  const coordinated = <A, E, R>(effect: Effect.Effect<A, E, R>) => gate.withPermit(Effect.uninterruptible(effect))
  const release = (reference: DirectoryReference) =>
    coordinated(Effect.sync(() => {
      reference.directory = undefined
      reference.closed = true
    }))
  const authorize = (directory: Node, identity: Identity, bits: number, operation: string, path: PathInput) => {
    if (identity.privileged) return Effect.void
    const metadata = directory.metadata
    const shift = metadata.uid === identity.uid ?
      6
      : metadata.gid === identity.gid || identity.groups.includes(metadata.gid)
      ? 3
      : 0
    return ((metadata.mode >> shift) & bits) === bits
      ? Effect.void
      : Effect.fail(failure("AccessDenied", operation, path))
  }

  const reclaim = (file: RegularFile) => {
    if (file.metadata.nlink === 0 && file.openCount === 0) {
      usedBytes -= file.data.length
      file.data = new Uint8Array(0)
    }
  }
  const detach = (node: Node, now: bigint) => {
    if (node.kind === "directory") {
      node.parent = undefined
      node.metadata = { ...node.metadata, nlink: 0, ctimeNs: now }
    } else {
      node.metadata = { ...node.metadata, nlink: node.metadata.nlink - 1, ctimeNs: now }
      reclaim(node)
    }
  }
  const releaseFile = (ref: FileReference) => {
    if (ref.file !== undefined) {
      ref.file.openCount -= 1
      reclaim(ref.file)
      ref.file = undefined
    }
    ref.closed = true
  }
  const resize = (file: RegularFile, length: bigint, operation: string) =>
    Effect.gen(function*() {
      if (typeof length !== "bigint" || length < 0n) return yield* failure("InvalidArgument", operation)
      if (length > BigInt(maxFileBytes)) return yield* failure("FileTooLarge", operation)
      const size = Number(length)
      if (size - file.data.length > (settings.maxBytes ?? Number.MAX_SAFE_INTEGER) - usedBytes) {
        return yield* failure("NoSpace", operation)
      }
      const data = new Uint8Array(size)
      data.set(file.data.subarray(0, size))
      const now = clock.currentTimeNanosUnsafe()
      usedBytes += size - file.data.length
      file.data = data
      file.metadata = { ...file.metadata, size: length, mode: file.metadata.mode & ~0o6000, mtimeNs: now, ctimeNs: now }
    })
  const fileHandle = (ref: FileReference): FileHandle => {
    const get = (operation: string, access?: "read" | "write") =>
      ref.file === undefined || (access === "read" && ref.access === "write") ||
        (access === "write" && ref.access === "read")
        ? Effect.fail(failure("InvalidHandle", operation))
        : Effect.succeed(ref.file)
    const read = (maximum: number, position?: bigint) =>
      coordinated(Effect.gen(function*() {
        const file = yield* get(position === undefined ? "read" : "pread", "read")
        if (!Schema.is(Natural)(maximum)) return yield* failure("InvalidArgument", "read")
        const offset = position ?? ref.offset
        if (typeof offset !== "bigint" || offset < 0n) return yield* failure("InvalidArgument", "read")
        const start = Number(offset > file.metadata.size ? file.metadata.size : offset)
        const data = file.data.slice(start, start + Math.min(maximum, file.data.length - start))
        if (maximum > 0) file.metadata = { ...file.metadata, atimeNs: clock.currentTimeNanosUnsafe() }
        if (position === undefined) ref.offset += BigInt(data.length)
        return data
      }))
    const write = (input: Uint8Array, position?: bigint) =>
      Effect.gen(function*() {
        if (!(input instanceof Uint8Array) || !(input.buffer instanceof ArrayBuffer) || !attachedBuffer(input)) {
          return yield* failure("InvalidArgument", "write")
        }
        const bytes = new Uint8Array(input)
        return yield* coordinated(Effect.gen(function*() {
          const file = yield* get(position === undefined ? "write" : "pwrite", "write")
          const offset = position ?? (ref.append ? file.metadata.size : ref.offset)
          if (typeof offset !== "bigint" || offset < 0n) return yield* failure("InvalidArgument", "write")
          if (bytes.length === 0) return 0
          if (offset >= BigInt(maxFileBytes)) return yield* failure("FileTooLarge", "write")
          const start = Number(offset)
          const free = (settings.maxBytes ?? Number.MAX_SAFE_INTEGER) - usedBytes
          const end = Math.min(maxFileBytes, file.data.length + free)
          const count = Math.min(bytes.length, Math.max(0, end - start))
          if (count === 0) return yield* failure("NoSpace", "write")
          const size = Math.max(file.data.length, start + count)
          const data = size === file.data.length ? file.data : new Uint8Array(size)
          if (data !== file.data) data.set(file.data)
          const now = clock.currentTimeNanosUnsafe()
          data.set(bytes.subarray(0, count), start)
          usedBytes += size - file.data.length
          file.data = data
          file.metadata = {
            ...file.metadata,
            size: BigInt(size),
            mode: file.metadata.mode & ~0o6000,
            mtimeNs: now,
            ctimeNs: now
          }
          if (position === undefined) ref.offset = offset + BigInt(count)
          return count
        }))
      })
    const handle: FileHandle = Object.freeze({
      [FileHandleId]: true as const,
      read: Effect.fn("FileHandle.read")(function*(maximum: number) {
        return yield* read(maximum)
      }),
      pread: Effect.fn("FileHandle.pread")(function*(maximum: number, offset: bigint) {
        return yield* read(maximum, offset)
      }),
      write: Effect.fn("FileHandle.write")(function*(bytes: Uint8Array) {
        return yield* write(bytes)
      }),
      pwrite: Effect.fn("FileHandle.pwrite")(function*(bytes: Uint8Array, offset: bigint) {
        return yield* write(bytes, offset)
      }),
      seek: Effect.fn("FileHandle.seek")(function*(offset: bigint, mode: SeekMode) {
        return yield* coordinated(Effect.gen(function*() {
          const file = yield* get("seek")
          if (typeof offset !== "bigint" || !Schema.is(SeekMode)(mode)) return yield* failure("InvalidArgument", "seek")
          let next = mode === "current" ? ref.offset + offset : mode === "end" ? file.metadata.size + offset : offset
          if (next < 0n || next > 0x7fffffffffffffffn) return yield* failure("InvalidArgument", "seek")
          if (mode === "data" || mode === "hole") {
            if (offset >= file.metadata.size) return yield* failure("NoData", "seek")
            if (mode === "hole") next = file.metadata.size
          }
          ref.offset = next
          return next
        }))
      }),
      truncate: Effect.fn("FileHandle.truncate")(function*(length: bigint) {
        return yield* coordinated(Effect.gen(function*() {
          yield* resize(yield* get("truncate", "write"), length, "truncate")
        }))
      }),
      stat: Effect.fn("FileHandle.stat")(function*() {
        return yield* coordinated(Effect.gen(function*() {
          return { ...(yield* get("stat")).metadata }
        }))
      }),
      sync: Effect.fn("FileHandle.sync")(function*() {
        return yield* coordinated(Effect.suspend(() => Effect.asVoid(get("sync"))))
      }),
      close: Effect.fn("FileHandle.close")(function*() {
        return yield* coordinated(Effect.gen(function*() {
          yield* get("close")
          releaseFile(ref)
        }))
      })
    })
    files.set(handle, ref)
    return handle
  }

  const createCaller = (reference: DirectoryReference, identity: Identity, umask: number): Caller => {
    const resolveNode = Effect.fnUntraced(
      function*(path: PreparedPath, base: DirectoryHandle | undefined, operation: string, parent = false) {
        if (reference.directory === undefined) return yield* failure("ClosedCaller", operation, path.input)
        let current: Node = path.absolute ? root : reference.directory
        if (!path.absolute && base !== undefined) {
          const target = handles.get(base)
          if (target === undefined) return yield* failure("InvalidHandle", operation, path.input)
          if (target.volume !== volumeIdentity) return yield* failure("ForeignHandle", operation, path.input)
          if (target.directory === undefined) return yield* failure("InvalidHandle", operation, path.input)
          current = target.directory
          yield* authorize(current, identity, 1, operation, path.input)
        }
        const components = parent ? path.components.slice(0, -1) : path.components
        if (current.metadata.nlink === 0) return yield* failure("NotFound", operation, path.input)
        for (const component of components) {
          if (current.kind !== "directory") return yield* failure("NotDirectory", operation, path.input)
          yield* authorize(current, identity, 1, operation, path.input)
          if (component === "2e") continue
          if (component === "2e2e") {
            current = current.parent ?? current
            continue
          }
          const child = current.entries.get(component)
          if (child === undefined) return yield* failure("NotFound", operation, path.input)
          current = child
        }
        if (!parent && path.trailingSlash && current.kind !== "directory") {
          return yield* failure("NotDirectory", operation, path.input)
        }
        return current
      }
    )

    const locate = Effect.fnUntraced(
      function*(path: PreparedPath, base: DirectoryHandle | undefined, operation: string, parent = false) {
        const node = yield* resolveNode(path, base, operation, parent)
        if (node.kind !== "directory") return yield* failure("NotDirectory", operation, path.input)
        return node
      }
    )

    const acquireDirectory = (input: PathInput, options: RelativeOptions | undefined, operation: string) => {
      const prepared = preparePath(input, operation, settings.maxPathBytes)
      const base = options?.relativeTo
      return Effect.gen(function*() {
        const acquired: DirectoryReference = { volume: volumeIdentity, directory: undefined, closed: false }
        // Register before retaining a directory. Closed scopes can run this immediately,
        // so registration must not happen while holding the volume permit.
        yield* Effect.addFinalizer(() => release(acquired))
        return yield* coordinated(Effect.gen(function*() {
          if (acquired.closed) return yield* Effect.interrupt
          const path = yield* Effect.fromResult(prepared)
          const directory = yield* locate(path, base, operation)
          yield* authorize(directory, identity, 1, operation, input)
          acquired.directory = directory
          return acquired
        }))
      })
    }

    const authorizeRemoval = (parent: Directory, child: Node, operation: string, input: PathInput) =>
      (parent.metadata.mode & 0o1000) !== 0 && !identity.privileged &&
        identity.uid !== parent.metadata.uid && identity.uid !== child.metadata.uid
        ? Effect.fail(failure("AccessDenied", operation, input))
        : Effect.void

    return Object.freeze({
      [CallerId]: true as const,
      open: Effect.fn("Caller.open")(function*(input: PathInput, options: OpenOptions) {
        const prepared = preparePath(input, "open", settings.maxPathBytes)
        const { relativeTo: base, ...raw } = options
        const decoded = Schema.decodeResult(OpenSettings, { onExcessProperty: "error" })(raw)
        if (Result.isFailure(decoded)) return yield* failure("InvalidArgument", "open", input)
        const chosen = { ...decoded.success }
        if (chosen.access === "read" && (chosen.append || chosen.truncate)) {
          return yield* failure("InvalidArgument", "open", input)
        }
        if (chosen.mode !== undefined && (chosen.create === undefined || chosen.create === "never")) {
          return yield* failure("InvalidArgument", "open", input)
        }
        const acquired: FileReference = {
          volume: volumeIdentity,
          file: undefined,
          closed: false,
          offset: 0n,
          access: chosen.access,
          append: chosen.append ?? false
        }
        yield* Effect.addFinalizer(() => coordinated(Effect.sync(() => releaseFile(acquired))))
        return yield* coordinated(Effect.gen(function*() {
          if (acquired.closed) return yield* Effect.interrupt
          const path = yield* Effect.fromResult(prepared)
          const parent = yield* locate(path, base, "open", true)
          const name = path.components.at(-1)
          if (name === undefined || name === "2e" || name === "2e2e") {
            return yield* failure("IsDirectory", "open", input)
          }
          yield* authorize(parent, identity, 1, "open", input)
          let file = parent.entries.get(name)
          if (file !== undefined && chosen.create === "exclusive") return yield* failure("AlreadyExists", "open", input)
          if (file === undefined) {
            if (chosen.create === undefined || chosen.create === "never" || path.trailingSlash) {
              return yield* failure("NotFound", "open", input)
            }
            yield* authorize(parent, identity, 3, "open", input)
            if (settings.maxEntries !== undefined && entries >= settings.maxEntries) {
              return yield* failure("NoSpace", "open", input)
            }
            const now = clock.currentTimeNanosUnsafe()
            file = {
              kind: "file",
              data: new Uint8Array(0),
              openCount: 0,
              metadata: {
                ...directoryMetadata(
                  nextInode,
                  identity.uid,
                  parent.metadata.gid,
                  (chosen.mode ?? 0o666) & 0o777 & ~umask,
                  now
                ),
                kind: "file",
                nlink: 1
              }
            }
            parent.entries.set(name, file)
            parent.metadata = { ...parent.metadata, mtimeNs: now, ctimeNs: now }
            entries += 1
            nextInode += 1n
          } else {
            if (file.kind !== "file") return yield* failure("IsDirectory", "open", input)
            if (path.trailingSlash) return yield* failure("NotDirectory", "open", input)
            yield* authorize(
              file,
              identity,
              chosen.access === "read" ? 4 : chosen.access === "write" ? 2 : 6,
              "open",
              input
            )
            if (chosen.truncate) yield* resize(file, 0n, "open")
          }
          file.openCount += 1
          acquired.file = file
          return fileHandle(acquired)
        }))
      }),
      unlink: Effect.fn("Caller.unlink")(function*(input: PathInput, options?: RelativeOptions) {
        const prepared = preparePath(input, "unlink", settings.maxPathBytes)
        const base = options?.relativeTo
        return yield* coordinated(Effect.gen(function*() {
          const path = yield* Effect.fromResult(prepared)
          const parent = yield* locate(path, base, "unlink", true)
          yield* authorize(parent, identity, 3, "unlink", input)
          const name = path.components.at(-1)
          if (name === undefined || name === "2e" || name === "2e2e") {
            return yield* failure("IsDirectory", "unlink", input)
          }
          const child = parent.entries.get(name)
          if (child === undefined) return yield* failure("NotFound", "unlink", input)
          if (child.kind === "directory") return yield* failure("IsDirectory", "unlink", input)
          if (path.trailingSlash) return yield* failure("NotDirectory", "unlink", input)
          yield* authorizeRemoval(parent, child, "unlink", input)
          const now = clock.currentTimeNanosUnsafe()
          parent.entries.delete(name)
          parent.metadata = { ...parent.metadata, mtimeNs: now, ctimeNs: now }
          detach(child, now)
          entries -= 1
        }))
      }),
      rename: Effect.fn("Caller.rename")(function*(
        source: PathInput,
        destination: PathInput,
        options?: { readonly sourceRelativeTo?: DirectoryHandle; readonly destinationRelativeTo?: DirectoryHandle }
      ) {
        const oldPrepared = preparePath(source, "rename", settings.maxPathBytes)
        const newPrepared = preparePath(destination, "rename", settings.maxPathBytes)
        const oldBase = options?.sourceRelativeTo
        const newBase = options?.destinationRelativeTo
        return yield* coordinated(Effect.gen(function*() {
          const oldPath = yield* Effect.fromResult(oldPrepared)
          const newPath = yield* Effect.fromResult(newPrepared)
          const oldParent = yield* locate(oldPath, oldBase, "rename", true)
          const newParent = yield* locate(newPath, newBase, "rename", true)
          yield* authorize(oldParent, identity, 3, "rename", source)
          yield* authorize(newParent, identity, 3, "rename", destination)
          const oldName = oldPath.components.at(-1)
          const newName = newPath.components.at(-1)
          if (
            oldName === undefined || newName === undefined || oldName === "2e" || oldName === "2e2e" ||
            newName === "2e" || newName === "2e2e"
          ) {
            return yield* failure("InvalidArgument", "rename", source)
          }
          const child = oldParent.entries.get(oldName)
          if (child === undefined) return yield* failure("NotFound", "rename", source)
          const replaced = newParent.entries.get(newName)
          if (newPath.trailingSlash && replaced === undefined) return yield* failure("NotFound", "rename", destination)
          if (oldPath.trailingSlash && child.kind !== "directory") {
            return yield* failure("NotDirectory", "rename", source)
          }
          if (newPath.trailingSlash && replaced?.kind !== "directory") {
            return yield* failure("NotDirectory", "rename", destination)
          }
          if (child === replaced) return
          yield* authorizeRemoval(oldParent, child, "rename", source)
          if (replaced !== undefined) {
            yield* authorizeRemoval(newParent, replaced, "rename", destination)
            if (child.kind === "directory" && replaced.kind !== "directory") {
              return yield* failure("NotDirectory", "rename", destination)
            }
            if (child.kind !== "directory" && replaced.kind === "directory") {
              return yield* failure("IsDirectory", "rename", destination)
            }
            if (replaced.kind === "directory" && replaced.entries.size > 0) {
              return yield* failure("NotEmpty", "rename", destination)
            }
          }
          for (let ancestor: Directory | undefined = newParent; ancestor !== undefined; ancestor = ancestor.parent) {
            if (ancestor === child) return yield* failure("InvalidArgument", "rename", destination)
          }
          const now = clock.currentTimeNanosUnsafe()
          // All rejection checks precede namespace, ancestry, quota, and metadata publication.
          oldParent.entries.delete(oldName)
          newParent.entries.set(newName, child)
          if (child.kind === "directory") child.parent = newParent
          oldParent.metadata = {
            ...oldParent.metadata,
            nlink: oldParent.metadata.nlink - (child.kind === "directory" ? 1 : 0),
            mtimeNs: now,
            ctimeNs: now
          }
          newParent.metadata = {
            ...newParent.metadata,
            nlink: newParent.metadata.nlink + (child.kind === "directory" && replaced === undefined ? 1 : 0),
            mtimeNs: now,
            ctimeNs: now
          }
          child.metadata = { ...child.metadata, ctimeNs: now }
          if (replaced !== undefined) {
            detach(replaced, now)
            entries -= 1
          }
        }))
      }),
      rmdir: Effect.fn("Caller.rmdir")(function*(input: PathInput, options?: RelativeOptions) {
        const prepared = preparePath(input, "rmdir", settings.maxPathBytes)
        const base = options?.relativeTo
        return yield* coordinated(Effect.gen(function*() {
          const path = yield* Effect.fromResult(prepared)
          const parent = yield* locate(path, base, "rmdir", true)
          yield* authorize(parent, identity, 3, "rmdir", input)
          const name = path.components.at(-1)
          if (name === undefined || name === "2e" || name === "2e2e") {
            return yield* failure("InvalidArgument", "rmdir", input)
          }
          const child = parent.entries.get(name)
          if (child === undefined) return yield* failure("NotFound", "rmdir", input)
          yield* authorizeRemoval(parent, child, "rmdir", input)
          if (child.kind !== "directory") return yield* failure("NotDirectory", "rmdir", input)
          if (child.entries.size > 0) return yield* failure("NotEmpty", "rmdir", input)
          const now = clock.currentTimeNanosUnsafe()
          parent.entries.delete(name)
          parent.metadata = { ...parent.metadata, nlink: parent.metadata.nlink - 1, mtimeNs: now, ctimeNs: now }
          child.parent = undefined
          child.metadata = { ...child.metadata, nlink: 0, ctimeNs: now }
          entries -= 1
        }))
      }),
      stat: Effect.fn("Caller.stat")(function*(input: PathInput, options?: RelativeOptions) {
        const prepared = preparePath(input, "stat", settings.maxPathBytes)
        const base = options?.relativeTo
        return yield* coordinated(Effect.gen(function*() {
          const path = yield* Effect.fromResult(prepared)
          const directory = yield* resolveNode(path, base, "stat")
          return { ...directory.metadata }
        }))
      }),
      mkdir: Effect.fn("Caller.mkdir")(
        function*(input: PathInput, options?: RelativeOptions & { readonly mode?: number }) {
          const prepared = preparePath(input, "mkdir", settings.maxPathBytes)
          const base = options?.relativeTo
          const mode = options?.mode === undefined ? 0o777 : options.mode
          if (!Schema.is(Mode)(mode)) return yield* failure("InvalidArgument", "mkdir", input)
          return yield* coordinated(Effect.gen(function*() {
            const path = yield* Effect.fromResult(prepared)
            const parent = yield* locate(path, base, "mkdir", true)
            yield* authorize(parent, identity, 3, "mkdir", input)
            const name = path.components.at(-1)
            if (name === undefined || name === "2e" || name === "2e2e" || parent.entries.has(name)) {
              return yield* failure("AlreadyExists", "mkdir", input)
            }
            if (settings.maxEntries !== undefined && entries >= settings.maxEntries) {
              return yield* failure("NoSpace", "mkdir", input)
            }
            const now = clock.currentTimeNanosUnsafe()
            const child: Directory = {
              kind: "directory",
              parent,
              entries: new Map(),
              metadata: directoryMetadata(
                nextInode,
                identity.uid,
                parent.metadata.gid,
                (mode & 0o777 & ~umask) | (mode & 0o1000),
                now
              )
            }
            const parentMetadata = { ...parent.metadata, nlink: parent.metadata.nlink + 1, mtimeNs: now, ctimeNs: now }
            // No Effect yield or expected failure between these publication writes.
            parent.entries.set(name, child)
            parent.metadata = parentMetadata
            nextInode += 1n
            entries += 1
          }))
        }
      ),
      withDirectory: Effect.fn("Caller.withDirectory")(function*(input: PathInput, options?: RelativeOptions) {
        const acquired = yield* acquireDirectory(input, options, "withDirectory")
        return createCaller(acquired, identity, umask)
      }),
      openDirectory: Effect.fn("Caller.openDirectory")(function*(input: PathInput, options?: RelativeOptions) {
        const acquired = yield* acquireDirectory(input, options, "openDirectory")
        const handle: DirectoryHandle = Object.freeze({
          [DirectoryHandleId]: true as const,
          stat: Effect.fn("DirectoryHandle.stat")(function*() {
            return yield* coordinated(Effect.suspend(() =>
              acquired.directory === undefined
                ? Effect.fail(failure("InvalidHandle", "stat"))
                : Effect.succeed({ ...acquired.directory.metadata })
            ))
          }),
          close: Effect.fn("DirectoryHandle.close")(function*() {
            return yield* coordinated(Effect.suspend(() => {
              if (acquired.directory === undefined) return Effect.fail(failure("InvalidHandle", "close"))
              acquired.directory = undefined
              acquired.closed = true
              return Effect.void
            }))
          })
        })
        handles.set(handle, acquired)
        return handle
      })
    })
  }

  const volume: Volume = Object.freeze({
    [VolumeId]: true as const,
    caller: Effect.fn("Volume.caller")(function*(options?: RootCallerOptions) {
      const decoded = decodeConfiguration(RootCallerOptions, options === undefined ? {} : options)
      if (Result.isFailure(decoded)) return yield* decoded.failure
      const chosen = decoded.success.identity ?? { uid: 0, gid: 0, groups: [], privileged: true }
      const identity = Object.freeze({ ...chosen, groups: Object.freeze([...chosen.groups]) })
      return createCaller(
        { volume: volumeIdentity, directory: root, closed: false },
        identity,
        decoded.success.umask ?? 0o022
      )
    })
  })
  return volume
})
