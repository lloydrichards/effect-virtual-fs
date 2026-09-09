/** Runtime-neutral virtual filesystem with independently scoped capabilities. */
import * as Image from "./internal/image.js"
export { DecodeLimits, decodeSnapshot, encodeSnapshot, ImageError, type Snapshot } from "./internal/image.js"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as PubSub from "effect/PubSub"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as SchemaIssue from "effect/SchemaIssue"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"

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
  "SymlinkLoop",
  "UnrepresentableName"
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
// Match snapshot v1's canonical signed decimal timestamp domain.
const timestampLimit = 10n ** 128n - 1n
const Timestamp = Schema.BigInt.check(
  Schema.isGreaterThanOrEqualToBigInt(-timestampLimit),
  Schema.isLessThanOrEqualToBigInt(timestampLimit)
)
export const Metadata = Schema.Struct({
  kind: Schema.Literals(["directory", "file", "symlink"]),
  ino: Schema.BigInt,
  nlink: Natural,
  size: Schema.BigInt,
  uid: Natural,
  gid: Natural,
  mode: Mode,
  atimeNs: Timestamp,
  mtimeNs: Timestamp,
  ctimeNs: Timestamp,
  birthtimeNs: Timestamp
})
export type Metadata = typeof Metadata.Type

export interface RelativeOptions {
  readonly relativeTo?: DirectoryHandle
}
export interface MetadataOptions extends RelativeOptions {
  readonly followFinalSymlink?: boolean
}
export const OwnerUpdate = Schema.Struct({ uid: Schema.optionalKey(Natural), gid: Schema.optionalKey(Natural) })
export type OwnerUpdate = typeof OwnerUpdate.Type
export const TimeUpdate = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("now") }),
  Schema.Struct({ kind: Schema.Literal("omit") }),
  Schema.Struct({ kind: Schema.Literal("value"), nanoseconds: Timestamp })
])
export const Times = Schema.Struct({ access: TimeUpdate, modification: TimeUpdate })
export type Times = typeof Times.Type
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
const WriteFileSettings = Schema.Struct({
  ...OpenSettings.fields,
  replaceFinalSymlink: Schema.optionalKey(Schema.Boolean),
  finalMode: Schema.optionalKey(Mode)
})
export type WriteFileOptions = typeof WriteFileSettings.Type & RelativeOptions
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
  readonly readFile: (path: PathInput, options?: RelativeOptions) => Effect.Effect<Uint8Array, FsError>
  readonly writeFile: (path: PathInput, bytes: Uint8Array, options: WriteFileOptions) => Effect.Effect<void, FsError>
  readonly access: (path: PathInput, bits?: number, options?: RelativeOptions) => Effect.Effect<void, FsError>
  readonly truncate: (path: PathInput, length: bigint, options?: RelativeOptions) => Effect.Effect<void, FsError>
  readonly chmod: (path: PathInput, mode: number, options?: MetadataOptions) => Effect.Effect<void, FsError>
  readonly chown: (path: PathInput, owner: OwnerUpdate, options?: MetadataOptions) => Effect.Effect<void, FsError>
  readonly utimes: (path: PathInput, times: Times, options?: MetadataOptions) => Effect.Effect<void, FsError>
  readonly chmodHandle: (handle: FileHandle | DirectoryHandle, mode: number) => Effect.Effect<void, FsError>
  readonly chownHandle: (handle: FileHandle | DirectoryHandle, owner: OwnerUpdate) => Effect.Effect<void, FsError>
  readonly utimesHandle: (handle: FileHandle | DirectoryHandle, times: Times) => Effect.Effect<void, FsError>
  readonly lstat: (path: PathInput, options?: RelativeOptions) => Effect.Effect<Metadata, FsError>
  readonly link: (
    source: PathInput,
    destination: PathInput,
    options?: {
      readonly sourceRelativeTo?: DirectoryHandle
      readonly destinationRelativeTo?: DirectoryHandle
      readonly followSourceSymlink?: boolean
    }
  ) => Effect.Effect<void, FsError>
  readonly symlink: (target: PathInput, path: PathInput, options?: RelativeOptions) => Effect.Effect<void, FsError>
  readonly readLink: (path: PathInput, options?: RelativeOptions) => Effect.Effect<string, FsError>
  readonly readLinkBytes: (path: PathInput, options?: RelativeOptions) => Effect.Effect<Uint8Array, FsError>
  readonly readDirectory: (path: PathInput, options?: RelativeOptions) => Effect.Effect<ReadonlyArray<string>, FsError>
  readonly readDirectoryBytes: (
    path: PathInput,
    options?: RelativeOptions
  ) => Effect.Effect<ReadonlyArray<Uint8Array>, FsError>
  readonly realPath: (path: PathInput, options?: RelativeOptions) => Effect.Effect<string, FsError>
  readonly realPathBytes: (path: PathInput, options?: RelativeOptions) => Effect.Effect<BytePath, FsError>
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
export interface Change {
  readonly _tag: "Create" | "Update" | "Remove"
  readonly path: BytePath
}
export interface Volume {
  // oxlint-disable-next-line effecttsgo/lazy-effect -- Explicit scoped subscription establishes readiness.
  readonly watch: () => Effect.Effect<Stream.Stream<Change>, never, Scope.Scope>
  // oxlint-disable-next-line effecttsgo/lazy-effect -- Capture is an explicit operation.
  readonly snapshot: () => Effect.Effect<Image.Snapshot, Image.ImageError>
  readonly [VolumeId]: true
  readonly caller: (options?: RootCallerOptions) => Effect.Effect<Caller, ConfigurationError>
}
export class CurrentFileSystem
  extends Context.Service<CurrentFileSystem, Caller>()("@effect-vfs/core/CurrentFileSystem")
{}

const bytePaths = new WeakMap<BytePath, Uint8Array>()
const failure = (code: FsCode, operation: string, path?: PathInput) =>
  new FsError({ code, operation, ...(path === undefined ? {} : { path }) })

const ownedPath = (bytes: Uint8Array): BytePath => {
  const path: BytePath = Object.freeze({ [BytePathId]: true as const })
  bytePaths.set(path, bytes)
  return path
}
const strictString = (bytes: Uint8Array, operation: string) =>
  Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    catch: () => failure("UnrepresentableName", operation)
  })
const nameBytes = (name: string): Uint8Array => {
  const bytes = new Uint8Array(name.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(name.slice(i * 2, i * 2 + 2), 16)
  return bytes
}
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
interface SymbolicLink {
  readonly kind: "symlink"
  readonly target: Uint8Array
  metadata: Metadata
}
type Node = Directory | RegularFile | SymbolicLink
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

interface LookupOptions {
  readonly followFinalSymlink?: boolean
  readonly allowMissing?: boolean
  readonly parentOnly?: boolean
}

interface PreparedPath {
  readonly input: PathInput
  readonly absolute: boolean
  readonly trailingSlash: boolean
  readonly bytes: Uint8Array
  readonly suffixes: ReadonlyArray<Uint8Array>
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
  const suffixes: Array<Uint8Array> = []
  let start = 0
  for (let index = 0; index <= bytes.length; index++) {
    if (index !== bytes.length && bytes[index] !== 47) continue
    if (index > start) {
      // Provisional component bound from decision 0019; names are compared as bytes.
      if (index - start > 255) return Result.fail(failure("PathTooLong", operation, input))
      components.push(Encoding.encodeHex(bytes.subarray(start, index)))
      suffixes.push(bytes.subarray(index))
    }
    start = index + 1
  }
  return Result.succeed({
    input,
    absolute: bytes[0] === 47,
    trailingSlash: bytes.at(-1) === 47,
    bytes,
    suffixes,
    components
  })
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

const storedMetadata = (metadata: Metadata): Image.StoredMetadata => ({
  uid: metadata.uid,
  gid: metadata.gid,
  mode: metadata.mode,
  atimeNs: String(metadata.atimeNs),
  mtimeNs: String(metadata.mtimeNs),
  ctimeNs: String(metadata.ctimeNs),
  birthtimeNs: String(metadata.birthtimeNs)
})

/** Each execution constructs a fresh volume and captures its Clock. */
const makeVolume = Effect.fn("VirtualFileSystem.makeVolume")(
  function*(options?: VolumeOptions, image?: Image.Document) {
    const decoded = decodeConfiguration(VolumeOptions, options === undefined ? {} : options)
    if (Result.isFailure(decoded)) return yield* decoded.failure
    const settings = { ...decoded.success }
    const clock = yield* Clock.clockWith(Effect.succeed)
    const initialTime = clock.currentTimeNanosUnsafe()
    if (!Schema.is(Timestamp)(initialTime)) {
      return yield* new ConfigurationError({ field: "clock.currentTimeNanos" })
    }
    const timestamp = (operation: string) =>
      Effect.suspend(() => {
        const now = clock.currentTimeNanosUnsafe()
        return Schema.is(Timestamp)(now) ? Effect.succeed(now) : Effect.fail(failure("InvalidArgument", operation))
      })
    const volumeIdentity = Symbol()
    const gate = Semaphore.makeUnsafe(1)
    const root: Directory = {
      kind: "directory",
      parent: undefined,
      entries: new Map(),
      metadata: directoryMetadata(1n, 0, 0, 0o755, initialTime)
    }
    let nextInode = 2n
    let entries = 0
    let usedBytes = 0
    const maxFileBytes = settings.maxFileBytes ?? 0xffffffff

    if (image !== undefined) {
      const incoming = new Map<string, Node>()
      let content = 0
      let count = 0
      for (const record of image.records) {
        if (record.kind === "directory") count += record.entries.length
        else {
          const length = Image.decodedLength(record.kind === "file" ? record.data : record.target)
          if (record.kind === "file" && length > maxFileBytes) {
            return yield* new Image.ImageError({ code: "LimitExceeded", field: "maxFileBytes" })
          }
          content += length
        }
      }
      if (
        (settings.maxEntries !== undefined && count > settings.maxEntries) ||
        (settings.maxBytes !== undefined && content > settings.maxBytes)
      ) {
        return yield* new Image.ImageError({ code: "LimitExceeded", field: "volume" })
      }
      for (const record of image.records) {
        const metadata: Metadata = {
          ...record.metadata,
          kind: record.kind,
          ino: record.id === image.root ? 1n : nextInode++,
          nlink: record.kind === "directory" ? 2 : 0,
          size: 0n,
          atimeNs: BigInt(record.metadata.atimeNs),
          mtimeNs: BigInt(record.metadata.mtimeNs),
          ctimeNs: BigInt(record.metadata.ctimeNs),
          birthtimeNs: BigInt(record.metadata.birthtimeNs)
        }
        if (record.kind === "directory") {
          const node: Directory = record.id === image.root
            ? root
            : { kind: "directory", parent: undefined, entries: new Map(), metadata }
          node.metadata = metadata
          incoming.set(record.id, node)
        } else if (record.kind === "file") {
          const data = Image.bytes(record.data)
          incoming.set(record.id, {
            kind: "file",
            data,
            openCount: 0,
            metadata: { ...metadata, size: BigInt(data.length) }
          })
        } else {
          const target = Image.bytes(record.target)
          incoming.set(record.id, { kind: "symlink", target, metadata: { ...metadata, size: BigInt(target.length) } })
        }
      }
      for (const record of image.records) {
        if (record.kind !== "directory") continue
        const parent = incoming.get(record.id)
        if (parent?.kind !== "directory") return yield* new Image.ImageError({ code: "InvalidStructure" })
        for (const entry of record.entries) {
          const node = incoming.get(entry.target)
          if (node === undefined) return yield* new Image.ImageError({ code: "InvalidStructure" })
          parent.entries.set(Encoding.encodeHex(Image.bytes(entry.name)), node)
          if (node.kind === "directory") {
            node.parent = parent
            parent.metadata = { ...parent.metadata, nlink: parent.metadata.nlink + 1 }
          } else node.metadata = { ...node.metadata, nlink: node.metadata.nlink + 1 }
        }
      }
      entries = count
      usedBytes = content
    }

    const events = yield* PubSub.unbounded<Change>()
    let subscribers = 0
    const directoryHex = (directory: Directory): string => {
      const names: Array<string> = []
      let current = directory
      while (current.parent !== undefined) {
        const parent = current.parent
        const found = [...parent.entries].find(([, node]) => node === current)
        if (found === undefined) break
        names.push(found[0])
        current = parent
      }
      return "2f" + names.reverse().join("2f")
    }
    const publishEntry = (_tag: Change["_tag"], parent: Directory, name: string) => {
      if (subscribers === 0) return
      const prefix = directoryHex(parent)
      PubSub.publishUnsafe(events, { _tag, path: ownedPath(nameBytes(prefix + (prefix === "2f" ? "" : "2f") + name)) })
    }
    const publishNode = (target: Node) => {
      if (subscribers === 0) return
      if (target === root) {
        PubSub.publishUnsafe(events, { _tag: "Update" as const, path: ownedPath(new Uint8Array([47])) })
      }
      const pending: Array<readonly [Directory, string]> = [[root, "2f"]]
      while (pending.length > 0) {
        const next = pending.pop()
        if (next === undefined) break
        const [directory, prefix] = next
        for (const [name, node] of directory.entries) {
          const path = prefix + name
          if (node === target) {
            PubSub.publishUnsafe(events, { _tag: "Update" as const, path: ownedPath(nameBytes(path)) })
          }
          if (node.kind === "directory") pending.push([node, path + "2f"])
        }
      }
    }

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
        if (node.kind === "file") reclaim(node)
        else if (node.metadata.nlink === 0) usedBytes -= node.target.length
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
        const now = yield* timestamp(operation)
        usedBytes += size - file.data.length
        file.data = data
        file.metadata = {
          ...file.metadata,
          size: length,
          mode: file.metadata.mode & ~0o6000,
          mtimeNs: now,
          ctimeNs: now
        }
        publishNode(file)
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
          if (typeof offset !== "bigint" || offset < 0n || offset > 0x7fffffffffffffffn) {
            return yield* failure("InvalidArgument", "read")
          }
          const start = Number(offset > file.metadata.size ? file.metadata.size : offset)
          const data = file.data.slice(start, start + Math.min(maximum, file.data.length - start))
          if (maximum > 0) {
            file.metadata = { ...file.metadata, atimeNs: (yield* timestamp("read")) }
          }
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
            if (typeof offset !== "bigint" || offset < 0n || offset > 0x7fffffffffffffffn) {
              return yield* failure("InvalidArgument", "write")
            }
            if (bytes.length === 0) {
              return 0
            }
            if (offset >= BigInt(maxFileBytes)) return yield* failure("FileTooLarge", "write")
            const start = Number(offset)
            const free = (settings.maxBytes ?? Number.MAX_SAFE_INTEGER) - usedBytes
            const end = Math.min(maxFileBytes, file.data.length + free)
            const count = Math.min(bytes.length, Math.max(0, end - start))
            if (count === 0) return yield* failure("NoSpace", "write")
            const size = Math.max(file.data.length, start + count)
            const data = size === file.data.length ? file.data : new Uint8Array(size)
            if (data !== file.data) data.set(file.data)
            const now = yield* timestamp("write")
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
            publishNode(file)
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
            if (typeof offset !== "bigint" || !Schema.is(SeekMode)(mode)) {
              return yield* failure("InvalidArgument", "seek")
            }
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
      const lookup = Effect.fnUntraced(function*(
        path: PreparedPath,
        base: DirectoryHandle | undefined,
        operation: string,
        options: LookupOptions = {}
      ) {
        const { followFinalSymlink = true, allowMissing = false, parentOnly = false } = options
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
        if (current.metadata.nlink === 0) return yield* failure("NotFound", operation, path.input)
        let work = path
        let parent: Directory | undefined
        let name: string | undefined
        let traversals = 0
        for (let index = 0; index < work.components.length - (parentOnly ? 1 : 0); index++) {
          if (current.kind !== "directory") return yield* failure("NotDirectory", operation, path.input)
          yield* authorize(current, identity, 1, operation, path.input)
          const component = work.components[index]
          if (component === undefined) break
          if (component === "2e") continue
          if (component === "2e2e") {
            current = current.parent ?? current
            parent = undefined
            name = undefined
            continue
          }
          parent = current
          name = component
          const child = current.entries.get(component)
          if (child === undefined) {
            if (allowMissing && index === work.components.length - 1 && !work.trailingSlash) {
              return { node: undefined, parent, name }
            }
            return yield* failure("NotFound", operation, path.input)
          }
          if (
            child.kind === "symlink" && (followFinalSymlink || index < work.components.length - 1 || work.trailingSlash)
          ) {
            if (child.target.length === 0) return yield* failure("NotFound", operation, path.input)
            if (++traversals > 40) return yield* failure("SymlinkLoop", operation, path.input)
            const suffix = work.suffixes[index] ?? new Uint8Array(0)
            if (settings.maxPathBytes !== undefined && child.target.length + suffix.length > settings.maxPathBytes) {
              return yield* failure("PathTooLong", operation, path.input)
            }
            const expansion = new Uint8Array(child.target.length + suffix.length)
            expansion.set(child.target)
            expansion.set(suffix, child.target.length)
            work = yield* Effect.fromResult(preparePath(ownedPath(expansion), operation, settings.maxPathBytes))
            if (work.absolute) current = root
            index = -1
          } else current = child
        }
        if (!parentOnly && work.trailingSlash && current.kind !== "directory") {
          return yield* failure("NotDirectory", operation, path.input)
        }
        return { node: current, parent, name }
      })
      const resolveNode = Effect.fnUntraced(
        function*(
          path: PreparedPath,
          base: DirectoryHandle | undefined,
          operation: string,
          options?: Pick<LookupOptions, "followFinalSymlink">
        ) {
          const result = yield* lookup(path, base, operation, options)
          if (result.node === undefined) return yield* failure("NotFound", operation, path.input)
          return result.node
        }
      )
      const locate = Effect.fnUntraced(
        function*(
          path: PreparedPath,
          base: DirectoryHandle | undefined,
          operation: string,
          options?: Pick<LookupOptions, "parentOnly">
        ) {
          const result = yield* lookup(path, base, operation, options)
          const node = result.node
          if (node === undefined) return yield* failure("NotFound", operation, path.input)
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

      const list = Effect.fnUntraced(function*(input: PathInput, options?: RelativeOptions) {
        const prepared = preparePath(input, "readDirectory", settings.maxPathBytes)
        const base = options?.relativeTo
        return yield* coordinated(Effect.gen(function*() {
          const directory = yield* locate(yield* Effect.fromResult(prepared), base, "readDirectory")
          yield* authorize(directory, identity, 4, "readDirectory", input)
          const result = [...directory.entries.keys()].map(nameBytes)
          directory.metadata = { ...directory.metadata, atimeNs: (yield* timestamp("readDirectory")) }
          return result
        }))
      })
      const readTarget = Effect.fnUntraced(function*(input: PathInput, options?: RelativeOptions) {
        const prepared = preparePath(input, "readLink", settings.maxPathBytes)
        const base = options?.relativeTo
        return yield* coordinated(Effect.gen(function*() {
          const node = yield* resolveNode(yield* Effect.fromResult(prepared), base, "readLink", {
            followFinalSymlink: false
          })
          if (node.kind !== "symlink") return yield* failure("InvalidArgument", "readLink", input)
          return new Uint8Array(node.target)
        }))
      })
      const canonical = Effect.fnUntraced(function*(input: PathInput, options?: RelativeOptions) {
        const prepared = preparePath(input, "realPath", settings.maxPathBytes)
        const base = options?.relativeTo
        return yield* coordinated(Effect.gen(function*() {
          const result = yield* lookup(yield* Effect.fromResult(prepared), base, "realPath")
          const components: Array<string> = []
          if (result.node?.kind !== "directory" && result.name !== undefined) components.push(result.name)
          let directory = result.node?.kind === "directory" ? result.node : result.parent
          while (directory !== undefined && directory.parent !== undefined) {
            const parent: Directory = directory.parent
            const entry = [...parent.entries].find(([, child]) => child === directory)
            if (entry === undefined) return yield* failure("NotFound", "realPath", input)
            components.push(entry[0])
            directory = parent
          }
          return nameBytes("2f" + components.reverse().join("2f"))
        }))
      })

      const metadataNode = Effect.fnUntraced(
        function*(
          target: PathInput | FileHandle | DirectoryHandle,
          options: MetadataOptions | undefined,
          operation: string
        ) {
          if (reference.directory === undefined) return yield* failure("ClosedCaller", operation)
          if (
            typeof target === "object" && target !== null && (FileHandleId in target || DirectoryHandleId in target)
          ) {
            const ref = FileHandleId in target ? files.get(target) : handles.get(target)
            if (ref === undefined) return yield* failure("InvalidHandle", operation)
            if (ref.volume !== volumeIdentity) return yield* failure("ForeignHandle", operation)
            const node = "file" in ref ? ref.file : ref.directory
            if (node === undefined) return yield* failure("InvalidHandle", operation)
            return node
          }
          const path = yield* Effect.fromResult(preparePath(target, operation, settings.maxPathBytes))
          return yield* resolveNode(path, options?.relativeTo, operation, {
            followFinalSymlink: options?.followFinalSymlink !== false
          })
        }
      )
      const permittedMode = (
        metadata: Pick<Metadata, "kind" | "uid" | "gid">,
        mode: number,
        operation: string,
        path?: PathInput
      ) => {
        if (!identity.privileged && identity.uid !== metadata.uid) {
          return Effect.fail(failure("AccessDenied", operation, path))
        }
        const group = identity.gid === metadata.gid || identity.groups.includes(metadata.gid)
        return Effect.succeed(!identity.privileged && metadata.kind === "file" && !group ? mode & ~0o2000 : mode)
      }
      const changeMode = Effect.fnUntraced(
        function*(target: PathInput | FileHandle | DirectoryHandle, mode: number, options?: MetadataOptions) {
          if (!Schema.is(Mode)(mode)) return yield* failure("InvalidArgument", "chmod")
          const chosen = options === undefined ? undefined : { ...options }
          return yield* coordinated(Effect.gen(function*() {
            const node = yield* metadataNode(target, chosen, "chmod")
            const permitted = yield* permittedMode(node.metadata, mode, "chmod")
            node.metadata = {
              ...node.metadata,
              mode: permitted,
              ctimeNs: (yield* timestamp("chmod"))
            }
            publishNode(node)
          }))
        }
      )
      const changeOwner = Effect.fnUntraced(
        function*(target: PathInput | FileHandle | DirectoryHandle, owner: OwnerUpdate, options?: MetadataOptions) {
          const decoded = Schema.decodeResult(OwnerUpdate, { onExcessProperty: "error" })(owner)
          if (Result.isFailure(decoded)) return yield* failure("InvalidArgument", "chown")
          const update = { ...decoded.success }
          const chosen = options === undefined ? undefined : { ...options }
          return yield* coordinated(Effect.gen(function*() {
            const node = yield* metadataNode(target, chosen, "chown")
            if (
              !identity.privileged && (identity.uid !== node.metadata.uid ||
                (update.uid !== undefined && update.uid !== node.metadata.uid) ||
                (update.gid !== undefined && update.gid !== identity.gid && !identity.groups.includes(update.gid)))
            ) {
              return yield* failure("AccessDenied", "chown")
            }
            if (update.uid === undefined && update.gid === undefined) return
            node.metadata = {
              ...node.metadata,
              uid: update.uid ?? node.metadata.uid,
              gid: update.gid ?? node.metadata.gid,
              mode: node.kind === "file" ? node.metadata.mode & ~0o6000 : node.metadata.mode,
              ctimeNs: (yield* timestamp("chown"))
            }
            publishNode(node)
          }))
        }
      )
      const changeTimes = Effect.fnUntraced(
        function*(target: PathInput | FileHandle | DirectoryHandle, times: Times, options?: MetadataOptions) {
          const decoded = Schema.decodeResult(Times, { onExcessProperty: "error" })(times)
          if (Result.isFailure(decoded)) return yield* failure("InvalidArgument", "utimes")
          const access = { ...decoded.success.access }
          const modification = { ...decoded.success.modification }
          const chosen = options === undefined ? undefined : { ...options }
          return yield* coordinated(Effect.gen(function*() {
            const node = yield* metadataNode(target, chosen, "utimes")
            if (access.kind === "omit" && modification.kind === "omit") return
            if (!identity.privileged && identity.uid !== node.metadata.uid) {
              if (access.kind !== "now" || modification.kind !== "now") return yield* failure("AccessDenied", "utimes")
              yield* authorize(node, identity, 2, "utimes", "/")
            }
            const now = yield* timestamp("utimes")
            node.metadata = {
              ...node.metadata,
              atimeNs: access.kind === "omit"
                ? node.metadata.atimeNs
                : access.kind === "now"
                ? now
                : access.nanoseconds,
              mtimeNs: modification.kind === "omit"
                ? node.metadata.mtimeNs
                : modification.kind === "now"
                ? now
                : modification.nanoseconds,
              ctimeNs: now
            }
            publishNode(node)
          }))
        }
      )

      const authorizeRemoval = (parent: Directory, child: Node, operation: string, input: PathInput) =>
        (parent.metadata.mode & 0o1000) !== 0 && !identity.privileged &&
          identity.uid !== parent.metadata.uid && identity.uid !== child.metadata.uid
          ? Effect.fail(failure("AccessDenied", operation, input))
          : Effect.void

      return Object.freeze({
        [CallerId]: true as const,
        readFile: Effect.fn("Caller.readFile")(function*(input: PathInput, options?: RelativeOptions) {
          const prepared = preparePath(input, "readFile", settings.maxPathBytes)
          const base = options?.relativeTo
          return yield* coordinated(Effect.gen(function*() {
            const node = yield* resolveNode(yield* Effect.fromResult(prepared), base, "readFile")
            if (node.kind !== "file") return yield* failure("IsDirectory", "readFile", input)
            yield* authorize(node, identity, 4, "readFile", input)
            const data = new Uint8Array(node.data)
            node.metadata = { ...node.metadata, atimeNs: (yield* timestamp("readFile")) }
            return data
          }))
        }),
        writeFile: Effect.fn("Caller.writeFile")(
          function*(input: PathInput, bytes: Uint8Array, options: WriteFileOptions) {
            const prepared = preparePath(input, "writeFile", settings.maxPathBytes)
            if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || !attachedBuffer(bytes)) {
              return yield* failure("InvalidArgument", "writeFile", input)
            }
            const captured = new Uint8Array(bytes)
            const { relativeTo: base, ...raw } = options
            const decoded = Schema.decodeResult(WriteFileSettings, { onExcessProperty: "error" })(raw)
            if (Result.isFailure(decoded)) return yield* failure("InvalidArgument", "writeFile", input)
            const chosen = decoded.success
            return yield* coordinated(Effect.gen(function*() {
              const path = yield* Effect.fromResult(prepared)
              if (chosen.create === "exclusive") {
                const exists = yield* Effect.result(lookup(path, base, "writeFile", { followFinalSymlink: false }))
                if (Result.isSuccess(exists)) return yield* failure("AlreadyExists", "writeFile", input)
                if (exists.failure.code !== "NotFound") return yield* exists.failure
              }
              const resolved = yield* lookup(
                path,
                base,
                "writeFile",
                {
                  followFinalSymlink: chosen.replaceFinalSymlink !== true && chosen.followFinalSymlink !== false,
                  allowMissing: chosen.create === "ifMissing" || chosen.create === "exclusive"
                }
              )
              const { name, parent } = resolved
              if (parent === undefined || name === undefined || resolved.node?.kind === "directory") {
                return yield* failure("IsDirectory", "writeFile", input)
              }
              const replaced = resolved.node?.kind === "symlink" ? resolved.node : undefined
              if (replaced !== undefined && !chosen.replaceFinalSymlink) {
                return yield* failure("SymlinkLoop", "writeFile", input)
              }
              if (chosen.access === "read") return yield* failure("InvalidHandle", "writeFile", input)
              const file = resolved.node?.kind === "file" ? resolved.node : undefined
              if (file === undefined) {
                yield* authorize(parent, identity, 3, "writeFile", input)
                if (replaced !== undefined) yield* authorizeRemoval(parent, replaced, "writeFile", input)
                if (replaced === undefined && settings.maxEntries !== undefined && entries >= settings.maxEntries) {
                  return yield* failure("NoSpace", "writeFile", input)
                }
              } else yield* authorize(file, identity, chosen.access === "readWrite" ? 6 : 2, "writeFile", input)
              const finalMode = chosen.finalMode === undefined ? undefined : yield* permittedMode(
                file?.metadata ?? { kind: "file", uid: identity.uid, gid: parent.metadata.gid },
                chosen.finalMode,
                "writeFile",
                input
              )
              const previous = file?.data.length ?? 0
              const initial = chosen.truncate ? 0 : previous
              const position = chosen.append ? initial : 0
              const size = Math.max(initial, position + captured.length)
              if (size > maxFileBytes) return yield* failure("FileTooLarge", "writeFile", input)
              const reclaimed = replaced !== undefined && replaced.metadata.nlink === 1 ? replaced.target.length : 0
              if (size - previous > (settings.maxBytes ?? Number.MAX_SAFE_INTEGER) - usedBytes + reclaimed) {
                return yield* failure("NoSpace", "writeFile", input)
              }
              if (file !== undefined && !chosen.truncate && captured.length === 0 && chosen.finalMode === undefined) {
                return
              }
              const data = new Uint8Array(size)
              if (file !== undefined && !chosen.truncate) data.set(file.data)
              data.set(captured, position)
              const now = yield* timestamp("writeFile")
              const node: RegularFile = file ??
                {
                  kind: "file",
                  data,
                  openCount: 0,
                  metadata: {
                    ...directoryMetadata(
                      nextInode++,
                      identity.uid,
                      parent.metadata.gid,
                      (chosen.mode ?? 0o666) & 0o777 & ~umask,
                      now
                    ),
                    kind: "file",
                    nlink: 1
                  }
                }
              node.data = data
              node.metadata = {
                ...node.metadata,
                mode: finalMode ?? node.metadata.mode & ~0o6000,
                size: BigInt(size),
                mtimeNs: now,
                ctimeNs: now
              }
              usedBytes += size - previous
              if (file === undefined) {
                if (replaced !== undefined) detach(replaced, now)
                parent.entries.set(name, node)
                parent.metadata = { ...parent.metadata, mtimeNs: now, ctimeNs: now }
                if (replaced === undefined) entries += 1
                publishEntry(replaced === undefined ? "Create" : "Update", parent, name)
              } else publishNode(node)
            }))
          }
        ),
        chmod: Effect.fn("Caller.chmod")(function*(path: PathInput, mode: number, options?: MetadataOptions) {
          yield* changeMode(path, mode, options)
        }),
        chmodHandle: Effect.fn("Caller.chmodHandle")(function*(handle: FileHandle | DirectoryHandle, mode: number) {
          yield* changeMode(handle, mode)
        }),
        chown: Effect.fn("Caller.chown")(function*(path: PathInput, owner: OwnerUpdate, options?: MetadataOptions) {
          yield* changeOwner(path, owner, options)
        }),
        chownHandle: Effect.fn("Caller.chownHandle")(
          function*(handle: FileHandle | DirectoryHandle, owner: OwnerUpdate) {
            yield* changeOwner(handle, owner)
          }
        ),
        utimes: Effect.fn("Caller.utimes")(function*(path: PathInput, times: Times, options?: MetadataOptions) {
          yield* changeTimes(path, times, options)
        }),
        utimesHandle: Effect.fn("Caller.utimesHandle")(function*(handle: FileHandle | DirectoryHandle, times: Times) {
          yield* changeTimes(handle, times)
        }),
        access: Effect.fn("Caller.access")(function*(input: PathInput, bits = 0, options?: RelativeOptions) {
          const prepared = preparePath(input, "access", settings.maxPathBytes)
          const base = options?.relativeTo
          if (!Number.isInteger(bits) || bits < 0 || bits > 7) return yield* failure("InvalidArgument", "access", input)
          return yield* coordinated(Effect.gen(function*() {
            const node = yield* resolveNode(yield* Effect.fromResult(prepared), base, "access")
            if (node.kind === "file" && (bits & 1) !== 0 && (node.metadata.mode & 0o111) === 0) {
              return yield* failure("AccessDenied", "access", input)
            }
            yield* authorize(node, identity, bits, "access", input)
          }))
        }),
        truncate: Effect.fn("Caller.truncate")(function*(input: PathInput, length: bigint, options?: RelativeOptions) {
          const prepared = preparePath(input, "truncate", settings.maxPathBytes)
          const base = options?.relativeTo
          return yield* coordinated(Effect.gen(function*() {
            const node = yield* resolveNode(yield* Effect.fromResult(prepared), base, "truncate")
            if (node.kind !== "file") return yield* failure("IsDirectory", "truncate", input)
            yield* authorize(node, identity, 2, "truncate", input)
            yield* resize(node, length, "truncate")
          }))
        }),
        lstat: Effect.fn("Caller.lstat")(function*(input: PathInput, options?: RelativeOptions) {
          const prepared = preparePath(input, "lstat", settings.maxPathBytes)
          const base = options?.relativeTo
          return yield* coordinated(Effect.gen(function*() {
            const node = yield* resolveNode(yield* Effect.fromResult(prepared), base, "lstat", {
              followFinalSymlink: false
            })
            return { ...node.metadata }
          }))
        }),
        link: Effect.fn("Caller.link")(
          function*(
            source: PathInput,
            destination: PathInput,
            options?: {
              readonly sourceRelativeTo?: DirectoryHandle
              readonly destinationRelativeTo?: DirectoryHandle
              readonly followSourceSymlink?: boolean
            }
          ) {
            const a = preparePath(source, "link", settings.maxPathBytes)
            const b = preparePath(destination, "link", settings.maxPathBytes)
            const sourceBase = options?.sourceRelativeTo
            const destinationBase = options?.destinationRelativeTo
            const follow = options?.followSourceSymlink ?? false
            return yield* coordinated(Effect.gen(function*() {
              const node = yield* resolveNode(yield* Effect.fromResult(a), sourceBase, "link", {
                followFinalSymlink: follow
              })
              if (node.kind === "directory") return yield* failure("IsDirectory", "link", source)
              const path = yield* Effect.fromResult(b)
              const parent = yield* locate(path, destinationBase, "link", { parentOnly: true })
              yield* authorize(parent, identity, 3, "link", destination)
              const name = path.components.at(-1)
              if (name === undefined || name === "2e" || name === "2e2e" || parent.entries.has(name)) {
                return yield* failure("AlreadyExists", "link", destination)
              }
              if (path.trailingSlash) return yield* failure("NotDirectory", "link", destination)
              if (settings.maxEntries !== undefined && entries >= settings.maxEntries) {
                return yield* failure("NoSpace", "link", destination)
              }
              const now = yield* timestamp("link")
              parent.entries.set(name, node)
              parent.metadata = { ...parent.metadata, mtimeNs: now, ctimeNs: now }
              node.metadata = { ...node.metadata, nlink: node.metadata.nlink + 1, ctimeNs: now }
              entries += 1
              publishEntry("Create", parent, name)
            }))
          }
        ),
        symlink: Effect.fn("Caller.symlink")(function*(target: PathInput, input: PathInput, options?: RelativeOptions) {
          const prepared = preparePath(input, "symlink", settings.maxPathBytes)
          if (typeof target === "string" && !wellFormed(target)) {
            return yield* failure("InvalidPathEncoding", "symlink", target)
          }
          const rawTarget = typeof target === "string" ? new TextEncoder().encode(target) : bytePaths.get(target)
          if (rawTarget === undefined || rawTarget.includes(0)) {
            return yield* failure("InvalidArgument", "symlink", target)
          }
          const targetBytes = new Uint8Array(rawTarget)
          const base = options?.relativeTo
          return yield* coordinated(Effect.gen(function*() {
            const path = yield* Effect.fromResult(prepared)
            const bytes = targetBytes
            const parent = yield* locate(path, base, "symlink", { parentOnly: true })
            yield* authorize(parent, identity, 3, "symlink", input)
            const name = path.components.at(-1)
            if (name === undefined || name === "2e" || name === "2e2e" || parent.entries.has(name)) {
              return yield* failure("AlreadyExists", "symlink", input)
            }
            if (path.trailingSlash) return yield* failure("NotDirectory", "symlink", input)
            if (
              (settings.maxEntries !== undefined && entries >= settings.maxEntries) ||
              bytes.length > (settings.maxBytes ?? Number.MAX_SAFE_INTEGER) - usedBytes
            ) return yield* failure("NoSpace", "symlink", input)
            const now = yield* timestamp("symlink")
            const node: SymbolicLink = {
              kind: "symlink",
              target: new Uint8Array(bytes),
              metadata: {
                ...directoryMetadata(nextInode, identity.uid, parent.metadata.gid, 0o777, now),
                kind: "symlink",
                nlink: 1,
                size: BigInt(bytes.length)
              }
            }
            parent.entries.set(name, node)
            parent.metadata = { ...parent.metadata, mtimeNs: now, ctimeNs: now }
            nextInode += 1n
            entries += 1
            usedBytes += bytes.length
            publishEntry("Create", parent, name)
          }))
        }),
        readDirectoryBytes: Effect.fn("Caller.readDirectoryBytes")(
          function*(input: PathInput, options?: RelativeOptions) {
            return yield* list(input, options)
          }
        ),
        readDirectory: Effect.fn("Caller.readDirectory")(function*(input: PathInput, options?: RelativeOptions) {
          return yield* Effect.forEach(yield* list(input, options), (bytes) => strictString(bytes, "readDirectory"))
        }),
        readLinkBytes: Effect.fn("Caller.readLinkBytes")(function*(input: PathInput, options?: RelativeOptions) {
          return yield* readTarget(input, options)
        }),
        readLink: Effect.fn("Caller.readLink")(function*(input: PathInput, options?: RelativeOptions) {
          return yield* strictString(yield* readTarget(input, options), "readLink")
        }),
        realPathBytes: Effect.fn("Caller.realPathBytes")(function*(input: PathInput, options?: RelativeOptions) {
          return ownedPath(yield* canonical(input, options))
        }),
        realPath: Effect.fn("Caller.realPath")(function*(input: PathInput, options?: RelativeOptions) {
          return yield* strictString(yield* canonical(input, options), "realPath")
        }),
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
            if (chosen.create === "exclusive") {
              const existing = yield* Effect.result(lookup(path, base, "open", { followFinalSymlink: false }))
              if (Result.isSuccess(existing)) return yield* failure("AlreadyExists", "open", input)
              if (existing.failure.code !== "NotFound") return yield* existing.failure
            }
            const resolved = yield* lookup(
              path,
              base,
              "open",
              {
                followFinalSymlink: chosen.followFinalSymlink !== false,
                allowMissing: chosen.create === "ifMissing" || chosen.create === "exclusive"
              }
            )
            const parent = resolved.parent
            if (parent === undefined) return yield* failure("IsDirectory", "open", input)
            const name = resolved.name
            if (name === undefined || name === "2e" || name === "2e2e") {
              return yield* failure("IsDirectory", "open", input)
            }
            yield* authorize(parent, identity, 1, "open", input)
            let file = resolved.node
            if (file !== undefined && chosen.create === "exclusive") {
              return yield* failure("AlreadyExists", "open", input)
            }
            if (file === undefined) {
              if (chosen.create === undefined || chosen.create === "never" || path.trailingSlash) {
                return yield* failure("NotFound", "open", input)
              }
              yield* authorize(parent, identity, 3, "open", input)
              if (settings.maxEntries !== undefined && entries >= settings.maxEntries) {
                return yield* failure("NoSpace", "open", input)
              }
              const now = yield* timestamp("open")
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
              publishEntry("Create", parent, name)
            } else {
              if (file.kind === "symlink") return yield* failure("SymlinkLoop", "open", input)
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
            const parent = yield* locate(path, base, "unlink", { parentOnly: true })
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
            const now = yield* timestamp("unlink")
            parent.entries.delete(name)
            parent.metadata = { ...parent.metadata, mtimeNs: now, ctimeNs: now }
            detach(child, now)
            entries -= 1
            publishEntry("Remove", parent, name)
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
            const oldParent = yield* locate(oldPath, oldBase, "rename", { parentOnly: true })
            const newParent = yield* locate(newPath, newBase, "rename", { parentOnly: true })
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
            if (newPath.trailingSlash && replaced === undefined) {
              return yield* failure("NotFound", "rename", destination)
            }
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
            const now = yield* timestamp("rename")
            // All rejection checks precede namespace, ancestry, quota, and metadata publication.
            const oldEvent = subscribers > 0
              ? ownedPath(nameBytes(directoryHex(oldParent) + (oldParent === root ? "" : "2f") + oldName))
              : undefined
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
            if (oldEvent !== undefined) PubSub.publishUnsafe(events, { _tag: "Remove" as const, path: oldEvent })
            publishEntry("Create", newParent, newName)
          }))
        }),
        rmdir: Effect.fn("Caller.rmdir")(function*(input: PathInput, options?: RelativeOptions) {
          const prepared = preparePath(input, "rmdir", settings.maxPathBytes)
          const base = options?.relativeTo
          return yield* coordinated(Effect.gen(function*() {
            const path = yield* Effect.fromResult(prepared)
            const parent = yield* locate(path, base, "rmdir", { parentOnly: true })
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
            const now = yield* timestamp("rmdir")
            parent.entries.delete(name)
            parent.metadata = { ...parent.metadata, nlink: parent.metadata.nlink - 1, mtimeNs: now, ctimeNs: now }
            child.parent = undefined
            child.metadata = { ...child.metadata, nlink: 0, ctimeNs: now }
            entries -= 1
            publishEntry("Remove", parent, name)
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
              const parent = yield* locate(path, base, "mkdir", { parentOnly: true })
              yield* authorize(parent, identity, 3, "mkdir", input)
              const name = path.components.at(-1)
              if (name === undefined || name === "2e" || name === "2e2e" || parent.entries.has(name)) {
                return yield* failure("AlreadyExists", "mkdir", input)
              }
              if (settings.maxEntries !== undefined && entries >= settings.maxEntries) {
                return yield* failure("NoSpace", "mkdir", input)
              }
              const now = yield* timestamp("mkdir")
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
              const parentMetadata = {
                ...parent.metadata,
                nlink: parent.metadata.nlink + 1,
                mtimeNs: now,
                ctimeNs: now
              }
              // No Effect yield or expected failure between these publication writes.
              parent.entries.set(name, child)
              parent.metadata = parentMetadata
              nextInode += 1n
              entries += 1
              publishEntry("Create", parent, name)
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
      watch: Effect.fn("Volume.watch")(function*() {
        const subscription = yield* PubSub.subscribe(events)
        subscribers += 1
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            subscribers -= 1
          })
        )
        return Stream.fromEffectRepeat(PubSub.take(subscription))
      }),
      snapshot: Effect.fn("Volume.snapshot")(function*() {
        return yield* coordinated(Effect.gen(function*() {
          const ids = new Map<Node, string>([[root, "0"]])
          const pending: Array<Node> = [root]
          const records: Array<Image.Record> = []
          for (let index = 0; index < pending.length; index++) {
            const node = pending[index]
            if (node === undefined) continue
            const id = ids.get(node)
            if (id === undefined) return yield* new Image.ImageError({ code: "InvalidStructure" })
            const metadata = storedMetadata(node.metadata)
            if (node.kind === "directory") {
              const children: Array<{ name: string; target: string }> = []
              for (const [name, child] of node.entries) {
                let target = ids.get(child)
                if (target === undefined) {
                  target = String(ids.size)
                  ids.set(child, target)
                  pending.push(child)
                }
                children.push({ name: Encoding.encodeBase64(nameBytes(name)), target })
              }
              records.push({ id, kind: "directory", metadata, entries: children })
            } else if (node.kind === "file") {
              records.push({ id, kind: "file", metadata, data: Encoding.encodeBase64(node.data) })
            } else records.push({ id, kind: "symlink", metadata, target: Encoding.encodeBase64(node.target) })
          }
          return yield* Image.capture({ format: "effect-vfs", version: 1, root: "0", records })
        }))
      }),

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
  }
)

/** Creates a fresh empty volume. Image failures cannot arise without an image. */
export const make = Effect.fn("VirtualFileSystem.make")(function*(options?: VolumeOptions) {
  return yield* makeVolume(options).pipe(Effect.catchTag("ImageError", Effect.die))
})
export const fromSnapshot = Effect.fn("VirtualFileSystem.fromSnapshot")(
  function*(snapshot: Image.Snapshot, options?: VolumeOptions) {
    const image = yield* Image.inspect(snapshot)
    return yield* makeVolume(options, image)
  }
)

const FixtureMetadata = Schema.Struct({
  uid: Schema.optionalKey(Natural),
  gid: Schema.optionalKey(Natural),
  mode: Schema.optionalKey(Mode),
  atimeNs: Schema.optionalKey(Timestamp),
  mtimeNs: Schema.optionalKey(Timestamp),
  ctimeNs: Schema.optionalKey(Timestamp),
  birthtimeNs: Schema.optionalKey(Timestamp)
})
const FixturePath = Schema.Union([
  Schema.String,
  Schema.declare<BytePath>((value): value is BytePath =>
    typeof value === "object" && value !== null && BytePathId in value && value[BytePathId] === true
  )
])
export const Fixture = Schema.Struct({
  rootMetadata: Schema.optionalKey(FixtureMetadata),
  entries: Schema.Array(Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("directory"),
      path: FixturePath,
      metadata: Schema.optionalKey(FixtureMetadata)
    }),
    Schema.Struct({
      kind: Schema.Literal("file"),
      path: FixturePath,
      bytes: Schema.Uint8Array,
      metadata: Schema.optionalKey(FixtureMetadata)
    }),
    Schema.Struct({
      kind: Schema.Literal("symlink"),
      path: FixturePath,
      target: FixturePath,
      metadata: Schema.optionalKey(FixtureMetadata)
    }),
    Schema.Struct({ kind: Schema.Literal("hardLink"), path: FixturePath, target: FixturePath })
  ]))
})
export type Fixture = typeof Fixture.Type
export const fromFixture = Effect.fn("VirtualFileSystem.fromFixture")(
  function*(fixture: Fixture, options?: VolumeOptions) {
    const config = decodeConfiguration(VolumeOptions, options ?? {})
    if (Result.isFailure(config)) return yield* config.failure
    const decoded = Schema.decodeResult(Fixture, { onExcessProperty: "error" })(fixture)
    if (Result.isFailure(decoded)) return yield* new Image.ImageError({ code: "InvalidStructure", field: "fixture" })
    const source = decoded.success
    // Encode all mutable input bytes before any suspension or publication.
    const captured: Array<{ entry: Fixture["entries"][number]; data?: string }> = []
    for (const entry of source.entries) {
      if (entry.kind === "file") {
        if (!(entry.bytes.buffer instanceof ArrayBuffer) || !attachedBuffer(entry.bytes)) {
          return yield* new Image.ImageError({ code: "InvalidEncoding", field: "bytes" })
        }
        captured.push({ entry, data: Encoding.encodeBase64(new Uint8Array(entry.bytes)) })
      } else captured.push({ entry })
    }
    const metadata = (
      kind: "directory" | "file" | "symlink",
      overrides?: typeof FixtureMetadata.Type
    ): Image.StoredMetadata => ({
      uid: overrides?.uid ?? 0,
      gid: overrides?.gid ?? 0,
      mode: overrides?.mode ?? (kind === "directory" ? 0o755 : kind === "file" ? 0o644 : 0o777),
      atimeNs: String(overrides?.atimeNs ?? 0n),
      mtimeNs: String(overrides?.mtimeNs ?? 0n),
      ctimeNs: String(overrides?.ctimeNs ?? 0n),
      birthtimeNs: String(overrides?.birthtimeNs ?? 0n)
    })
    const declarations = new Map<string, Image.Record>()
    const aliases = new Map<string, string>()
    const paths = new Map<string, ReadonlyArray<string>>()
    const root: Image.Record = {
      id: "root",
      kind: "directory",
      metadata: metadata("directory", source.rootMetadata),
      entries: []
    }
    declarations.set("", root)
    const fixturePath = (input: PathInput) =>
      preparePath(input, "fixture", config.success.maxPathBytes).pipe(
        Result.flatMap((path) =>
          !path.absolute || path.components.length === 0 ||
            path.components.some((name) => name === "2e" || name === "2e2e")
            ? Result.fail(failure("InvalidArgument", "fixture", input)) :
            Result.succeed(path.components)
        )
      )
    for (const { entry, data } of captured) {
      const parsed = fixturePath(entry.path)
      if (Result.isFailure(parsed)) {
        return yield* new Image.ImageError({ code: "InvalidStructure", field: "path" })
      }
      const components = parsed.success
      const key = components.join("/")
      if (paths.has(key)) return yield* new Image.ImageError({ code: "InvalidStructure", field: "duplicate" })
      paths.set(key, components)
      if (entry.kind === "hardLink") {
        const target = fixturePath(entry.target)
        if (Result.isFailure(target)) return yield* new Image.ImageError({ code: "InvalidStructure", field: "target" })
        aliases.set(key, target.success.join("/"))
      } else if (entry.kind === "directory") {
        declarations.set(key, {
          id: String(paths.size),
          kind: "directory",
          metadata: metadata("directory", entry.metadata),
          entries: []
        })
      } else if (entry.kind === "file") {
        declarations.set(key, {
          id: String(paths.size),
          kind: "file",
          metadata: metadata("file", entry.metadata),
          data: data ?? ""
        })
      } else {
        if (typeof entry.target === "string" && !wellFormed(entry.target)) {
          return yield* new Image.ImageError({
            code: "InvalidEncoding",
            field: "target"
          })
        }
        const target = typeof entry.target === "string"
          ? new TextEncoder().encode(entry.target)
          : bytePaths.get(entry.target)
        if (target === undefined || target.includes(0)) {
          return yield* new Image.ImageError({
            code: "InvalidStructure",
            field: "target"
          })
        }
        declarations.set(key, {
          id: String(paths.size),
          kind: "symlink",
          metadata: metadata("symlink", entry.metadata),
          target: Encoding.encodeBase64(target)
        })
      }
    }
    for (const [key] of aliases) {
      let target = key
      const seen = new Set<string>()
      while (!declarations.has(target)) {
        if (seen.has(target)) return yield* new Image.ImageError({ code: "InvalidStructure", field: "hardLink" })
        seen.add(target)
        const next = aliases.get(target)
        if (next === undefined) return yield* new Image.ImageError({ code: "InvalidStructure", field: "hardLink" })
        target = next
      }
      const node = declarations.get(target)
      if (node === undefined || node.kind === "directory") {
        return yield* new Image.ImageError({
          code: "InvalidStructure",
          field: "hardLink"
        })
      }
      for (const alias of seen) declarations.set(alias, node)
    }
    const children = new Map<string, Array<{ name: string; target: string }>>()
    for (const [key, components] of paths) {
      const parent = declarations.get(components.slice(0, -1).join("/"))
      const child = declarations.get(key)
      const name = components.at(-1)
      if (parent?.kind !== "directory" || child === undefined || name === undefined) {
        return yield* new Image
          .ImageError({ code: "InvalidStructure", field: "parent" })
      }
      const entries = children.get(parent.id) ?? []
      entries.push({ name: Encoding.encodeBase64(nameBytes(name)), target: child.id })
      children.set(parent.id, entries)
    }
    const records = [...new Set(declarations.values())].map((record): Image.Record =>
      record.kind === "directory" ? { ...record, entries: children.get(record.id) ?? [] } : record
    )
    const snapshot = yield* Image.capture({ format: "effect-vfs", version: 1, root: "root", records })
    return yield* makeVolume(config.success, yield* Image.inspect(snapshot))
  }
)
