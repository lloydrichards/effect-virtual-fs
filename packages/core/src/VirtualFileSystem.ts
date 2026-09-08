/** Private directory-only core. Later file, link, and snapshot operations are not exposed yet. */
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
const DirectoryHandleId = Symbol("@effect-vfs/core/DirectoryHandle")

export interface BytePath {
  readonly [BytePathId]: true
}
export type PathInput = string | BytePath

export const FsCode = Schema.Literals([
  "NotFound",
  "AlreadyExists",
  "NotDirectory",
  "AccessDenied",
  "InvalidHandle",
  "ForeignHandle",
  "ClosedCaller",
  "InvalidArgument",
  "InvalidPathEncoding",
  "PathTooLong",
  "NoSpace"
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
  maxPathBytes: Schema.optionalKey(Natural.check(Schema.isGreaterThanOrEqualTo(1)))
})
export type VolumeOptions = typeof VolumeOptions.Type
export const Metadata = Schema.Struct({
  kind: Schema.Literal("directory"),
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
export interface Caller {
  readonly [CallerId]: true
  readonly stat: (path: PathInput, options?: RelativeOptions) => Effect.Effect<Metadata, FsError>
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
  readonly parent: Directory | undefined
  readonly entries: Map<string, Directory>
  metadata: Metadata
}
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
    parent: undefined,
    entries: new Map(),
    metadata: directoryMetadata(1n, 0, 0, 0o755, clock.currentTimeNanosUnsafe())
  }
  let nextInode = 2n
  let entries = 0

  // Permit waits stay interruptible. State transitions and resource registration do not.
  const coordinated = <A, E, R>(effect: Effect.Effect<A, E, R>) => gate.withPermit(Effect.uninterruptible(effect))
  const release = (reference: DirectoryReference) =>
    coordinated(Effect.sync(() => {
      reference.directory = undefined
      reference.closed = true
    }))
  const authorize = (directory: Directory, identity: Identity, bits: number, operation: string, path: PathInput) => {
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

  const createCaller = (reference: DirectoryReference, identity: Identity, umask: number): Caller => {
    const locate = Effect.fnUntraced(
      function*(path: PreparedPath, base: DirectoryHandle | undefined, operation: string, parent = false) {
        if (reference.directory === undefined) return yield* failure("ClosedCaller", operation, path.input)
        let current = path.absolute ? root : reference.directory
        if (!path.absolute && base !== undefined) {
          const target = handles.get(base)
          if (target === undefined) return yield* failure("InvalidHandle", operation, path.input)
          if (target.volume !== volumeIdentity) return yield* failure("ForeignHandle", operation, path.input)
          if (target.directory === undefined) return yield* failure("InvalidHandle", operation, path.input)
          current = target.directory
          yield* authorize(current, identity, 1, operation, path.input)
        }
        const components = parent ? path.components.slice(0, -1) : path.components
        for (const component of components) {
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
        return current
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

    return Object.freeze({
      [CallerId]: true as const,
      stat: Effect.fn("Caller.stat")(function*(input: PathInput, options?: RelativeOptions) {
        const prepared = preparePath(input, "stat", settings.maxPathBytes)
        const base = options?.relativeTo
        return yield* coordinated(Effect.gen(function*() {
          const path = yield* Effect.fromResult(prepared)
          const directory = yield* locate(path, base, "stat")
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
