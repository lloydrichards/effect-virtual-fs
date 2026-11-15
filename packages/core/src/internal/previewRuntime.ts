// The compatibility boundary owns core tokens and policy; all live filesystem state belongs to the public preview.
/* eslint-disable effecttsgo/experimental-api-usage */
import { BytePath as Path, VirtualFileSystem as P } from "@effect-vfs/effect-preview"
import { unixNanoFromNanoseconds as nano } from "@effect-vfs/effect-preview/DateTime"
import { ByteSize, Data, Effect, Option, Predicate, Result, Scope, Stream } from "effect"
import * as Clock from "effect/Clock"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Hex from "effect/encoding/Hex"
import { dual } from "effect/Function"
import * as Semaphore from "effect/Semaphore"
import { CallerId, ObjectReferenceId, RootCallerOptions } from "../Caller.js"
import { DirectoryHandleId, FileHandleId } from "../FileHandle.js"
import type { Metadata, Times } from "../Metadata.js"
import { isEntry, Target } from "../Target.js"
import { make as vfsError } from "../VfsError.js"
import type * as V from "../VirtualFileSystem.js"
import { VolumeId, VolumeIdentity, VolumeIncarnation } from "../Volume.js"
import * as CorePath from "./bytePath.js"
import {
  type CommitProvider,
  Errors,
  OpenEntryOptions as EntryOpenSchema,
  OpenOptions as OpenSchema,
  Paths,
  State,
  WriteFileOptions as WriteSchema
} from "./engine.js"
import * as Image from "./image.js"
import type { ObservationEntry } from "./overlayDiff.js"
import * as Limits from "./volumeLimits.js"
import { assemble, type NodeSpec } from "./volumeState.js"

export class PreviewBlocker extends Data.TaggedError("PreviewBlocker")<{
  readonly feature: string
}> {}

export const blocked = (feature: string): Effect.Effect<never> => Effect.die(new PreviewBlocker({ feature }))

export const failure = (error: P.VirtualFileSystemError, operation = error.operation): V.FsFailure => {
  const code: V.FsCode = (() => {
    if (Predicate.isTagged(error, "NotFound")) {
      return "NotFound"
    }

    if (Predicate.isTagged(error, "AlreadyExists")) {
      return "AlreadyExists"
    }

    if (Predicate.isTagged(error, "AccessDenied")) {
      return error.reason === "ownership" ? "NotPermitted" : "AccessDenied"
    }

    if (Predicate.isTagged(error, "InvalidInput")) {
      return "InvalidArgument"
    }

    if (Predicate.isTagged(error, "ConditionFailed")) {
      return "VolumeBusy"
    }

    if (Predicate.isTagged(error, "NamespaceChanged")) {
      return "VolumeBusy"
    }

    if (Predicate.isTagged(error, "Busy")) {
      return error.reason === "nonemptyDirectory" ? "NotEmpty" : "VolumeBusy"
    }

    if (Predicate.isTagged(error, "ReentrantOperation")) {
      return "VolumeBusy"
    }

    if (Predicate.isTagged(error, "LimitExceeded")) {
      return error.domain === "name" || error.domain === "path" || error.domain === "expandedPath"
        ? "PathTooLong"
        : error.domain === "file" || error.domain === "io"
        ? "FileTooLarge"
        : "NoSpace"
    }

    if (Predicate.isTagged(error, "CapabilityUnavailable")) {
      return "InvalidArgument"
    }

    if (Predicate.isTagged(error, "InvalidRestore")) {
      return "InvalidArgument"
    }

    if (Predicate.isTagged(error, "Unrepresentable")) {
      return "InvalidPathEncoding"
    }

    {
      switch (error.reason) {
        case "symlinkCycle":
        case "symlinkLimit":
        case "refusedSymlink":
          return "SymlinkLoop"
        case "wrongKind":
          return "NotDirectory"
        case "foreign":
          return "ForeignReference"
        case "stale":
          return "StaleReference"
        default:
          return "InvalidHandle"
      }
    }
  })()

  return Errors.fsFailure(code, operation, { cause: error })
}

const mapped = <A, R>(effect: Effect.Effect<A, P.VirtualFileSystemError, R>) => effect.pipe(Effect.mapError(failure))

const path = (value: V.PathInput): Effect.Effect<P.Path, V.FsFailure> =>
  Predicate.isString(value)
    ? Effect.succeed(value)
    : Paths.pathToBytes(value).pipe(
      Effect.flatMap((bytes) => Effect.fromResult(Path.fromBytes(bytes))),
      Effect.mapError((cause) => Errors.fsFailure("InvalidPathEncoding", "path", { cause }))
    )

const oldPath = (value: Path.BytePath) => Paths.pathFromBytes(Path.toBytes(value))

interface Token {
  readonly reference: P.ObjectReference
  revision: P.ObjectRevision
  number: bigint
  readonly core: V.ObjectReference
}

export interface Runtime {
  readonly owner: P.Owner
  readonly clock: Clock.Clock
  readonly rootScope: Scope.Closeable
  readonly tokens: Array<Token>
  readonly references: WeakMap<V.ObjectReference, P.ObjectReference>
  readonly files: WeakMap<V.FileHandle, P.FileHandle>
  readonly directories: WeakMap<V.DirectoryHandle, P.DirectoryHandle>
  revision: bigint
  busy: boolean
  readonly gate: Semaphore.Semaphore
}

const runtimes = new WeakMap<V.Volume, Runtime>()

const referenceOwners = new WeakMap<V.ObjectReference, Runtime>()

const handleOwners = new WeakMap<V.FileHandle | V.DirectoryHandle, Runtime>()

export const runtimeOf = (volume: V.Volume) => runtimes.get(volume)

const errorPath = (candidate: V.EntryInput | V.TargetInput): V.PathInput | undefined => {
  if (Predicate.isString(candidate) || CorePath.isBytePath(candidate)) return candidate

  if (isEntry(candidate)) {
    const base = errorPath(candidate.directory)

    if (base === undefined) return undefined
    const parent = Predicate.isString(base) ? new TextEncoder().encode(base) : CorePath.getBytes(base)

    if (parent === undefined) return undefined
    const name = Predicate.isString(candidate.name) ? new TextEncoder().encode(candidate.name) : candidate.name

    return Paths.ownedPath(Paths.joinPath(parent, name))
  }

  const selected = Target.of(candidate)

  return Predicate.isTagged(selected, "Path") ? selected.path : undefined
}

interface ErrorDetails {
  field?: string
  cause?: unknown
  path?: V.PathInput
}

const contextual = (
  error: V.FsFailure,
  operation: string,
  source?: V.TargetInput | V.EntryInput,
  destination?: V.TargetInput | V.EntryInput
): V.FsFailure => {
  const value = Predicate.hasProperty(error.cause, "side") && error.cause.side === "destination" ? destination : source
  const selected = error.path ?? (value === undefined ? undefined : errorPath(value))
  const details: ErrorDetails = { cause: error.cause }

  if (error.field !== undefined) details.field = error.field

  if (selected !== undefined) details.path = selected

  return Errors.fsFailure(error.code, operation, details)
}

// The core boundary serializes its compatibility observations. Native calls share its busy guard.
const execute = <A, R>(
  runtime: Runtime,
  operation: string,
  source: V.TargetInput | V.EntryInput | undefined,
  effect: Effect.Effect<A, V.FsFailure, R>,
  destination?: V.TargetInput | V.EntryInput
): Effect.Effect<A, V.FsFailure, R> =>
  runtime.gate.withPermit(Effect.acquireUseRelease(
    Effect.sync(() => {
      runtime.busy = true
    }),
    () => effect.pipe(Effect.mapError((error) => contextual(error, operation, source, destination))),
    () =>
      Effect.sync(() => {
        runtime.busy = false
      })
  ))

const token = (runtime: Runtime, observation: P.ObjectObservation): Token => {
  const known = runtime.tokens.find((t) => P.equalsObjectReference(t.reference, observation.reference))

  if (known !== undefined) {
    if (!P.equalsObjectRevision(known.revision, observation.revision)) {
      known.revision = observation.revision
      known.number = runtime.revision
    }

    return known
  }

  const core: V.ObjectReference = Object.freeze({ [ObjectReferenceId]: true as const })

  const created: Token = {
    core,
    reference: observation.reference,
    revision: observation.revision,
    number: runtime.revision
  }

  runtime.tokens.push(created)
  runtime.references.set(core, observation.reference)
  referenceOwners.set(core, runtime)

  return created
}

export const metadata = (runtime: Runtime, observation: P.ObjectObservation): Metadata => {
  const m = observation.metadata

  return {
    kind: m.kind,
    ino: m.objectNumber,
    nlink: Number(m.nlink),
    size: m.size,
    uid: m.uid,
    gid: m.gid,
    mode: m.mode,
    atimeNs: m.atime,
    mtimeNs: m.mtime,
    ctimeNs: m.ctime,
    birthtimeNs: m.birthtime,
    revision: token(runtime, observation).number
  }
}

export const coreReference = (runtime: Runtime, observation: P.ObjectObservation) => token(runtime, observation).core

const reference = (runtime: Runtime, value: V.ObjectReference): Effect.Effect<P.ObjectReference, V.FsFailure> => {
  const found = runtime.references.get(value)

  return found === undefined
    ? Effect.fail(Errors.fsFailure(referenceOwners.has(value) ? "ForeignReference" : "InvalidReference", "reference"))
    : Effect.succeed(found)
}

export const target = Effect.fnUntraced(
  function*(runtime: Runtime, value: V.TargetInput): Effect.fn.Return<P.Target, V.FsFailure> {
    const selected = Target.of(value)

    if (Predicate.isTagged(selected, "Reference")) return yield* reference(runtime, selected.reference)

    if (Predicate.isTagged(selected, "Handle")) {
      const file = FileHandleId in selected.handle ? runtime.files.get(selected.handle) : undefined

      if (file !== undefined) return (yield* mapped(file.stat())).reference
      const directory = DirectoryHandleId in selected.handle ? runtime.directories.get(selected.handle) : undefined

      if (directory !== undefined) return (yield* mapped(directory.stat())).reference

      return yield* Errors.fsFailure(handleOwners.has(selected.handle) ? "ForeignHandle" : "InvalidHandle", "target")
    }

    const name = yield* path(selected.path)

    if (
      selected.relativeTo === undefined ||
      (Predicate.isString(name) ? name.startsWith("/") : Path.toBytes(name)[0] === 47)
    ) return name
    const directory = runtime.directories.get(selected.relativeTo)

    if (directory === undefined) return yield* Errors.fsFailure("InvalidHandle", "target")

    return { directory, name }
  }
)

const entry = Effect.fnUntraced(
  function*(
    runtime: Runtime,
    value: V.EntryInput | V.TargetInput,
    caller?: P.VirtualFileSystem
  ): Effect.fn.Return<P.EntryTarget, V.FsFailure> {
    if (isEntry(value)) {
      const directory = yield* target(runtime, value.directory)

      if (!Predicate.isString(directory) && !Path.isBytePath(directory) && "directory" in directory) {
        if (caller === undefined) return yield* Errors.fsFailure("InvalidArgument", "entry")
        const resolved = yield* mapped(caller.lookup(directory))

        const name = Predicate.isString(value.name)
          ? value.name
          : yield* Effect.fromResult(Path.fromBytes(value.name)).pipe(
            Effect.mapError((cause) => Errors.fsFailure("InvalidArgument", "entry", { cause }))
          )

        return { directory: resolved, name }
      }

      const name = Predicate.isString(value.name)
        ? value.name
        : yield* Effect.fromResult(Path.fromBytes(value.name)).pipe(
          Effect.mapError((cause) => Errors.fsFailure("InvalidArgument", "entry", { cause }))
        )

      return { directory, name }
    }

    const selected = Target.of(value)

    if (!Predicate.isTagged(selected, "Path")) return yield* Errors.fsFailure("InvalidArgument", "entry")
    const p = yield* target(runtime, value)

    // Only path targets reach this branch.
    if (Predicate.isString(p) || Path.isBytePath(p) || "directory" in p) return p

    return yield* Errors.fsFailure("InvalidArgument", "entry")
  }
)

const follow = (value: V.TargetInput) => {
  const selected = Target.of(value)

  return !Predicate.isTagged(selected, "Path") || selected.followFinalSymlink !== false
}

const stat = (runtime: Runtime, caller: P.VirtualFileSystem, value: V.TargetInput) =>
  target(runtime, value).pipe(
    Effect.flatMap((t) =>
      follow(value)
        ? mapped(caller.stat(t))
        : entry(runtime, value, caller).pipe(Effect.flatMap((e) => mapped(caller.linkStat(e))))
    )
  )

const times = Effect.fnUntraced(function*(value: Times): Effect.fn.Return<P.Attributes> {
  const now = yield* Effect.clockWith((clock) => clock.currentTimeNanos)
  const selected = (t: Times["access"]) => t.kind === "omit" ? undefined : nano(t.kind === "now" ? now : t.nanoseconds)

  return { atime: selected(value.access), mtime: selected(value.modification) }
})

const openOptions = (o: V.OpenOptions): P.OpenOptions => ({
  access: o.access === "readWrite" ? "readwrite" : o.access,
  create: o.create === "never" || o.create === undefined
    ? "existing"
    : o.create === "ifMissing"
    ? "ifmissing"
    : "exclusive",
  mode: o.mode,
  append: o.append,
  truncate: o.truncate,
  appendCursor: "advance",
  truncateCursor: "preserve"
})

const wrapFile = (
  runtime: Runtime,
  handle: P.FileHandle,
  positioned = handle,
  append = false,
  access: V.OpenOptions["access"] = "readWrite"
): V.FileHandle => {
  const write = Effect.fnUntraced(function*(data: Uint8Array, position?: bigint) {
    const info = yield* mapped(handle.stat())

    if (position !== undefined && (position < 0n || position > 0x7fffffffffffffffn)) {
      return yield* Errors.fsFailure("InvalidArgument", "pwrite")
    }

    const at = position ?? (append ? info.metadata.size : yield* mapped(handle.position()))
    const used = yield* runtime.owner.usage
    const free = runtime.owner.limits.contentBytes - used.contentBytes
    const fileAvailable = runtime.owner.limits.fileBytes - at
    const volumeAvailable = info.metadata.size + free - at
    const available = fileAvailable < volumeAvailable ? fileAvailable : volumeAvailable

    if (data.length > 0 && available <= 0n) {
      return yield* Errors.fsFailure(fileAvailable <= 0n ? "FileTooLarge" : "NoSpace", "write")
    }

    const part = data.subarray(0, Number(available < BigInt(data.length) ? available : BigInt(data.length)))
    yield* mapped(
      (position === undefined ? handle : positioned).write(part, position === undefined ? undefined : { position })
    )

    if (part.length > 0) runtime.revision++

    return part.length
  })

  let closed = false

  const available = <A, R>(operation: string, effect: Effect.Effect<A, V.FsFailure, R>) =>
    Effect.suspend(() =>
      closed || ((operation === "write" || operation === "pwrite" || operation === "truncate") && access === "read") ||
        ((operation === "read" || operation === "pread") && access === "write")
        ? Effect.fail(Errors.fsFailure("InvalidHandle", operation)) :
        effect
    )

  const file: V.FileHandle = {
    [FileHandleId]: true,
    read: (n) => available("read", mapped(handle.readAlloc(n))),
    pread: (n, position) =>
      available(
        "pread",
        Effect.gen(function*() {
          if (position < 0n || position > 0x7fffffffffffffffn) {
            return yield* Errors.fsFailure("InvalidArgument", "pread")
          }

          const bytes = yield* mapped(handle.readAlloc(n, { position }))

          return { bytes, eof: position + BigInt(bytes.length) >= (yield* mapped(handle.stat())).metadata.size }
        })
      ),
    write: (data) => available("write", write(data)),
    pwrite: dual(2, (data: Uint8Array, position: bigint) => available("pwrite", write(data, position))),
    seek: dual(2, (offset: bigint, from: V.SeekMode) =>
      available(
        "seek",
        Effect.gen(function*() {
          if (from !== "data" && from !== "hole") return yield* mapped(handle.seek({ offset, from }))

          if (offset < 0n) return yield* Errors.fsFailure("InvalidArgument", "seek")
          const size = (yield* mapped(handle.stat())).metadata.size

          if (offset >= size) return yield* Errors.fsFailure("NoData", "seek")

          return yield* mapped(handle.seek({ from: "start", offset: from === "data" ? offset : size }))
        })
      )),
    truncate: (n) => available("truncate", mapped(handle.truncate(n))),
    stat: available("stat", mapped(handle.stat()).pipe(Effect.map((o) => metadata(runtime, o)))),
    sync: available("sync", mapped(handle.stat()).pipe(Effect.asVoid)),
    close: available(
      "close",
      mapped(handle.stat()).pipe(
        Effect.andThen(handle.close()),
        Effect.andThen(positioned === handle ? Effect.void : positioned.close()),
        Effect.andThen(Effect.sync(() => {
          closed = true
        }))
      )
    )
  }

  const protectedFile: V.FileHandle = {
    ...file,
    read: (n) => execute(runtime, "read", undefined, file.read(n)),
    pread: (n, offset) => execute(runtime, "pread", undefined, file.pread(n, offset)),
    write: (bytes) => execute(runtime, "write", undefined, file.write(bytes)),
    pwrite: dual(
      2,
      (bytes: Uint8Array, offset: bigint) => execute(runtime, "pwrite", undefined, file.pwrite(bytes, offset))
    ),
    seek: dual(2, (offset: bigint, from: V.SeekMode) => execute(runtime, "seek", undefined, file.seek(offset, from))),
    truncate: (length) => execute(runtime, "truncate", undefined, file.truncate(length)),
    stat: execute(runtime, "stat", undefined, file.stat),
    sync: execute(runtime, "sync", undefined, file.sync),
    close: execute(runtime, "close", undefined, file.close)
  }

  runtime.files.set(protectedFile, handle)
  handleOwners.set(protectedFile, runtime)

  return protectedFile
}

const wrapDirectory = (runtime: Runtime, handle: P.DirectoryHandle): V.DirectoryHandle => {
  let closed = false

  const directory: V.DirectoryHandle = {
    [DirectoryHandleId]: true,
    stat: Effect.suspend(() =>
      closed
        ? Effect.fail(Errors.fsFailure("InvalidHandle", "stat"))
        : mapped(handle.stat()).pipe(Effect.map((o) => metadata(runtime, o)))
    ),
    close: Effect.suspend(() =>
      closed
        ? Effect.fail(Errors.fsFailure("InvalidHandle", "close"))
        : handle.close().pipe(Effect.andThen(Effect.sync(() => {
          closed = true
        })))
    )
  }

  const protectedDirectory: V.DirectoryHandle = {
    ...directory,
    stat: execute(runtime, "stat", undefined, directory.stat),
    close: execute(runtime, "close", undefined, directory.close)
  }

  runtime.directories.set(protectedDirectory, handle)
  handleOwners.set(protectedDirectory, runtime)

  return protectedDirectory
}

const change = (before: bigint, after: bigint): V.DirectoryChange => ({ before, after })

const callerFailure = (error: V.FsFailure): V.FsFailure =>
  Predicate.isTagged(error.cause, "InvalidResource") && Predicate.hasProperty(error.cause, "reason") &&
    (error.cause.reason === "closed" || error.cause.reason === "closing")
    ? Errors.fsFailure("ClosedCaller", error.operation, { cause: error.cause })
    : error

const wrapCaller = (runtime: Runtime, caller: P.VirtualFileSystem, limits: V.VolumeLimits, umask = 0o022): V.Caller => {
  const onTarget = <A, R>(value: V.TargetInput, use: (t: P.Target) => Effect.Effect<A, P.VirtualFileSystemError, R>) =>
    target(runtime, value).pipe(Effect.flatMap((t) => mapped(use(t))))

  const mutateTarget = Effect.fnUntraced(
    function*<A>(value: V.TargetInput, use: (t: P.Target) => Effect.Effect<A, P.VirtualFileSystemError>) {
      const t = yield* target(runtime, value)
      const prior = yield* Effect.result(mapped(caller.stat(t)))

      if (Result.isSuccess(prior)) token(runtime, prior.success)
      const result = yield* mapped(use(t))
      const after = yield* Effect.result(mapped(caller.stat(t)))

      if (Result.isSuccess(after)) {
        if (Result.isFailure(prior) || !P.equalsObjectRevision(prior.success.revision, after.success.revision)) {
          runtime.revision++
        }

        token(runtime, after.success)
      }

      return result
    }
  )

  const attributes = (value: V.TargetInput, a: P.Attributes, expectedRevision?: P.ObjectRevision) =>
    mutateTarget(value, (t) => caller.setAttributes(t, a, { followFinalSymlink: follow(value), expectedRevision }))

  const parentEntry = Effect.fnUntraced(function*(t: P.EntryTarget) {
    const name = Predicate.isString(t) || Path.isBytePath(t) ? t : t.name
    const bytes = Predicate.isString(name) ? new TextEncoder().encode(name) : Path.toBytes(name)
    let end = bytes.length

    while (end > 1 && bytes[end - 1] === 47) end--
    const raw = bytes.subarray(0, end)
    const slash = raw.lastIndexOf(47)

    const parent = yield* Effect.fromResult(
      Path.fromBytes(slash < 0 ? Uint8Array.of(46) : slash === 0 ? Uint8Array.of(47) : raw.slice(0, slash))
    ).pipe(Effect.mapError((cause) => Errors.fsFailure("InvalidPathEncoding", "parent", { cause })))

    if (Predicate.isString(t) || Path.isBytePath(t)) return yield* mapped(caller.stat(parent))

    return yield* Effect.scoped(Effect.gen(function*() {
      const base = yield* mapped(caller.withCurrentDirectory(t.directory))

      return yield* mapped(base.stat(parent))
    }))
  })

  const namespace = Effect.fnUntraced(
    function*<A>(
      value: V.EntryInput,
      use: (t: P.EntryTarget) => Effect.Effect<A, P.VirtualFileSystemError>,
      recursive = false
    ) {
      const t = yield* entry(runtime, value, caller)
      const prior = yield* Effect.result(parentEntry(t))

      if (Result.isFailure(prior) && !(recursive && prior.failure.code === "NotFound")) return yield* prior.failure
      const before = Result.isSuccess(prior) ? token(runtime, prior.success).number : runtime.revision
      const result = yield* mapped(use(t))
      const after = yield* parentEntry(t)

      if (Result.isFailure(prior) || !P.equalsObjectRevision(prior.success.revision, after.revision)) runtime.revision++

      return { result, directory: change(before, token(runtime, after).number) }
    }
  )

  const created = (o: P.ObjectObservation, directory: V.DirectoryChange): V.ReferenceEntryResult => ({
    reference: token(runtime, o).core,
    directory
  })

  function removeCore(
    value: V.EntryInput,
    o?: V.RemoveOptions & { readonly force?: false }
  ): Effect.Effect<V.DirectoryChange, V.FsFailure>
  function removeCore(
    value: V.EntryInput,
    o: V.RemoveOptions
  ): Effect.Effect<V.DirectoryChange | undefined, V.FsFailure>
  function removeCore(
    value: V.EntryInput,
    o?: V.RemoveOptions
  ): Effect.Effect<V.DirectoryChange | undefined, V.FsFailure> {
    return Effect.gen(function*() {
      const selected = o?.expected === undefined
        ? undefined
        : { entry: { expected: "present" as const, object: yield* reference(runtime, o.expected) } }

      const action = namespace(
        value,
        (t) =>
          o?.recursive
            ? caller.removeRecursive(t, selected)
            : caller.linkStat(t).pipe(
              Effect.flatMap((object) =>
                object.kind === "directory" ? caller.removeDirectory(t, selected) : caller.unlink(t, selected)
              )
            )
      )

      const result = yield* Effect.result(action)

      if (Result.isFailure(result)) {
        if (o?.force && result.failure.code === "NotFound") return undefined

        return yield* result.failure
      }

      return result.success.directory
    })
  }

  function openCore(value: V.Entry, o: V.OpenEntryOptions): Effect.Effect<V.OpenEntryResult, V.FsFailure, Scope.Scope>
  function openCore(
    value: V.Target | V.PathInput | V.ObjectReference | V.FileHandle,
    o: V.OpenOptions
  ): Effect.Effect<V.FileHandle, V.FsFailure, Scope.Scope>
  function openCore(
    value: V.TargetInput | V.Entry,
    o: V.OpenOptions | V.OpenEntryOptions
  ): Effect.Effect<V.FileHandle | V.OpenEntryResult, V.FsFailure, Scope.Scope> {
    return Effect.gen(function*() {
      if (isEntry(value)) {
        const options = yield* Effect.fromResult(Errors.decodeConfiguration(EntryOpenSchema, o, "open"))

        if (
          options.initialSize !== undefined || options.owner !== undefined || options.times !== undefined ||
          options.exactMode
        ) return yield* blocked("atomicOpenInitialMetadata")
        const address = yield* entry(runtime, value, caller)

        if (Predicate.isString(address) || Path.isBytePath(address)) {
          return yield* Errors.fsFailure("InvalidArgument", "open")
        }

        const prior = yield* mapped(caller.observeEntry(address))
        const parent = yield* mapped(caller.stat(prior.parent))
        const before = token(runtime, parent).number
        const present = prior.state === "present" ? prior.object : undefined

        if (options.expected !== undefined) {
          const expected = options.expected === null ? undefined : yield* reference(runtime, options.expected)

          if (
            expected === undefined
              ? present !== undefined
              : present === undefined || !P.equalsObjectReference(expected, present.reference)
          ) return yield* Errors.fsFailure("VolumeBusy", "open")
        }

        if (options.expectedChild !== undefined) {
          const expected = options.expectedChild

          if (expected === null) {
            if (present !== undefined) return yield* Errors.fsFailure("VolumeBusy", "open")
          } else {
            const r = yield* reference(runtime, expected.reference)

            if (present === undefined || !P.equalsObjectReference(r, present.reference)) {
              return yield* Errors.fsFailure("VolumeBusy", "open")
            }

            const info = metadata(runtime, present)

            if (
              info.revision !== expected.revision || info.atimeNs !== expected.atimeNs ||
              info.mtimeNs !== expected.mtimeNs
            ) return yield* Errors.fsFailure("VolumeBusy", "open")
          }
        }

        const conditions: P.DestinationConditions = {
          entry: prior.state === "present" ? { expected: "binding", binding: prior.binding } : { expected: "absent" }
        }

        const handle = yield* mapped(
          caller.open(address, {
            ...openOptions(options),
            conditions,
            noFollow: options.followFinalSymlink === false,
            expectedRevision: options.expectedChild == null ? undefined : present?.revision
          })
        )

        const after = yield* mapped(caller.stat(parent.reference))

        if (!P.equalsObjectRevision(parent.revision, after.revision)) runtime.revision++
        const observation = yield* mapped(handle.stat())

        return {
          handle: wrapFile(
            runtime,
            handle,
            options.append && options.access !== "read"
              ? yield* mapped(
                caller.open(observation.reference, {
                  access: options.access === "readWrite" ? "readwrite" : options.access
                })
              )
              : handle,
            options.append,
            options.access
          ),
          reference: token(runtime, observation).core,
          created: prior.state === "absent",
          directory: change(before, token(runtime, after).number)
        }
      }

      const options = yield* Effect.fromResult(Errors.decodeConfiguration(OpenSchema, o, "open"))

      if (options.mode !== undefined && (options.create === undefined || options.create === "never")) {
        return yield* Errors.fsFailure("InvalidArgument", "open", { field: "mode" })
      }

      const existing = yield* Effect.result(stat(runtime, caller, value))

      if (Result.isSuccess(existing) && existing.success.kind === "directory") {
        return yield* Errors.fsFailure("IsDirectory", "open")
      }

      const t = yield* target(runtime, value)
      const selected = { ...openOptions(options), noFollow: !follow(value) }

      if (
        !Predicate.isString(t) && !Path.isBytePath(t) && !("directory" in t) && options.create !== undefined &&
        options.create !== "never"
      ) return yield* Errors.fsFailure("InvalidArgument", "open", { field: "create" })

      const handle = yield* mapped(
        Predicate.isString(t) || Path.isBytePath(t)
          ? caller.open(t, selected)
          : "directory" in t
          ? caller.open(t, selected)
          : caller.open(t, { access: selected.access, append: selected.append, truncate: selected.truncate })
      )

      const positioned = options.append && options.access !== "read"
        ? yield* mapped(caller.open((yield* mapped(handle.stat())).reference, { access: selected.access }))
        : handle

      return wrapFile(runtime, handle, positioned, options.append, options.access)
    })
  }

  const fs: V.Caller = {
    [CallerId]: true,
    limits,
    root: mapped(caller.stat("/")).pipe(Effect.map((o) => token(runtime, o).core)),
    lookup: (value) =>
      entry(runtime, value, caller).pipe(
        Effect.flatMap((e) => mapped(caller.linkStat(e)).pipe(Effect.map((o) => o.reference))),
        Effect.flatMap((r) => mapped(caller.stat(r))),
        Effect.map((o) => token(runtime, o).core)
      ),
    parent: (value) =>
      Effect.scoped(Effect.gen(function*() {
        const t = yield* target(runtime, value)
        const r = yield* mapped(caller.lookup(t))
        const traversal = yield* mapped(caller.acquireTraversal({ base: r }))
        const selected = yield* mapped(traversal.select(traversal.base, Data.taggedEnum<P.TraversalProbe>().Parent()))

        if (Option.isNone(selected)) return yield* Errors.fsFailure("NotFound", "parent")

        return token(runtime, selected.value.object).core
      })),
    stat: (value) => stat(runtime, caller, value).pipe(Effect.map((o) => metadata(runtime, o))),
    readDirectory: (value) =>
      onTarget(value, (t) => caller.readDirectoryEntries(t)).pipe(
        Effect.map((list) => ({
          revision: token(runtime, list.directory).number,
          value: list.entries.map((e) => ({ name: Path.toBytes(e.name), reference: token(runtime, e.object).core }))
        }))
      ),
    readFile: Effect.fnUntraced(function*(value) {
      const t = yield* target(runtime, value)
      const info = yield* mapped(caller.stat(t))

      if (info.kind !== "file") {
        return yield* Errors.fsFailure(info.kind === "directory" ? "IsDirectory" : "SymlinkLoop", "readFile")
      }

      return yield* mapped(caller.readFile(t))
    }),
    readLink: (value) =>
      target(runtime, value).pipe(Effect.flatMap((e) => mapped(caller.readLink(e))), Effect.map(Path.toBytes)),
    realPath: Effect.fnUntraced(function*(value) {
      const t = Target.of(value)

      if (!Predicate.isTagged(t, "Path")) return yield* blocked("realPathByReference")

      return yield* oldPath(yield* mapped(caller.realPath(yield* path(t.path))))
    }),
    access: (value, bits = 0) =>
      onTarget(
        value,
        (t) => caller.access(t, { read: (bits & 4) !== 0, write: (bits & 2) !== 0, execute: (bits & 1) !== 0 })
      ).pipe(Effect.asVoid, Effect.andThen(Effect.succeed(bits))),
    writeFile: dual(3, (value: V.EntryInput, data: Uint8Array, o: V.WriteFileOptions) =>
      Effect.gen(function*() {
        o = yield* Effect.fromResult(Errors.decodeConfiguration(WriteSchema, o, "writeFile"))

        if (o.finalMode !== undefined) return yield* blocked("atomicFinalMode")

        if (o.replaceFinalSymlink) return yield* blocked("atomicFinalSymlinkReplacement")
        const t = yield* entry(runtime, value, caller)

        const present = yield* Effect.result(
          mapped(o.followFinalSymlink === false ? caller.linkStat(t) : caller.stat(t))
        )

        if (Result.isSuccess(present)) {
          if (present.success.kind === "directory") return yield* Errors.fsFailure("IsDirectory", "writeFile")

          if (present.success.kind === "symlink") return yield* Errors.fsFailure("SymlinkLoop", "writeFile")
        }

        const options: P.WriteFileOptions = {
          access: o.access === "readWrite" ? "readwrite" : "write",
          create: o.create === "ifMissing" ? "ifmissing" : o.create === "exclusive" ? "exclusive" : "existing",
          mode: o.mode,
          placement: o.append ? "append" : o.truncate ? "replace" : "start"
        }

        yield* mapped(
          Predicate.isString(t) || Path.isBytePath(t)
            ? caller.writeFile(t, data, options)
            : caller.writeFile(t, data, options)
        )

        runtime.revision++

        return token(runtime, yield* mapped(caller.stat(t))).core
      })),
    open: openCore,
    openDirectory: (value) =>
      onTarget(value, (t) => caller.openDirectory(t)).pipe(Effect.map((h) => wrapDirectory(runtime, h))),
    mkdir: Effect.fnUntraced(function*(value, o) {
      if ((o?.exactMode && ((o.mode ?? 0o777) & umask) !== 0) || o?.times !== undefined) {
        return yield* blocked("atomicDirectoryMetadata")
      }

      const made = yield* namespace(
        value,
        (t) => caller.makeDirectory(t, { mode: o?.mode, recursive: o?.recursive }),
        o?.recursive
      )

      return created(made.result, made.directory)
    }),
    symlink: Effect.fnUntraced(function*(linkTarget, value, o) {
      const p = yield* path(linkTarget)
      const selected = o?.times

      if (selected !== undefined && (selected.access.kind !== "value" || selected.modification.kind !== "value")) {
        return yield* blocked("atomicSymlinkMetadata")
      }

      const preserved = selected?.access.kind === "value" && selected.modification.kind === "value"
        ? { atime: nano(selected.access.nanoseconds), mtime: nano(selected.modification.nanoseconds) }
        : undefined

      const made = yield* namespace(value, (t) =>
        preserved === undefined
          ? caller.makeSymlink(t, p)
          : caller.publishCopiedSymlink(
            t,
            Predicate.isString(p) ? Result.getOrThrow(Path.fromBytes(new TextEncoder().encode(p))) : p,
            { preserveTimes: preserved }
          ).pipe(Effect.andThen(caller.linkStat(t))))

      return created(made.result, made.directory)
    }),
    link: dual(2, (source: V.TargetInput, value: V.EntryInput) =>
      Effect.gen(function*() {
        const from = yield* target(runtime, source)

        const object = yield* mapped(
          Predicate.isString(from) || Path.isBytePath(from) || "directory" in from
            ? caller.linkStat(from)
            : caller.stat(from)
        )

        if (object.kind === "directory") return yield* Errors.fsFailure("IsDirectory", "link")
        const made = yield* namespace(value, (t) => caller.makeHardLink({ reference: object.reference }, t))

        return created(made.result, made.directory)
      })),
    unlink: (value) => namespace(value, (t) => caller.unlink(t)).pipe(Effect.map((r) => r.directory)),
    rmdir: (value) => namespace(value, (t) => caller.removeDirectory(t)).pipe(Effect.map((r) => r.directory)),
    remove: removeCore,
    rename: dual(2, (from: V.EntryInput, to: V.EntryInput) =>
      Effect.gen(function*() {
        const source = yield* entry(runtime, from, caller)
        const destination = yield* entry(runtime, to, caller)
        const sourceParent = yield* parentEntry(source)
        const destinationParent = yield* parentEntry(destination)
        const sourceBefore = token(runtime, sourceParent).number
        const destinationBefore = token(runtime, destinationParent).number
        yield* mapped(caller.rename(source, destination))
        const sourceAfter = yield* mapped(caller.stat(sourceParent.reference))
        const destinationAfter = yield* mapped(caller.stat(destinationParent.reference))

        if (
          !P.equalsObjectRevision(sourceParent.revision, sourceAfter.revision) ||
          !P.equalsObjectRevision(destinationParent.revision, destinationAfter.revision)
        ) runtime.revision++
        const sourceChange = change(sourceBefore, token(runtime, sourceAfter).number)
        const destinationChange = change(destinationBefore, token(runtime, destinationAfter).number)

        return P.equalsObjectReference(sourceParent.reference, destinationParent.reference)
          ? Data.taggedEnum<V.RenameReferenceResult>().SameDirectory({ directory: sourceChange })
          : Data.taggedEnum<V.RenameReferenceResult>().DifferentDirectories({
            sourceDirectory: sourceChange,
            destinationDirectory: destinationChange
          })
      })),
    chmod: dual(2, (value: V.TargetInput, mode: number) => attributes(value, { mode })),
    chown: dual(2, (value: V.TargetInput, owner: V.OwnerUpdate) => attributes(value, owner)),
    utimes: dual(2, (value: V.TargetInput, t: Times) => times(t).pipe(Effect.flatMap((a) => attributes(value, a)))),
    truncate: dual(2, (value: V.TargetInput, size: bigint) =>
      Effect.gen(function*() {
        if ((yield* stat(runtime, caller, value)).kind === "directory") {
          return yield* Errors.fsFailure("IsDirectory", "truncate")
        }

        return yield* mutateTarget(value, (t) => caller.truncate(t, size))
      })),
    setattr: dual(2, (value: V.TargetInput, a: V.SetattrOptions) =>
      Effect.gen(function*() {
        const observed = yield* stat(runtime, caller, value)
        const prior = token(runtime, observed)

        if (a.expected !== undefined && a.expected.revision !== prior.number) {
          return yield* Errors.fsFailure("VolumeBusy", "setattr")
        }

        if (a.size !== undefined) {
          if (a.mode !== undefined || a.owner !== undefined || a.times !== undefined) {
            return yield* blocked("atomicSetattrSizeAndMetadata")
          }

          return yield* mutateTarget(value, (t) => caller.truncate(t, a.size!, { expectedRevision: observed.revision }))
        }

        const selected: P.Attributes = { ...a.owner, mode: a.mode }

        return yield* attributes(
          value,
          a.times === undefined ? selected : { ...selected, ...yield* times(a.times) },
          a.expected === undefined ? undefined : observed.revision
        )
      })),
    withRoot: (value) =>
      target(runtime, value).pipe(
        Effect.flatMap((t) => mapped(caller.lookup(t))),
        Effect.flatMap((r) => mapped(caller.withRoot(r))),
        Effect.map((c) => wrapCaller(runtime, c, limits, umask))
      ),
    withDirectory: (value) =>
      target(runtime, value).pipe(
        Effect.flatMap((t) => mapped(caller.lookup(t))),
        Effect.flatMap((r) => mapped(caller.withCurrentDirectory(r))),
        Effect.map((c) => wrapCaller(runtime, c, limits, umask))
      ),
    watch: () => blocked("watch"),
    walk: (value, options) =>
      Stream.suspend(() => {
        let entries = 0
        let bytes = 0n
        let rootDepth = 0
        const directories: Array<{ depth: number; entry: V.WalkEntry }> = []

        const visits = Stream.unwrap(
          target(runtime, value).pipe(
            Effect.map((t) => caller.walk(t).pipe(Stream.mapError(failure)))
          )
        )

        const walked = visits.pipe(
          Stream.mapEffect((record) =>
            Effect.gen(function*() {
              const raw = Path.toBytes(record.path)
              const absoluteDepth = raw.filter((byte) => byte === 47).length - (raw.length === 1 ? 1 : 0)

              if (record.root) rootDepth = absoluteDepth
              const depth = absoluteDepth - rootDepth
              entries++
              bytes += BigInt(raw.length)

              if (options?.maxDepth !== undefined && depth > options.maxDepth) {
                return yield* vfsError({ code: "LimitExceeded", operation: "walk", field: "maxDepth" })
              }

              if (options?.maxEntries !== undefined && entries > options.maxEntries) {
                return yield* vfsError({ code: "LimitExceeded", operation: "walk", field: "maxEntries" })
              }

              if (options?.maxBytes !== undefined && bytes > options.maxBytes) {
                return yield* vfsError({ code: "LimitExceeded", operation: "walk", field: "maxBytes" })
              }

              const reference = token(runtime, record.object).core

              const directory = record.root
                ? reference
                : token(runtime, yield* mapped(caller.stat(record.entry.parent))).core

              const entry: V.WalkEntry = {
                path: yield* oldPath(record.path),
                name: record.root ? raw.slice(raw.lastIndexOf(47) + 1) : Path.toBytes(record.entry.name),
                reference,
                directory,
                kind: record.object.kind,
                depth
              }

              if (options?.order !== "post") {
                return [entry]
              }

              const ready: Array<V.WalkEntry> = []

              while (directories.length > 0 && directories[directories.length - 1]!.depth >= depth) {
                ready.push(directories.pop()!.entry)
              }

              if (entry.kind === "directory") {
                directories.push({ depth, entry })
              } else ready.push(entry)

              return ready
            })
          ),
          Stream.flatMap(Stream.fromIterable)
        )

        return Stream.concat(
          walked,
          Stream.suspend(() => Stream.fromIterable(directories.reverse().map((item) => item.entry)))
        )
      })
  }

  function open(value: V.Entry, options: V.OpenEntryOptions): Effect.Effect<V.OpenEntryResult, V.FsFailure, Scope.Scope>
  function open(
    value: V.Target | V.PathInput | V.ObjectReference | V.FileHandle,
    options: V.OpenOptions
  ): Effect.Effect<V.FileHandle, V.FsFailure, Scope.Scope>
  function open(
    value: V.Target | V.PathInput | V.ObjectReference | V.FileHandle | V.Entry,
    options: V.OpenOptions | V.OpenEntryOptions
  ): Effect.Effect<V.FileHandle | V.OpenEntryResult, V.FsFailure, Scope.Scope> {
    return isEntry(value)
      ? execute(runtime, "open", value, fs.open(value, options))
      : execute(runtime, "open", value, fs.open(value, options))
  }

  function remove(
    value: V.EntryInput,
    options?: V.RemoveOptions & { readonly force?: false }
  ): Effect.Effect<V.DirectoryChange, V.FsFailure>
  function remove(
    value: V.EntryInput,
    options: V.RemoveOptions
  ): Effect.Effect<V.DirectoryChange | undefined, V.FsFailure>
  function remove(value: V.EntryInput, options?: V.RemoveOptions) {
    return execute(runtime, "remove", value, options === undefined ? fs.remove(value) : fs.remove(value, options))
  }

  const perform = <A, R>(
    operation: string,
    value: V.TargetInput | V.EntryInput | undefined,
    effect: Effect.Effect<A, V.FsFailure, R>,
    destination?: V.TargetInput | V.EntryInput
  ) => execute(runtime, operation, value, effect.pipe(Effect.mapError(callerFailure)), destination)

  return {
    ...fs,
    root: perform("root", undefined, fs.root),
    lookup: (value) => perform("lookup", value, fs.lookup(value)),
    parent: (value) => perform("parent", value, fs.parent(value)),
    stat: (value) => perform("stat", value, fs.stat(value)),
    readDirectory: (value) => perform("readDirectory", value, fs.readDirectory(value)),
    readFile: (value) => perform("readFile", value, fs.readFile(value)),
    readLink: (value) => perform("readLink", value, fs.readLink(value)),
    realPath: (value) => perform("realPath", value, fs.realPath(value)),
    access: (value, bits = 0) =>
      execute(
        runtime,
        "access",
        value,
        !Number.isInteger(bits) || bits < 0 || bits > 7
          ? Errors.fsFailure("InvalidArgument", "access", { field: "bits" })
          : fs.access(value, bits)
      ),
    writeFile: dual(
      3,
      (value: V.EntryInput, bytes: Uint8Array, options: V.WriteFileOptions) =>
        perform("writeFile", value, fs.writeFile(value, bytes, options))
    ),
    mkdir: (value, options) => perform("mkdir", value, fs.mkdir(value, options)),
    symlink: (target, value, options) => perform("symlink", value, fs.symlink(target, value, options)),
    link: dual(
      2,
      (source: V.TargetInput, value: V.EntryInput) => perform("link", source, fs.link(source, value), value)
    ),
    unlink: (value) => perform("unlink", value, fs.unlink(value)),
    rmdir: (value) => perform("rmdir", value, fs.rmdir(value)),
    rename: dual(
      2,
      (source: V.EntryInput, value: V.EntryInput) => perform("rename", source, fs.rename(source, value), value)
    ),
    chmod: dual(2, (value: V.TargetInput, mode: number) => perform("chmod", value, fs.chmod(value, mode))),
    chown: dual(
      2,
      (value: V.TargetInput, owner: V.OwnerUpdate) => perform("chown", value, fs.chown(value, owner))
    ),
    utimes: dual(
      2,
      (value: V.TargetInput, times: V.Times) => perform("utimes", value, fs.utimes(value, times))
    ),
    truncate: dual(
      2,
      (value: V.TargetInput, length: bigint) => perform("truncate", value, fs.truncate(value, length))
    ),
    setattr: dual(
      2,
      (value: V.TargetInput, attributes: V.SetattrOptions) => perform("setattr", value, fs.setattr(value, attributes))
    ),
    open,
    remove,
    openDirectory: (value) => perform("openDirectory", value, fs.openDirectory(value)),
    withRoot: (value) => perform("withRoot", value, fs.withRoot(value)),
    withDirectory: (value) => perform("withDirectory", value, fs.withDirectory(value)),
    watch: (value, options) => perform("watch", value, fs.watch(value, options))
  }
}

const semantic = (m: State.NodeMetadata): P.SemanticMetadata => ({
  objectNumber: m.ino,
  uid: m.uid,
  gid: m.gid,
  mode: m.mode,
  atime: nano(m.atimeNs),
  mtime: nano(m.mtimeNs),
  ctime: nano(m.ctimeNs),
  birthtime: nano(m.birthtimeNs)
})

const record = Data.taggedEnum<P.CaptureRecord>()

const records = (state: State.VolumeState): Array<P.CaptureRecord> => {
  const root = State.getNode(state, State.ROOT_INO)

  if (root === undefined) return []
  const result: Array<P.CaptureRecord> = [record.root({ id: 1n, metadata: semantic(root.metadata) })]
  const seen = new Set([State.ROOT_INO])
  const pending = [root]

  for (const node of pending) {
    if (node.kind !== "directory") continue

    for (const [name, id] of node.entries) {
      const child = State.getNode(state, id)

      if (child === undefined) continue
      const common = { parentId: BigInt(node.ino), name: Result.getOrThrow(Path.fromBytes(Paths.nameBytes(name))) }

      if (seen.has(id)) {
        result.push(record.alias({ ...common, targetId: BigInt(id) }))
        continue
      }

      seen.add(id)
      const fields = { ...common, id: BigInt(id), metadata: semantic(child.metadata) }

      if (child.kind === "directory") {
        result.push(record.directory({ ...fields }))
        pending.push(child)
      } else if (child.kind === "file") result.push(record.file({ ...fields, data: child.data }))
      else result.push(record.symlink({ ...fields, target: Result.getOrThrow(Path.fromBytes(child.target)) }))
    }
  }

  return result
}

const snapshot = Effect.fnUntraced(function*(owner: P.Owner) {
  const capture = yield* mapped(owner.capture())
  const input = yield* Stream.runCollect(capture.records()).pipe(Effect.mapError(failure))
  const specs = new Map<bigint, NodeSpec>()

  const ids = new Map(
    input.filter((record) => !Predicate.isTagged(record, "alias")).map(
      (record) => [record.id, State.Ino(Number(record.metadata.objectNumber))]
    )
  )

  for (const r of input) {
    if (Predicate.isTagged(r, "alias")) {
      const prior = specs.get(r.targetId)

      if (prior !== undefined && prior.kind !== "directory") {
        specs.set(r.targetId, {
          ...prior,
          links: [...prior.links, { parent: ids.get(r.parentId)!, name: Hex.encode(Path.toBytes(r.name)) }]
        })
      }

      continue
    }

    const m = r.metadata

    const common = {
      ino: State.Ino(Number(m.objectNumber)),
      revision: 1n,
      metadata: {
        uid: m.uid,
        gid: m.gid,
        mode: m.mode,
        atimeNs: m.atime,
        mtimeNs: m.mtime,
        ctimeNs: m.ctime,
        birthtimeNs: m.birthtime
      }
    }

    const link = Predicate.isTagged(r, "root")
      ? { parent: State.ROOT_INO, name: "" }
      : { parent: ids.get(r.parentId)!, name: Hex.encode(Path.toBytes(r.name)) }

    if (Predicate.isTagged(r, "root") || Predicate.isTagged(r, "directory")) {
      specs.set(r.id, { ...common, kind: "directory", ...link })
    } else if (Predicate.isTagged(r, "file")) specs.set(r.id, { ...common, kind: "file", links: [link], data: r.data })
    else specs.set(r.id, { ...common, kind: "symlink", links: [link], target: Path.toBytes(r.target) })
  }

  return Image.make(assemble([...specs.values()]))
})

type Source = { readonly _tag: "Empty" } | { readonly _tag: "Restored"; readonly value: State.VolumeState } | {
  readonly _tag: "Live"
}

export const makeVolume = Effect.fnUntraced(
  function*(
    source: Source,
    provider: CommitProvider<State.VolumeState>,
    options?: V.VolumeOptions,
    _durability?: V.VolumeDurability
  ) {
    if (provider.mode !== "memory" || Predicate.isTagged(source, "Live")) return yield* blocked("durableCommit")
    const checked = yield* Effect.fromResult(Limits.configuration(options))
    const limits = checked.limits

    const configuration: P.LimitOptions = {
      synchronous: checked.options.execution === "sync",
      entries: limits.maxEntries ?? Number.MAX_SAFE_INTEGER,
      contentBytes: limits.maxBytes ?? ByteSize.bytes(Number.MAX_SAFE_INTEGER),
      fileBytes: limits.maxFileBytes,
      ioBytes: ByteSize.bytes(State.MAX_FILE_BYTES),
      pathBytes: limits.maxPathBytes ?? ByteSize.bytes(Number.MAX_SAFE_INTEGER),
      objects: Number.MAX_SAFE_INTEGER,
      callers: Number.MAX_SAFE_INTEGER,
      handles: Number.MAX_SAFE_INTEGER,
      operations: limits.maxPendingOperations,
      transientBytes: ByteSize.bytes(Number.MAX_SAFE_INTEGER),
      restorePayloadBytes: limits.maxBytes ?? ByteSize.bytes(Number.MAX_SAFE_INTEGER),
      restoreRecords: Number.MAX_SAFE_INTEGER
    }

    if (!Predicate.isTagged(source, "Empty") && !Predicate.isTagged(source, "Restored")) {
      return yield* blocked("durableCommit")
    }

    const owner = yield* mapped(
      Predicate.isTagged(source, "Empty")
        ? P.make({ limits: configuration })
        : P.restore(Stream.fromIterable(records(source.value)), { limits: configuration })
    )

    const rootScope = yield* Scope.make()

    const runtime: Runtime = {
      owner,
      clock: yield* Clock.Clock,
      rootScope,
      tokens: [],
      references: new WeakMap(),
      files: new WeakMap(),
      directories: new WeakMap(),
      revision: 1n,
      busy: false,
      gate: Semaphore.makeUnsafe(1)
    }

    const random = yield* SecureRandom.SecureRandom
    const identity = checked.identity ?? VolumeIdentity.make(Hex.encode(yield* random.randomBytes(16)))
    const incarnation = VolumeIncarnation.make(Hex.encode(yield* random.randomBytes(16)))

    const volume: V.Volume = {
      [VolumeId]: true,
      durability: "memory-only",
      identity,
      incarnation,
      limits,
      usage: owner.usage.pipe(Effect.map((u) => ({ entries: u.entries, usedBytes: u.contentBytes }))),
      snapshot: snapshot(owner),
      caller: Effect.fnUntraced(function*(o) {
        const chosen = yield* Effect.fromResult(Errors.decodeConfiguration(RootCallerOptions, o ?? {}, "caller"))

        const caller = yield* mapped(Scope.provide(
          owner.authorize({
            credentials: chosen.identity === undefined
              ? { uid: 0, gid: 0, privileged: true }
              : {
                uid: chosen.identity.uid,
                gid: chosen.identity.gid,
                privileged: chosen.identity.privileged,
                supplementaryGroups: chosen.identity.groups
              },
            umask: chosen.umask
          }),
          rootScope
        ))

        return wrapCaller(runtime, caller, limits, chosen.umask)
      }),
      watch: () => blocked("watch"),
      referenceKey: () => blocked("referenceKey"),
      resolveReferenceKey: () => blocked("referenceKey")
    }

    runtimes.set(volume, runtime)
    const changes: Effect.Effect<Array<ObservationEntry>> = blocked("overlay")
    const capture: Effect.Effect<{ snapshot: V.Snapshot; observation: Array<ObservationEntry> }> = blocked("overlay")

    return { volume, shutdown: Effect.void, observe: { changes, capture } }
  }
)
