// The compatibility boundary owns core tokens and policy; all live filesystem state belongs to the public preview.
/* eslint-disable effecttsgo/experimental-api-usage */
import { BytePath as Path, VirtualFileSystem as P } from "@effect-vfs/effect-preview"
import { unixNanoFromNanoseconds as nano } from "@effect-vfs/effect-preview/DateTime"
import { ByteSize, Data, Effect, Option, Predicate, Result, Schema, Scope, Stream } from "effect"
import * as Clock from "effect/Clock"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Hex from "effect/encoding/Hex"
import { dual } from "effect/Function"
import * as Semaphore from "effect/Semaphore"
import {
  CallerId,
  MkdirOptions,
  ObjectReferenceId,
  RemoveOptions,
  RootCallerOptions,
  SetattrOptions,
  SymlinkOptions,
  WalkOptions
} from "../Caller.js"
import { DirectoryHandleId, FileHandleId } from "../FileHandle.js"
import { type Metadata, Mode, OwnerUpdate, type Times, Times as TimesSchema, Timestamp } from "../Metadata.js"
import { isEntry, Target } from "../Target.js"
import { make as vfsError } from "../VfsError.js"
import type * as V from "../VirtualFileSystem.js"
import { ReferenceKey, VolumeId, VolumeIdentity, VolumeIncarnation } from "../Volume.js"
import * as CorePath from "./bytePath.js"
import { sameBytes } from "./bytes.js"
import {
  type CommitProvider,
  Errors,
  OpenEntryOptions as EntryOpenSchema,
  OpenOptions as OpenSchema,
  Paths,
  State,
  VolumeTestSeams,
  WriteFileOptions as WriteSchema
} from "./engine.js"
import { imageFailure } from "./errors.js"
import { hmacSha256, sameTag } from "./hmac.js"
import * as Image from "./image.js"
import type { ObservationEntry } from "./overlayDiff.js"
import * as Limits from "./volumeLimits.js"
import { assemble, type NodeSpec, reachableValue } from "./volumeState.js"

export class PreviewBlocker extends Data.TaggedError("PreviewBlocker")<{
  readonly feature: string
}> {
  override get message() {
    return `The pinned preview has no public operation for ${this.feature}`
  }
}

class InvalidClockSample extends Data.TaggedError("InvalidClockSample")<{}> {}

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

const mapped = <A, R>(effect: Effect.Effect<A, P.VirtualFileSystemError | V.FsFailure, R>) =>
  effect.pipe(Effect.mapError((error) => Predicate.isTagged(error, "VfsError") ? error : failure(error)))

const path = (value: V.PathInput): Effect.Effect<P.Path, V.FsFailure> =>
  Effect.fromResult(Paths.inputBytes(value)).pipe(
    Effect.mapError((code) => Errors.fsFailure(code, "path", { path: value })),
    Effect.flatMap((bytes) =>
      Effect.fromResult(Path.fromBytes(bytes)).pipe(
        Effect.mapError((cause) => Errors.fsFailure("InvalidArgument", "path", { cause, path: value }))
      )
    )
  )

const unlocated = new WeakSet<V.FsFailure>()

const noPath = (error: V.FsFailure) => {
  unlocated.add(error)

  return error
}

const decode = <A, I>(schema: Schema.Codec<A, I>, input: I, operation: string) =>
  Effect.fromResult(Errors.decodeConfiguration(schema, input, operation)).pipe(Effect.mapError(noPath))

const oldPath = (value: Path.BytePath) => Paths.pathFromBytes(Path.toBytes(value))

interface Token {
  readonly reference: P.ObjectReference
  revision: P.ObjectRevision
  number: bigint
  readonly core: V.ObjectReference
  readonly ino: bigint
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
  highestObjectNumber: bigint
  snapshotEpoch: number
  busy: boolean
  readonly gate: Semaphore.Semaphore
  readonly orders: Map<bigint, Array<string>>
  readonly retained: Array<WeakRef<P.FileHandle | P.DirectoryHandle>>
  readonly time: { active: boolean; value: bigint | undefined }
  readonly readClock: () => bigint
  readonly links: Map<bigint, Uint8Array>
  readonly grants: WeakMap<V.FileHandle | V.DirectoryHandle, Grant>
  readonly activeGrants: Array<WeakRef<Grant>>
  readonly pending: Array<Effect.Effect<void>>
}

const runtimes = new WeakMap<V.Volume, Runtime>()

const ownerRuntimes = new WeakMap<P.Owner, Runtime>()

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
  const selected = error.path ?? (unlocated.has(error) || value === undefined ? undefined : errorPath(value))
  const details: ErrorDetails = { cause: error.cause }

  if (error.field !== undefined) details.field = error.field

  if (selected !== undefined) details.path = selected

  return Errors.fsFailure(error.code, operation, details)
}

export const drainPending = Effect.fnUntraced(function*(runtime: Runtime) {
  while (runtime.pending.length > 0) {
    const release = runtime.pending.shift()

    if (release !== undefined) yield* release
  }
})

// The core boundary serializes its compatibility observations. Native calls share its busy guard.
const execute = <A, R>(
  runtime: Runtime,
  operation: string,
  source: V.TargetInput | V.EntryInput | undefined,
  effect: Effect.Effect<A, V.FsFailure, R>,
  destination?: V.TargetInput | V.EntryInput
): Effect.Effect<A, V.FsFailure, R> =>
  runtime.gate.withPermit(Effect.acquireUseRelease(
    Effect.suspend(() =>
      runtime.busy ? Effect.fail(Errors.fsFailure("VolumeBusy", operation)) : Effect.sync(() => {
        runtime.busy = true
        runtime.time.active = true
        runtime.time.value = undefined
        runtime.snapshotEpoch++
      })
    ),
    () =>
      effect.pipe(
        Effect.catchDefect((cause) =>
          Predicate.isTagged(cause, "InvalidClockSample")
            ? Errors.argumentFailure(operation, "clock.currentTimeNanos")
            : Effect.die(cause)
        ),
        Effect.mapError((error) => contextual(error, operation, source, destination))
      ),
    () =>
      Effect.sync(() => {
        runtime.busy = false
        runtime.time.active = false
        runtime.time.value = undefined
      }).pipe(Effect.andThen(drainPending(runtime)))
  ))

const token = (runtime: Runtime, observation: P.ObjectObservation): Token => {
  if (observation.metadata.objectNumber > runtime.highestObjectNumber) {
    runtime.highestObjectNumber = observation.metadata.objectNumber
  }

  const known = runtime.tokens.find((t) => P.equalsObjectReference(t.reference, observation.reference))

  if (known !== undefined) {
    if (!P.equalsObjectRevision(known.revision, observation.revision)) {
      known.revision = observation.revision
      known.number = runtime.revision > known.number ? runtime.revision : known.number + 1n
    }

    return known
  }

  const core: V.ObjectReference = Object.freeze({ [ObjectReferenceId]: true as const })

  const created: Token = {
    core,
    ino: observation.metadata.objectNumber,
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
      const grant = runtime.grants.get(selected.handle)

      if (grant !== undefined) {
        yield* checkGrant(runtime, grant).pipe(
          Effect.mapError((error) =>
            error.code === "InvalidHandle" || error.code === "ClosedCaller"
              ? Errors.fsFailure("InvalidHandle", "target")
              : error
          )
        )
      }

      const file = FileHandleId in selected.handle ? runtime.files.get(selected.handle) : undefined

      if (file !== undefined) {
        return (yield* mapped(file.stat()).pipe(
          Effect.mapError((error) => Errors.fsFailure(error.code, error.operation))
        )).reference
      }

      const directory = DirectoryHandleId in selected.handle ? runtime.directories.get(selected.handle) : undefined

      if (directory !== undefined) {
        return (yield* mapped(directory.stat()).pipe(
          Effect.mapError((error) => Errors.fsFailure(error.code, error.operation))
        )).reference
      }

      return yield* Errors.fsFailure(handleOwners.has(selected.handle) ? "ForeignHandle" : "InvalidHandle", "target")
    }

    yield* Effect.fromResult(Paths.preparePath(selected.path, "path", runtime.owner.limits.expandedPathBytes))
    const name = yield* path(selected.path)

    if (
      selected.relativeTo === undefined ||
      (Predicate.isString(name) ? name.startsWith("/") : Path.toBytes(name)[0] === 47)
    ) return name
    const directory = runtime.directories.get(selected.relativeTo)

    if (directory === undefined) {
      return yield* Errors.fsFailure(
        handleOwners.has(selected.relativeTo) ? "ForeignHandle" : "InvalidHandle",
        "target"
      )
    }

    return { directory, name }
  }
)

const entry = Effect.fnUntraced(
  function*(
    runtime: Runtime,
    value: V.EntryInput | V.TargetInput,
    caller?: P.VirtualFileSystem
  ): Effect.fn.Return<P.EntryTarget, V.FsFailure> {
    if (caller !== undefined && !isEntry(value)) yield* validateBase(runtime, caller, value)

    if (isEntry(value)) {
      if (caller === undefined) return yield* Errors.fsFailure("InvalidArgument", "entry")
      const observed = yield* stat(runtime, caller, value.directory)

      if (observed.kind === "directory" && observed.metadata.nlink === 0n) {
        const directory = Target.of(value.directory)

        return yield* Errors.fsFailure(
          Predicate.isTagged(directory, "Reference") ? "StaleReference" : "NotFound",
          "entry"
        )
      }

      if (Predicate.isString(value.name) && !Paths.isWellFormed(value.name)) {
        return yield* noPath(Errors.fsFailure("InvalidPathEncoding", "entry"))
      }

      const bytes = Predicate.isString(value.name) ? new TextEncoder().encode(value.name) : value.name

      if (
        !Predicate.isUint8Array(bytes) || bytes.length === 0 || bytes.length > 255 || bytes.includes(0) ||
        bytes.includes(47) || (bytes.length === 1 && bytes[0] === 46) ||
        (bytes.length === 2 && bytes[0] === 46 && bytes[1] === 46)
      ) return yield* noPath(Errors.fsFailure("InvalidArgument", "entry"))

      const name = yield* Effect.fromResult(Path.fromBytes(bytes)).pipe(
        Effect.mapError((cause) => Errors.fsFailure("InvalidArgument", "entry", { cause }))
      )

      return { directory: observed.reference, name }
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

const validateResolution = Effect.fnUntraced(
  function*(runtime: Runtime, caller: P.VirtualFileSystem, value: V.TargetInput, followFinal = true) {
    const selected = Target.of(value)

    if (!Predicate.isTagged(selected, "Path") || selected.relativeTo !== undefined) return

    let bytes = yield* Effect.fromResult(Paths.inputBytes(selected.path)).pipe(
      Effect.mapError((code) => Errors.fsFailure(code, "path", { path: selected.path }))
    )

    for (let links = 0; links <= Paths.MAX_SYMLINK_TRAVERSALS; links++) {
      yield* Effect.fromResult(
        Paths.preparePath(Paths.ownedPath(bytes), "path", runtime.owner.limits.expandedPathBytes)
      ).pipe(Effect.mapError((error) => Errors.fsFailure(error.code, "path", { path: selected.path })))
      let expanded = false

      for (let end = 0; end <= bytes.length; end++) {
        if (end < bytes.length && bytes[end] !== 47) continue

        if (end === 0 || bytes[end - 1] === 47 || (!followFinal && end === bytes.length)) continue
        const prefix = Result.getOrThrow(Path.fromBytes(bytes.subarray(0, end)))
        const object = yield* Effect.result(mapped(caller.linkStat(prefix)))

        if (Result.isFailure(object)) return

        if (object.success.kind !== "symlink") continue
        const target = runtime.links.get(object.success.metadata.objectNumber)

        if (target === undefined) return

        if (links === Paths.MAX_SYMLINK_TRAVERSALS) {
          return yield* Errors.fsFailure("SymlinkLoop", "path", {
            path: selected.path
          })
        }

        const parent = target[0] === 47
          ? new Uint8Array()
          : bytes.subarray(0, bytes.subarray(0, end).lastIndexOf(47) + 1)

        const joined = new Uint8Array(parent.length + target.length + bytes.length - end)
        joined.set(parent)
        joined.set(target, parent.length)
        joined.set(bytes.subarray(end), parent.length + target.length)
        bytes = joined
        expanded = true
        break
      }

      if (!expanded) return
    }
  }
)

interface Boundary {
  readonly caller: P.VirtualFileSystem
  readonly ino: bigint
}

interface Grant {
  readonly handle: P.FileHandle | P.DirectoryHandle
  readonly boundaries: ReadonlyArray<Boundary>
  allowed: boolean
}

const boundariesOf = (runtime: Runtime, value: V.TargetInput | V.EntryInput): ReadonlyArray<Boundary> => {
  if (isEntry(value)) return boundariesOf(runtime, value.directory)
  const selected = Target.of(value)

  const handle = Predicate.isTagged(selected, "Handle") ?
    selected.handle
    : Predicate.isTagged(selected, "Path")
    ? selected.relativeTo
    : undefined

  return handle === undefined ? [] : runtime.grants.get(handle)?.boundaries ?? []
}

const forkBoundaries = Effect.fnUntraced(function*(caller: P.VirtualFileSystem, inherited: ReadonlyArray<Boundary>) {
  const boundaries: Array<Boundary> = []

  for (const source of [caller, ...inherited.map((boundary) => boundary.caller)]) {
    const independent = yield* mapped(source.withRoot("/"))
    const root = yield* mapped(independent.stat("/"))
    boundaries.push({ caller: independent, ino: root.metadata.objectNumber })
  }

  return boundaries
})

const checkRoots = Effect.fnUntraced(function*(runtime: Runtime, boundaries: ReadonlyArray<Boundary>) {
  for (const boundary of boundaries) {
    const root = yield* Effect.result(mapped(boundary.caller.stat("/")))

    if (Result.isSuccess(root)) {
      if (root.success.metadata.nlink === 0n) return yield* Errors.fsFailure("ClosedCaller", "authority")
      continue
    }

    const state = yield* Image.valueOf(yield* snapshot(runtime.owner)).pipe(Effect.orDie)

    if (State.getNode(state, State.Ino(Number(boundary.ino))) === undefined) {
      return yield* Errors.fsFailure("ClosedCaller", "authority")
    }

    return yield* root.failure
  }
})

const checkGrant = Effect.fnUntraced(function*(runtime: Runtime, grant: Grant) {
  const object = yield* mapped(grant.handle.stat())
  yield* checkRoots(runtime, grant.boundaries)

  if (object.metadata.nlink === 0n) {
    if (!grant.allowed) return yield* Errors.fsFailure("AccessDenied", "authority")

    return
  }

  for (const boundary of grant.boundaries) yield* mapped(boundary.caller.stat(object.reference))
})

const refreshGrants = Effect.fnUntraced(function*(runtime: Runtime) {
  for (const retained of runtime.activeGrants) {
    const grant = retained.deref()

    if (grant === undefined) continue
    const object = yield* Effect.result(grant.handle.stat())

    if (Result.isFailure(object) || object.success.metadata.nlink === 0n) continue
    const check = yield* Effect.result(checkGrant(runtime, grant))
    grant.allowed = Result.isSuccess(check)
  }
})

const validateBase = Effect.fnUntraced(function*(runtime: Runtime, caller: P.VirtualFileSystem, value: V.TargetInput) {
  const selected = Target.of(value)

  if (!Predicate.isTagged(selected, "Path") || selected.relativeTo === undefined) return
  const base = runtime.directories.get(selected.relativeTo)

  if (base === undefined) return

  const raw = yield* Effect.fromResult(Paths.inputBytes(selected.path)).pipe(
    Effect.mapError((code) => Errors.fsFailure(code, "path"))
  )

  const grant = runtime.grants.get(selected.relativeTo)
  const root = yield* mapped(caller.stat("/"))

  if (
    raw[0] === 47 && root.metadata.objectNumber === 1n &&
    (grant === undefined || grant.boundaries.every((boundary) => boundary.ino === 1n))
  ) return

  if (grant !== undefined) {
    yield* checkGrant(runtime, grant).pipe(
      Effect.mapError((error) =>
        error.code === "InvalidHandle" || error.code === "ClosedCaller"
          ? Errors.fsFailure("InvalidHandle", "target")
          : error
      )
    )
  }

  const object = yield* mapped(base.stat())

  if (object.metadata.nlink === 0n) return yield* Errors.fsFailure("NotFound", "target")
  yield* mapped(caller.stat(object.reference))
})

interface LocatedTarget {
  readonly caller: P.VirtualFileSystem
  readonly target: P.Target
}

interface LocatedEntry {
  readonly caller: P.VirtualFileSystem
  readonly target: P.EntryTarget
}

const addressed = Effect.fnUntraced(
  function*(
    runtime: Runtime,
    caller: P.VirtualFileSystem,
    value: V.TargetInput
  ): Effect.fn.Return<LocatedTarget, V.FsFailure, Scope.Scope> {
    yield* validateBase(runtime, caller, value)
    const selected = Target.of(value)

    if (Predicate.isTagged(selected, "Path") && selected.relativeTo !== undefined) {
      const raw = yield* Effect.fromResult(Paths.inputBytes(selected.path)).pipe(
        Effect.mapError((code) => Errors.fsFailure(code, "path"))
      )

      if (raw[0] !== 47) {
        const directory = runtime.directories.get(selected.relativeTo)

        if (directory === undefined) {
          return yield* Errors.fsFailure(
            handleOwners.has(selected.relativeTo) ? "ForeignHandle" : "InvalidHandle",
            "target"
          )
        }

        const actor = yield* mapped(caller.withCurrentDirectory(directory))
        const target = yield* path(selected.path)

        return { caller: actor, target }
      }
    }

    return { caller, target: yield* target(runtime, value) }
  }
)

const entryActor = Effect.fnUntraced(
  function*(
    runtime: Runtime,
    caller: P.VirtualFileSystem,
    value: V.EntryInput
  ): Effect.fn.Return<LocatedEntry, V.FsFailure, Scope.Scope> {
    if (isEntry(value)) return { caller, target: yield* entry(runtime, value, caller) }
    const located = yield* addressed(runtime, caller, value)
    const selected = located.target

    if (Predicate.isString(selected) || Path.isBytePath(selected) || "directory" in selected) {
      return { caller: located.caller, target: selected }
    }

    return yield* Errors.fsFailure("InvalidArgument", "entry")
  }
)

const retainedObservation = Effect.fnUntraced(function*(runtime: Runtime, reference: P.ObjectReference) {
  for (const retained of runtime.retained) {
    const handle = retained.deref()

    if (handle === undefined) continue
    const object = yield* Effect.result(handle.stat())

    if (Result.isSuccess(object) && P.equalsObjectReference(object.success.reference, reference)) {
      return Option.some(object.success)
    }
  }

  return Option.none<P.ObjectObservation>()
})

const stat = Effect.fnUntraced(
  function*(
    runtime: Runtime,
    caller: P.VirtualFileSystem,
    value: V.TargetInput
  ): Effect.fn.Return<P.ObjectObservation, V.FsFailure> {
    yield* validateBase(runtime, caller, value)
    yield* validateResolution(runtime, caller, value, follow(value))

    return yield* Effect.scoped(Effect.gen(function*() {
      const located = yield* addressed(runtime, caller, value)
      const selected = located.target
      const actor = located.caller

      const directoryRequired = !follow(value) && (Predicate.isString(selected) || Path.isBytePath(selected)) &&
        (Predicate.isString(selected) ? selected.endsWith("/") : Path.toBytes(selected).at(-1) === 47)

      const result = yield* Effect.result(
        follow(value) || directoryRequired ?
          mapped(actor.stat(selected))
          : (Predicate.isString(selected) || Path.isBytePath(selected) || "directory" in selected)
          ? mapped(actor.linkStat(selected)) :
          mapped(actor.stat(selected))
      )

      if (Result.isSuccess(result)) {
        if (directoryRequired && result.success.kind !== "directory") {
          return yield* Errors.fsFailure("NotDirectory", "stat")
        }

        for (const boundary of boundariesOf(runtime, value)) {
          yield* mapped(boundary.caller.stat(result.success.reference))
        }

        return result.success
      }

      if (
        !Predicate.isString(selected) && !Path.isBytePath(selected) && !("directory" in selected)
        && Predicate.isTagged(result.failure.cause, "AccessDenied") &&
        Predicate.hasProperty(result.failure.cause, "reason") &&
        result.failure.cause.reason === "temporarilyInaccessibleReference"
      ) {
        const root = yield* mapped(caller.stat("/"))

        if (root.metadata.objectNumber === 1n) {
          const retained = yield* retainedObservation(runtime, selected)

          if (
            Option.isSome(retained) &&
            (retained.value.kind !== "directory" || Predicate.isTagged(Target.of(value), "Handle")) &&
            retained.value.metadata.nlink === 0n
          ) {
            return retained.value
          }

          const issued = runtime.tokens.find((token) => P.equalsObjectReference(token.reference, selected))

          if (issued !== undefined) {
            const captured = yield* Image.valueOf(yield* snapshot(runtime.owner)).pipe(Effect.orDie)

            if (State.getNode(captured, State.Ino(Number(issued.ino))) === undefined) {
              return yield* Errors.fsFailure("StaleReference", "stat")
            }
          }
        }
      }

      return yield* result.failure
    }))
  }
)

const allocation = (runtime: Runtime) =>
  runtime.highestObjectNumber >= BigInt(State.MAX_INO)
    ? Effect.fail(Errors.fsFailure("NoSpace", "create"))
    : Effect.void

const times = (value: Times): P.Attributes => {
  const selected = (time: Times["access"]): P.Attributes["atime"] =>
    time.kind === "omit" ? undefined : time.kind === "now" ? "now" : nano(time.nanoseconds)

  return { atime: selected(value.access), mtime: selected(value.modification) }
}

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

const acquisition = <A>(effect: Effect.Effect<A, V.FsFailure, Scope.Scope>) =>
  effect.pipe(
    Effect.catch((error) =>
      Effect.flatMap(Scope.Scope, (scope) =>
        Predicate.isTagged(scope.state, "Closed") ? Effect.interrupt : Effect.fail(error))
    )
  )

const liveScope = Effect.flatMap(
  Scope.Scope,
  (scope) => Predicate.isTagged(scope.state, "Closed") ? Effect.interrupt : Effect.void
)

const wrapFile = (
  runtime: Runtime,
  handle: P.FileHandle,
  positioned = handle,
  append = false,
  access: V.OpenOptions["access"] = "readWrite",
  boundaries: ReadonlyArray<Boundary> = []
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

  const grant: Grant = { handle, boundaries, allowed: true }
  let closed = false

  const available = <A, R>(operation: string, effect: Effect.Effect<A, V.FsFailure, R>) =>
    Effect.suspend(() =>
      closed || ((operation === "write" || operation === "pwrite" || operation === "truncate") && access === "read") ||
        ((operation === "read" || operation === "pread") && access === "write")
        ? Effect.fail(Errors.fsFailure("InvalidHandle", operation)) :
        operation === "close"
        ? effect
        : Effect.andThen(checkGrant(runtime, grant), effect).pipe(
          Effect.mapError((error) =>
            error.code === "ClosedCaller" ? Errors.fsFailure("InvalidHandle", operation) : error
          )
        )
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
    pread: (n, offset) =>
      execute(runtime, "pread", undefined, file.pread(n, offset)).pipe(
        Effect.mapError((error) => error.code === "InvalidArgument" ? Errors.fsFailure(error.code, "read") : error)
      ),
    write: (bytes) => execute(runtime, "write", undefined, file.write(bytes)),
    pwrite: dual(
      2,
      (bytes: Uint8Array, offset: bigint) =>
        execute(runtime, "pwrite", undefined, file.pwrite(bytes, offset)).pipe(
          Effect.mapError((error) => error.code === "InvalidArgument" ? Errors.fsFailure(error.code, "write") : error)
        )
    ),
    seek: dual(2, (offset: bigint, from: V.SeekMode) => execute(runtime, "seek", undefined, file.seek(offset, from))),
    truncate: (length) => execute(runtime, "truncate", undefined, file.truncate(length)),
    stat: execute(runtime, "stat", undefined, file.stat),
    sync: execute(runtime, "sync", undefined, file.sync),
    close: execute(runtime, "close", undefined, file.close)
  }

  runtime.activeGrants.push(new WeakRef(grant))
  runtime.grants.set(protectedFile, grant)
  runtime.retained.push(new WeakRef(handle))
  runtime.files.set(protectedFile, handle)
  handleOwners.set(protectedFile, runtime)

  return protectedFile
}

const wrapDirectory = (
  runtime: Runtime,
  handle: P.DirectoryHandle,
  boundaries: ReadonlyArray<Boundary>
): V.DirectoryHandle => {
  const grant: Grant = { handle, boundaries, allowed: true }
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
    stat: execute(runtime, "stat", undefined, Effect.andThen(checkGrant(runtime, grant), directory.stat)),
    close: execute(runtime, "close", undefined, directory.close)
  }

  runtime.activeGrants.push(new WeakRef(grant))
  runtime.grants.set(protectedDirectory, grant)
  runtime.retained.push(new WeakRef(handle))
  runtime.directories.set(protectedDirectory, handle)
  handleOwners.set(protectedDirectory, runtime)

  return protectedDirectory
}

const ordered = (runtime: Runtime, list: P.EntryListing) => {
  const id = list.directory.metadata.objectNumber
  const present = new Map(list.entries.map((entry) => [Hex.encode(Path.toBytes(entry.name)), entry]))
  const prior = runtime.orders.get(id) ?? []

  const names = [
    ...prior.filter((name) => present.has(name)),
    ...[...present.keys()].filter((name) => !prior.includes(name))
  ]

  runtime.orders.set(id, names)

  return names.flatMap((name) => {
    const entry = present.get(name)

    return entry === undefined ? [] : [entry]
  })
}

const remember = (runtime: Runtime, parent: P.ObjectObservation, name: Path.BytePath, removed = false) => {
  const id = parent.metadata.objectNumber
  const key = Hex.encode(Path.toBytes(name))
  const prior = runtime.orders.get(id) ?? []
  runtime.orders.set(id, removed ? prior.filter((name) => name !== key) : prior.includes(key) ? prior : [...prior, key])
}

const change = (before: bigint, after: bigint): V.DirectoryChange => ({ before, after })

const callerFailure = (error: V.FsFailure): V.FsFailure =>
  Predicate.isTagged(error.cause, "InvalidResource") && Predicate.hasProperty(error.cause, "reason") &&
    (error.cause.reason === "closed" || error.cause.reason === "closing")
    ? Errors.fsFailure("ClosedCaller", error.operation, { cause: error.cause })
    : error

const wrapCaller = (
  runtime: Runtime,
  caller: P.VirtualFileSystem,
  limits: V.VolumeLimits,
  inherited: ReadonlyArray<Boundary> = [],
  rootIno = 1n,
  identity?: V.RootCallerOptions["identity"],
  cwdIno = rootIno
): V.Caller => {
  const alive = Effect.gen(function*() {
    yield* checkRoots(runtime, inherited)
    const root = yield* Effect.result(mapped(caller.stat("/")))

    if (Result.isSuccess(root)) {
      if (root.success.metadata.nlink === 0n) return yield* Errors.fsFailure("ClosedCaller", "caller")

      return
    }

    if (rootIno !== 1n) {
      const state = yield* Image.valueOf(yield* snapshot(runtime.owner)).pipe(Effect.orDie)

      if (State.getNode(state, State.Ino(Number(rootIno))) === undefined) {
        return yield* Errors.fsFailure("ClosedCaller", "caller")
      }
    }

    return yield* root.failure
  })

  const derive = Effect.fnUntraced(function*(value: V.TargetInput, narrow: boolean) {
    yield* liveScope
    const selected = yield* target(runtime, value)
    const directory = yield* mapped(caller.lookup(selected))
    const boundaries = [...inherited, ...boundariesOf(runtime, value)]
    let parent = caller

    for (const boundary of boundaries) {
      const currentRoot = yield* mapped(parent.stat("/"))
      const inside = yield* Effect.result(mapped(boundary.caller.stat(currentRoot.reference)))

      if (Result.isSuccess(inside)) continue
      const restrictedRoot = yield* mapped(boundary.caller.stat("/"))
      yield* mapped(parent.stat(restrictedRoot.reference))
      parent = yield* mapped(parent.withRoot(restrictedRoot.reference))
    }

    const derived = yield* mapped(narrow ? parent.withRoot(directory) : parent.withCurrentDirectory(directory))
    const root = yield* mapped(derived.stat("/"))
    const retained = yield* forkBoundaries(caller, boundaries)

    return wrapCaller(
      runtime,
      derived,
      limits,
      retained,
      root.metadata.objectNumber,
      identity,
      narrow ? root.metadata.objectNumber : (yield* mapped(parent.stat(directory))).metadata.objectNumber
    )
  })

  const protectRoot = Effect.fnUntraced(function*(value: V.EntryInput, operation: string) {
    yield* Effect.scoped(Effect.gen(function*() {
      const located = yield* entryActor(runtime, caller, value)
      const current = yield* Effect.result(mapped(located.caller.linkStat(located.target)))

      if (
        Result.isSuccess(current) && current.success.kind === "directory" &&
        current.success.metadata.objectNumber === rootIno
      ) return yield* Errors.fsFailure(rootIno === 1n ? "InvalidArgument" : "NotPermitted", operation)
    }))
  })

  const withMask = Effect.fnUntraced(function*(actor: P.VirtualFileSystem, target: P.Target, mask: number) {
    const root = yield* actor.lookup("/")
    const name = Predicate.isString(target) || Path.isBytePath(target) ? target : undefined

    const relative = name !== undefined &&
      (Predicate.isString(name) ? !name.startsWith("/") : Path.toBytes(name)[0] !== 47)

    const cwd = relative ? yield* actor.lookup(".") : root

    return yield* runtime.owner.authorize({
      root,
      cwd,
      umask: mask,
      credentials: identity === undefined
        ? { uid: 0, gid: 0, privileged: true }
        : {
          uid: identity.uid,
          gid: identity.gid,
          privileged: identity.privileged,
          supplementaryGroups: identity.groups
        }
    })
  })

  const onTarget = <A>(
    value: V.TargetInput,
    use: (target: P.Target, actor: P.VirtualFileSystem) => Effect.Effect<A, P.VirtualFileSystemError>
  ) =>
    Effect.scoped(Effect.gen(function*() {
      const located = yield* addressed(runtime, caller, value)

      return yield* mapped(use(located.target, located.caller))
    }))

  const mutateTarget = Effect.fnUntraced(
    function*<A>(
      value: V.TargetInput,
      use: (t: P.Target, actor: P.VirtualFileSystem) => Effect.Effect<A, P.VirtualFileSystemError>
    ) {
      return yield* Effect.scoped(Effect.gen(function*() {
        const located = yield* addressed(runtime, caller, value)
        const t = located.target
        const actor = located.caller
        const prior = yield* Effect.result(stat(runtime, caller, value))

        if (Result.isSuccess(prior)) token(runtime, prior.success)
        else if (prior.failure.code !== "NotFound") return yield* prior.failure
        const result = yield* mapped(use(t, actor))
        const after = yield* Effect.result(stat(runtime, caller, value))

        if (Result.isSuccess(after)) {
          if (Result.isFailure(prior) || !P.equalsObjectRevision(prior.success.revision, after.success.revision)) {
            runtime.revision++
          }

          token(runtime, after.success)
        }

        return result
      }))
    }
  )

  const validateCurrentTimes = Effect.fnUntraced(function*(value: V.TargetInput, t: Times) {
    if (identity === undefined || identity.privileged || t.access.kind !== "now" || t.modification.kind !== "now") {
      return
    }

    const object = yield* stat(runtime, caller, value)

    if (object.metadata.uid !== identity.uid) yield* onTarget(value, (t, actor) => actor.access(t, { write: true }))
  })

  const attributes = (value: V.TargetInput, a: P.Attributes, expectedRevision?: P.ObjectRevision) =>
    mutateTarget(
      value,
      (t, actor) => actor.setAttributes(t, a, { followFinalSymlink: follow(value), expectedRevision })
    )

  const parentEntry = Effect.fnUntraced(
    function*(
      t: P.EntryTarget,
      actor: P.VirtualFileSystem = caller
    ): Effect.fn.Return<P.ObjectObservation, V.FsFailure> {
      const name = Predicate.isString(t) || Path.isBytePath(t) ? t : t.name
      const bytes = Predicate.isString(name) ? new TextEncoder().encode(name) : Path.toBytes(name)
      let end = bytes.length

      while (end > 1 && bytes[end - 1] === 47) end--
      const raw = bytes.subarray(0, end)
      const slash = raw.lastIndexOf(47)

      const parent = yield* Effect.fromResult(
        Path.fromBytes(slash < 0 ? Uint8Array.of(46) : slash === 0 ? Uint8Array.of(47) : raw.slice(0, slash))
      ).pipe(Effect.mapError((cause) => Errors.fsFailure("InvalidPathEncoding", "parent", { cause })))

      if (Predicate.isString(t) || Path.isBytePath(t)) return yield* mapped(actor.stat(parent))

      return yield* Effect.scoped(Effect.gen(function*() {
        const base = yield* mapped(actor.withCurrentDirectory(t.directory))

        return yield* mapped(base.stat(parent))
      }))
    }
  )

  const followedEntry = Effect.fnUntraced(function*(
    address: P.EntryTarget,
    actor: P.VirtualFileSystem,
    boundaries: ReadonlyArray<Boundary>
  ): Effect.fn.Return<LocatedEntry, V.FsFailure, Scope.Scope> {
    let current = address
    let selected = actor

    for (let count = 0; count <= Paths.MAX_SYMLINK_TRAVERSALS; count++) {
      const observed = yield* Effect.result(mapped(selected.linkStat(current)))

      if (Result.isFailure(observed) && observed.failure.code !== "NotFound") return yield* observed.failure

      if (Result.isFailure(observed) || observed.success.kind !== "symlink") {
        const object = Result.isSuccess(observed) ? observed.success : yield* parentEntry(current, selected)

        for (const boundary of boundaries) yield* mapped(boundary.caller.stat(object.reference))

        return { caller: selected, target: current }
      }

      if (count === Paths.MAX_SYMLINK_TRAVERSALS) {
        const name = Predicate.isString(address) || Path.isBytePath(address) ? address : address.name

        return yield* Errors.fsFailure("SymlinkLoop", "open", {
          path: Predicate.isString(name) ? name : Paths.ownedPath(Path.toBytes(name))
        })
      }

      const data = runtime.links.get(observed.success.metadata.objectNumber)

      if (data === undefined) return yield* Errors.fsFailure("StaleReference", "open")
      const parent = yield* parentEntry(current, selected)
      selected = yield* mapped(selected.withCurrentDirectory(parent.reference))
      current = yield* Effect.fromResult(Path.fromBytes(data)).pipe(
        Effect.mapError((cause) => Errors.fsFailure("InvalidPathEncoding", "open", { cause }))
      )
    }

    return yield* Errors.fsFailure("SymlinkLoop", "open")
  })

  const namespace = Effect.fnUntraced(
    function*<A>(
      value: V.EntryInput,
      use: (
        t: P.EntryTarget,
        actor: P.VirtualFileSystem
      ) => Effect.Effect<A, P.VirtualFileSystemError | V.FsFailure, Scope.Scope>,
      recursive = false,
      removed = false
    ) {
      return yield* Effect.scoped(Effect.gen(function*() {
        const located = yield* entryActor(runtime, caller, value)
        const t = located.target
        const actor = located.caller

        if (!isEntry(value)) yield* validateResolution(runtime, caller, value, false)
        const prior = yield* Effect.result(parentEntry(t, actor))

        if (Result.isFailure(prior) && !(recursive && prior.failure.code === "NotFound")) return yield* prior.failure
        const before = Result.isSuccess(prior) ? token(runtime, prior.success).number : runtime.revision

        if (Result.isSuccess(prior)) {
          for (const boundary of boundariesOf(runtime, value)) {
            yield* mapped(boundary.caller.stat(prior.success.reference))
          }
        }

        yield* refreshGrants(runtime)

        const result = yield* mapped(use(t, actor)).pipe(
          Effect.mapError((error) =>
            recursive && Result.isFailure(prior) && prior.failure.code === "NotFound" && error.code === "NotDirectory"
              ? prior.failure :
              error
          )
        )

        const after = yield* parentEntry(t, actor)

        if (Result.isFailure(prior) || !P.equalsObjectRevision(prior.success.revision, after.revision)) {
          runtime.revision++
        }

        const name = Predicate.isString(t) || Path.isBytePath(t) ? t : t.name
        const raw = Predicate.isString(name) ? new TextEncoder().encode(name) : Path.toBytes(name)
        let end = raw.length

        while (end > 1 && raw[end - 1] === 47) end--
        const trimmed = raw.subarray(0, end)
        remember(
          runtime,
          after,
          Result.getOrThrow(Path.fromBytes(trimmed.subarray(trimmed.lastIndexOf(47) + 1))),
          removed
        )

        return { result, directory: change(before, token(runtime, after).number) }
      }))
    }
  )

  const created = (o: P.ObjectObservation, directory: V.DirectoryChange): V.ReferenceEntryResult => ({
    reference: token(runtime, o).core,
    directory
  })

  const removeTree = Effect.fnUntraced(function*(value: V.EntryInput, options: V.RemoveOptions) {
    return yield* Effect.scoped(Effect.gen(function*() {
      const address = yield* entry(runtime, value, caller)
      const found = yield* Effect.result(execute(runtime, "remove", value, mapped(caller.linkStat(address))))

      if (Result.isFailure(found)) {
        if (options.force && found.failure.code === "NotFound") return undefined

        return yield* found.failure
      }

      const first = found.success

      if (
        options.expected !== undefined &&
        !P.equalsObjectReference(yield* reference(runtime, options.expected), first.reference)
      ) return yield* Errors.fsFailure("VolumeBusy", "remove", { field: "expected" })
      const initialParent = yield* execute(runtime, "remove", value, parentEntry(address))
      const before = token(runtime, initialParent).number
      const once = () => execute(runtime, "remove", value, removeCore(value, { ...options, recursive: false }))
      const initial = yield* Effect.result(once())

      if (Result.isSuccess(initial)) return initial.success

      if (initial.failure.code !== "NotEmpty") return yield* initial.failure
      let active = caller
      let root: P.Path

      if (Predicate.isString(address) || Path.isBytePath(address)) root = address
      else {
        active = yield* mapped(caller.withCurrentDirectory(address.directory))
        root = address.name
      }

      const missing = (path: P.Path, code: V.FsCode = "NotFound") =>
        Errors.fsFailure(code, "remove", {
          path: Paths.ownedPath(Predicate.isString(path) ? new TextEncoder().encode(path) : Path.toBytes(path))
        })

      let vanished = false

      const guard = Effect.gen(function*() {
        const boundaries = boundariesOf(runtime, value)
        yield* checkRoots(runtime, boundaries)

        for (const boundary of boundaries) yield* mapped(boundary.caller.stat(first.reference))
        const now = yield* Effect.result(mapped(caller.linkStat(address)))

        if (Result.isFailure(now)) {
          if (options.force && now.failure.code === "NotFound") {
            vanished = true

            return false
          }

          return yield* contextual(now.failure, "remove", value)
        }

        if (!P.equalsObjectReference(now.success.reference, first.reference)) {
          return yield* missing(root, options.expected === undefined ? "NotFound" : "VolumeBusy")
        }

        return true
      })

      interface Frame {
        readonly path: P.Path
        readonly reference: P.ObjectReference
        readonly kind: P.ObjectObservation["kind"]
        readonly listed: boolean
      }

      const pending: Array<Frame> = [{ path: root, reference: first.reference, kind: "directory", listed: false }]
      const seams = yield* VolumeTestSeams

      while (pending.length > 0) {
        if (vanished) break
        const frame = pending.pop()

        if (frame === undefined) break

        if (frame.kind === "directory" && !frame.listed) {
          const listing = yield* Effect.result(execute(
            runtime,
            "remove",
            undefined,
            Effect.gen(function*() {
              if (!(yield* guard)) return []
              const current = yield* Effect.result(mapped(active.linkStat(frame.path)))

              if (Result.isFailure(current) && current.failure.code === "NotFound") return []

              if (Result.isFailure(current)) return yield* current.failure

              if (!P.equalsObjectReference(current.success.reference, frame.reference)) return []

              return yield* Stream.runCollect(active.walk(frame.path, { maxDepth: 1 })).pipe(Effect.mapError(failure))
            }).pipe(Effect.mapError((error) => error.path === undefined ? missing(frame.path, error.code) : error))
          ))

          if (Result.isFailure(listing)) {
            if (listing.failure.code !== "AccessDenied") return yield* listing.failure
            // Empty directories need no read permission to remove.
            yield* seams.beforeTreeRemoval

            const empty = yield* Effect.result(execute(
              runtime,
              "remove",
              undefined,
              Effect.gen(function*() {
                if (!(yield* guard)) return
                yield* mapped(
                  active.removeDirectory(frame.path, { entry: { expected: "present", object: frame.reference } })
                )
                runtime.revision++
              })
            ))

            if (Result.isFailure(empty)) return yield* listing.failure
            continue
          }

          const listed = listing.success

          pending.push({ ...frame, listed: true })
          const base = Predicate.isString(frame.path) ? new TextEncoder().encode(frame.path) : Path.toBytes(frame.path)

          for (const record of [...listed].reverse()) {
            if (record.root) continue
            pending.push({
              path: Result.getOrThrow(Path.fromBytes(Paths.joinPath(base, Path.toBytes(record.entry.name)))),
              reference: record.object.reference,
              kind: record.object.kind,
              listed: false
            })
          }

          continue
        }

        yield* seams.beforeTreeRemoval
        yield* execute(
          runtime,
          "remove",
          undefined,
          Effect.gen(function*() {
            if (!(yield* guard)) return
            const current = yield* mapped(active.linkStat(frame.path))

            if (!P.equalsObjectReference(current.reference, frame.reference)) return yield* missing(frame.path)
            yield* refreshGrants(runtime)
            const condition: P.EntryConditions = { entry: { expected: "present", object: frame.reference } }
            yield* mapped(
              frame.kind === "directory"
                ? active.removeDirectory(frame.path, condition)
                : active.unlink(frame.path, condition)
            )
            runtime.revision++
          }).pipe(Effect.mapError((error) => error.path === undefined ? missing(frame.path, error.code) : error))
        )
      }

      if (vanished) return undefined
      const after = yield* execute(runtime, "remove", value, mapped(caller.stat(initialParent.reference)))

      return change(before, token(runtime, after).number)
    }))
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
      o = yield* Effect.fromResult(Errors.decodeConfiguration(RemoveOptions, o === undefined ? {} : o, "remove"))

      yield* protectRoot(value, "remove")

      if (o.recursive) return yield* removeTree(value, o)

      const selected = o?.expected === undefined
        ? undefined
        : { entry: { expected: "present" as const, object: yield* reference(runtime, o.expected) } }

      const action = namespace(
        value,
        (t, actor) =>
          actor.linkStat(t).pipe(
            Effect.flatMap((object) =>
              object.kind === "directory" ? actor.removeDirectory(t, selected) : actor.unlink(t, selected)
            )
          ),
        false,
        true
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
      yield* liveScope

      if (isEntry(value)) {
        const options = yield* Effect.fromResult(Errors.decodeConfiguration(EntryOpenSchema, o, "open"))

        if (
          (options.initialSize !== undefined || options.owner !== undefined || options.times !== undefined ||
            options.exactMode) && (options.create === undefined || options.create === "never")
        ) return yield* Errors.fsFailure("InvalidArgument", "open")

        if (options.exactMode && options.mode === undefined) return yield* Errors.fsFailure("InvalidArgument", "open")

        if (
          (options.initialSize !== undefined && options.initialSize !== 0n) ||
          (options.owner !== undefined && (options.owner.uid !== undefined || options.owner.gid !== undefined)) ||
          (options.times !== undefined &&
            (options.times.access.kind === "value" || options.times.modification.kind === "value"))
        ) return yield* blocked("atomicOpenInitialMetadata")

        if (options.mode !== undefined && (options.create === undefined || options.create === "never")) {
          return yield* Errors.fsFailure("InvalidArgument", "open")
        }

        const address = yield* entry(runtime, value, caller)

        if (Predicate.isString(address) || Path.isBytePath(address)) {
          return yield* Errors.fsFailure("InvalidArgument", "open")
        }

        const prior = yield* mapped(caller.observeEntry(address))

        const located = options.followFinalSymlink === false
          ? { caller, target: address }
          : yield* followedEntry(address, caller, boundariesOf(runtime, value))

        const parent = yield* parentEntry(located.target, located.caller)
        const before = token(runtime, parent).number
        const child = yield* Effect.result(mapped(located.caller.linkStat(located.target)))

        if (Result.isFailure(child) && child.failure.code !== "NotFound") return yield* child.failure
        const present = Result.isSuccess(child) ? child.success : undefined

        if (present?.kind === "directory") return yield* Errors.fsFailure("IsDirectory", "open")

        if (options.expected !== undefined) {
          const expected = options.expected === null ? undefined : yield* reference(runtime, options.expected)

          if (
            expected === undefined
              ? prior.state === "present"
              : prior.state === "absent" || !P.equalsObjectReference(expected, prior.object.reference)
          ) return yield* Errors.fsFailure("VolumeBusy", "open")
        }

        if (options.expectedChild !== undefined) {
          const expected = options.expectedChild

          if (expected === null) {
            if (present !== undefined) return yield* Errors.fsFailure("StaleReference", "open")
          } else {
            const r = yield* reference(runtime, expected.reference)

            if (present === undefined || !P.equalsObjectReference(r, present.reference)) {
              return yield* Errors.fsFailure("StaleReference", "open")
            }

            const info = metadata(runtime, present)

            if (
              info.revision !== expected.revision || info.atimeNs !== expected.atimeNs ||
              info.mtimeNs !== expected.mtimeNs
            ) return yield* Errors.fsFailure("StaleReference", "open")
          }
        }

        const conditions: P.DestinationConditions = {
          entry: prior.state === "present" ? { expected: "binding", binding: prior.binding } : { expected: "absent" }
        }

        if (present === undefined && options.create !== undefined && options.create !== "never") {
          yield* allocation(runtime)
        }

        const opening = options.exactMode ? yield* mapped(withMask(caller, address, 0)) : caller

        const handle = yield* mapped(
          opening.open(address, {
            ...openOptions(options),
            conditions,
            noFollow: options.followFinalSymlink === false,
            expectedRevision: options.expectedChild == null ? undefined : present?.revision
          })
        )

        const after = yield* mapped(caller.stat(parent.reference))

        if (!P.equalsObjectRevision(parent.revision, after.revision)) runtime.revision++
        const observation = yield* mapped(handle.stat())

        if (present === undefined) {
          const name = Predicate.isString(located.target) || Path.isBytePath(located.target)
            ? located.target :
            located.target.name

          const raw = Predicate.isString(name) ? new TextEncoder().encode(name) : Path.toBytes(name)
          remember(runtime, after, Result.getOrThrow(Path.fromBytes(raw.subarray(raw.lastIndexOf(47) + 1))))
        }

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
            options.access,
            yield* forkBoundaries(caller, [...inherited, ...boundariesOf(runtime, value)])
          ),
          reference: token(runtime, observation).core,
          created: present === undefined,
          directory: change(before, token(runtime, after).number)
        }
      }

      const options = yield* Effect.fromResult(Errors.decodeConfiguration(OpenSchema, o, "open"))

      if (options.mode !== undefined && (options.create === undefined || options.create === "never")) {
        return yield* Errors.fsFailure("InvalidArgument", "open", { field: "mode" })
      }

      const original = Target.of(value)

      if (Predicate.isTagged(original, "Path") && options.create !== undefined && options.create !== "never") {
        const bytes = yield* Effect.fromResult(Paths.inputBytes(original.path)).pipe(
          Effect.mapError((code) => Errors.fsFailure(code, "open"))
        )

        if (bytes.length > 0 && bytes[bytes.length - 1] === 47) return yield* Errors.fsFailure("IsDirectory", "open")
      }

      const existing = yield* Effect.result(stat(runtime, caller, value))

      if (Result.isFailure(existing) && existing.failure.code !== "NotFound") return yield* existing.failure

      if (Result.isSuccess(existing) && existing.success.metadata.nlink === 0n) {
        return yield* Errors.fsFailure("StaleReference", "open")
      }

      if (Result.isSuccess(existing) && existing.success.kind === "directory") {
        return yield* Errors.fsFailure("IsDirectory", "open")
      }

      const located = yield* addressed(runtime, caller, value)
      const t = located.target
      const actor = located.caller
      const selected = { ...openOptions(options), noFollow: !follow(value) }

      if (
        !Predicate.isString(t) && !Path.isBytePath(t) && !("directory" in t) && options.create !== undefined &&
        options.create !== "never"
      ) return yield* Errors.fsFailure("InvalidArgument", "open", { field: "create" })

      if (Result.isFailure(existing) && options.create !== undefined && options.create !== "never") {
        yield* allocation(runtime)
      }

      const handle = yield* mapped(
        Predicate.isString(t) || Path.isBytePath(t)
          ? actor.open(t, selected)
          : "directory" in t
          ? actor.open(t, selected)
          : actor.open(t, { access: selected.access, append: selected.append, truncate: selected.truncate })
      )

      if (Result.isFailure(existing) || options.truncate) runtime.revision++

      if (Result.isFailure(existing) && (Predicate.isString(t) || Path.isBytePath(t) || "directory" in t)) {
        const parent = yield* parentEntry(t, actor)
        const name = Predicate.isString(t) || Path.isBytePath(t) ? t : t.name
        const raw = Predicate.isString(name) ? new TextEncoder().encode(name) : Path.toBytes(name)
        remember(runtime, parent, Result.getOrThrow(Path.fromBytes(raw.subarray(raw.lastIndexOf(47) + 1))))
        token(runtime, parent)
      }

      const positioned = options.append && options.access !== "read"
        ? yield* mapped(actor.open((yield* mapped(handle.stat())).reference, { access: selected.access }))
        : handle

      return wrapFile(
        runtime,
        handle,
        positioned,
        options.append,
        options.access,
        yield* forkBoundaries(caller, [...inherited, ...boundariesOf(runtime, value)])
      )
    })
  }

  const fs: V.Caller = {
    [CallerId]: true,
    limits,
    root: mapped(caller.stat("/")).pipe(Effect.map((o) => token(runtime, o).core)),
    lookup: (value) =>
      Effect.scoped(Effect.gen(function*() {
        const located = yield* entryActor(runtime, caller, value)
        const object = yield* mapped(located.caller.linkStat(located.target))

        for (const boundary of boundariesOf(runtime, value)) yield* mapped(boundary.caller.stat(object.reference))

        return token(runtime, object).core
      })),
    parent: (value) =>
      Effect.scoped(Effect.gen(function*() {
        const object = yield* stat(runtime, caller, value)
        const r = object.reference
        const traversal = yield* mapped(caller.acquireTraversal({ base: r }))
        const selected = yield* mapped(traversal.select(traversal.base, Data.taggedEnum<P.TraversalProbe>().Parent()))

        if (Option.isNone(selected)) return yield* Errors.fsFailure("NotFound", "parent")

        return token(runtime, selected.value.object).core
      })),
    stat: (value) => stat(runtime, caller, value).pipe(Effect.map((o) => metadata(runtime, o))),
    readDirectory: (value) =>
      onTarget(value, (t, actor) => actor.readDirectoryEntries(t)).pipe(
        Effect.map((list) => ({
          revision: token(runtime, list.directory).number,
          value: ordered(runtime, list).map((e) => ({
            name: Path.toBytes(e.name),
            reference: token(runtime, e.object).core
          }))
        }))
      ),
    readFile: Effect.fnUntraced(function*(value: V.TargetInput) {
      const info = yield* stat(runtime, caller, value)

      if (info.kind !== "file") {
        return yield* Errors.fsFailure(info.kind === "directory" ? "IsDirectory" : "SymlinkLoop", "readFile")
      }

      const located = yield* addressed(runtime, caller, value)

      return yield* mapped(located.caller.readFile(located.target))
    }, Effect.scoped),
    readLink: Effect.fnUntraced(function*(value: V.TargetInput) {
      const targetValue = Target.of(value)

      const object = yield* stat(
        runtime,
        caller,
        Predicate.isTagged(targetValue, "Path") ? { ...targetValue, followFinalSymlink: false } : targetValue
      )

      if (object.kind !== "symlink") return yield* Errors.fsFailure("InvalidArgument", "readLink")
      const stored = runtime.links.get(object.metadata.objectNumber)

      if (stored !== undefined) return stored.slice()

      return yield* target(runtime, value).pipe(
        Effect.flatMap((entry) => mapped(caller.readLink(entry))),
        Effect.map(Path.toBytes)
      )
    }),
    realPath: Effect.fnUntraced(function*(value) {
      yield* stat(runtime, caller, value)
      const selected = Target.of(value)

      if (Predicate.isTagged(selected, "Path")) {
        const name = yield* path(selected.path)

        if (selected.relativeTo === undefined || (Path.isBytePath(name) && Path.toBytes(name)[0] === 47)) {
          return yield* oldPath(yield* mapped(caller.realPath(name)))
        }

        const directory = runtime.directories.get(selected.relativeTo)

        if (directory === undefined) {
          return yield* Errors.fsFailure(
            handleOwners.has(selected.relativeTo) ? "ForeignHandle" : "InvalidHandle",
            "realPath"
          )
        }

        return yield* Effect.scoped(Effect.gen(function*() {
          const base = yield* mapped(caller.withCurrentDirectory(directory))

          return yield* oldPath(yield* mapped(base.realPath(name)))
        }))
      }

      const observed = yield* stat(runtime, caller, value).pipe(
        Effect.mapError((error) =>
          Predicate.isTagged(error.cause, "AccessDenied") && Predicate.hasProperty(error.cause, "reason") &&
            error.cause.reason === "temporarilyInaccessibleReference"
            ? Errors.fsFailure("NotFound", "realPath")
            : error
        )
      )

      const root = yield* mapped(caller.stat("/"))
      const captured = yield* snapshot(runtime.owner)
      const state = yield* Image.valueOf(captured).pipe(Effect.orDie)

      const nodePath = State.pathOf(
        (ino) => State.getNode(state, ino),
        State.Ino(Number(observed.metadata.objectNumber))
      )

      const rootPath = State.pathOf((ino) => State.getNode(state, ino), State.Ino(Number(root.metadata.objectNumber)))

      if (nodePath === undefined || rootPath === undefined) return yield* Errors.fsFailure("NotFound", "realPath")

      const rebased = rootPath === Paths.SLASH_HEX
        ? nodePath
        : nodePath === rootPath
        ? Paths.SLASH_HEX
        : nodePath.slice(rootPath.length)

      return Paths.ownedPath(Paths.nameBytes(rebased))
    }),
    access: Effect.fnUntraced(function*(value: V.TargetInput, bits = 0) {
      const observed = yield* stat(runtime, caller, value)
      let granted = 0

      for (const bit of [4, 2, 1]) {
        if (
          (bits & bit) === 0 || (bit === 1 && observed.kind === "file" && (observed.metadata.mode & 0o111) === 0)
        ) continue

        const result = yield* Effect.result(
          onTarget(value, (t, actor) => actor.access(t, { read: bit === 4, write: bit === 2, execute: bit === 1 }))
        )

        if (Result.isSuccess(result)) granted |= bit
        else if (
          !(Predicate.isTagged(result.failure.cause, "AccessDenied") &&
            Predicate.hasProperty(result.failure.cause, "reason") && result.failure.cause.reason === "permission")
        ) return yield* result.failure
      }

      return granted
    }),
    writeFile: dual(
      3,
      (value: V.EntryInput, data: Uint8Array, o: V.WriteFileOptions) =>
        Effect.scoped(Effect.gen(function*() {
          o = yield* Effect.fromResult(Errors.decodeConfiguration(WriteSchema, o, "writeFile"))

          const located = yield* entryActor(runtime, caller, value)
          const t = located.target
          const actor = located.caller
          const literal = yield* Effect.result(mapped(actor.linkStat(t)))

          if (
            o.replaceFinalSymlink && Result.isSuccess(literal) && literal.success.kind === "symlink"
          ) return yield* blocked("atomicFinalSymlinkReplacement")

          const present = yield* Effect.result(
            mapped(o.followFinalSymlink === false ? actor.linkStat(t) : actor.stat(t))
          )

          if (Result.isSuccess(present)) {
            if (present.success.kind === "directory") return yield* Errors.fsFailure("IsDirectory", "writeFile")

            if (present.success.kind === "symlink") return yield* Errors.fsFailure("SymlinkLoop", "writeFile")
          }

          if (o.access === "read") {
            if (Result.isFailure(present)) return yield* present.failure

            return yield* Errors.fsFailure("InvalidHandle", "writeFile")
          }

          if (o.finalMode !== undefined && Result.isSuccess(present)) {
            if (
              identity !== undefined && !identity.privileged && identity.uid !== present.success.metadata.uid
            ) return yield* Errors.fsFailure("NotPermitted", "writeFile")

            if (present.success.metadata.mode !== o.finalMode) return yield* blocked("atomicFinalMode")
          }

          if (Result.isFailure(present) && o.create !== "never" && o.create !== undefined) yield* allocation(runtime)

          const options: P.WriteFileOptions = {
            access: o.access === "readWrite" ? "readwrite" : "write",
            create: o.create === "ifMissing" ? "ifmissing" : o.create === "exclusive" ? "exclusive" : "existing",
            mode: o.finalMode ?? o.mode,
            placement: o.append ? "append" : o.truncate ? "replace" : "start"
          }

          const made = yield* namespace(value, (t, actor) =>
            Effect.gen(function*() {
              if (o.followFinalSymlink !== false) yield* followedEntry(t, actor, boundariesOf(runtime, value))

              const selected = o.finalMode !== undefined && Result.isFailure(present)
                ? yield* withMask(actor, t, 0)
                : actor

              if (Predicate.isString(t) || Path.isBytePath(t)) yield* selected.writeFile(t, data, options)
              else yield* selected.writeFile(t, data, options)

              return yield* selected.stat(t)
            }))

          return token(runtime, made.result).core
        }))
    ),
    open: openCore,
    openDirectory: Effect.fnUntraced(function*(value: V.TargetInput) {
      yield* liveScope
      const observed = yield* stat(runtime, caller, value)

      if (observed.kind !== "directory") return yield* Errors.fsFailure("NotDirectory", "openDirectory")
      const located = yield* addressed(runtime, caller, value)
      const handle = yield* mapped(located.caller.openDirectory(located.target))

      return wrapDirectory(
        runtime,
        handle,
        yield* forkBoundaries(caller, [...inherited, ...boundariesOf(runtime, value)])
      )
    }),
    mkdir: Effect.fnUntraced(function*(value, o) {
      o = yield* Effect.fromResult(Errors.decodeConfiguration(MkdirOptions, o === undefined ? {} : o, "mkdir"))

      if (o?.exactMode && o.mode === undefined) return yield* Errors.fsFailure("InvalidArgument", "mkdir")

      if (o?.times !== undefined && (o.times.access.kind === "value" || o.times.modification.kind === "value")) {
        return yield* blocked("atomicDirectoryMetadata")
      }

      const destination = yield* entry(runtime, value, caller)
      const present = yield* Effect.result(mapped(caller.stat(destination)))

      if (Result.isSuccess(present)) {
        if (!o?.recursive || present.success.kind !== "directory") {
          return yield* Errors.fsFailure("AlreadyExists", "mkdir")
        }

        const parent = yield* parentEntry(destination)
        const revision = token(runtime, parent).number

        return created(present.success, change(revision, revision))
      }

      if (o?.recursive && Result.isFailure(present) && present.failure.code === "NotFound") {
        const literal = yield* Effect.result(mapped(caller.linkStat(destination)))

        if (Result.isSuccess(literal) && literal.success.kind === "symlink") return yield* present.failure
      }

      yield* allocation(runtime)

      const made = yield* namespace(
        value,
        (t, actor) =>
          Effect.gen(function*() {
            const selected = o?.exactMode ? yield* withMask(actor, t, 0) : actor

            return yield* selected.makeDirectory(t, { mode: o?.mode, recursive: o?.recursive })
          }),
        o?.recursive
      )

      return created(made.result, made.directory)
    }),
    symlink: Effect.fnUntraced(function*(linkTarget, value, o) {
      o = yield* decode(SymlinkOptions, o === undefined ? {} : o, "symlink")
      const p = yield* path(linkTarget).pipe(Effect.mapError(noPath))
      const selected = o?.times

      const initialTime = (value: Times["access"]) =>
        nano(value.kind === "value" ? value.nanoseconds : runtime.readClock())

      const preserved = selected === undefined
        ? undefined
        : { atime: initialTime(selected.access), mtime: initialTime(selected.modification) }

      const address = yield* entry(runtime, value, caller)
      const occupied = yield* Effect.result(mapped(caller.stat(address)))

      if (Result.isSuccess(occupied)) return yield* Errors.fsFailure("AlreadyExists", "symlink")

      yield* allocation(runtime)

      const made = yield* namespace(value, (t, actor) =>
        preserved === undefined
          ? actor.makeSymlink(t, p)
          : actor.publishCopiedSymlink(
            t,
            Predicate.isString(p) ? Result.getOrThrow(Path.fromBytes(new TextEncoder().encode(p))) : p,
            { preserveTimes: preserved }
          ).pipe(Effect.andThen(actor.linkStat(t))))

      runtime.links.set(
        made.result.metadata.objectNumber,
        Predicate.isString(p) ? new TextEncoder().encode(p) : Path.toBytes(p)
      )

      return created(made.result, made.directory)
    }),
    link: dual(2, (source: V.TargetInput, value: V.EntryInput) =>
      Effect.gen(function*() {
        const selected = Target.of(source)

        const object = yield* stat(
          runtime,
          caller,
          Predicate.isTagged(selected, "Path")
            ? { ...selected, followFinalSymlink: false }
            : selected
        )

        if (object.kind === "directory") return yield* Errors.fsFailure("IsDirectory", "link")
        const address = yield* entry(runtime, value, caller)
        const occupied = yield* Effect.result(mapped(caller.stat(address)))

        if (Result.isSuccess(occupied)) {
          const located = errorPath(value)

          return yield* noPath(
            Errors.fsFailure("AlreadyExists", "link", located === undefined ? undefined : { path: located })
          )
        }

        if (object.metadata.nlink === 0n) return yield* Errors.fsFailure("StaleReference", "link")

        const made = yield* namespace(value, (t, actor) => actor.makeHardLink({ reference: object.reference }, t)).pipe(
          Effect.mapError((error) => noPath(contextual(error, "link", value)))
        )

        return created(made.result, made.directory)
      })),
    unlink: Effect.fnUntraced(function*(value: V.EntryInput) {
      const t = yield* entry(runtime, value, caller)

      if ((yield* mapped(caller.linkStat(t))).kind === "directory") {
        return yield* Errors.fsFailure("IsDirectory", "unlink")
      }

      return (yield* namespace(
        value,
        (t, actor) => actor.unlink(t),
        false,
        true
      )).directory
    }),
    rmdir: Effect.fnUntraced(function*(value: V.EntryInput) {
      yield* protectRoot(value, "rmdir")
      yield* mapped(caller.linkStat(yield* entry(runtime, value, caller)))

      return (yield* namespace(value, (t, actor) => actor.removeDirectory(t), false, true)).directory
    }),
    remove: removeCore,
    rename: dual(2, (from: V.EntryInput, to: V.EntryInput) =>
      Effect.gen(function*() {
        if (!isEntry(from)) {
          const raw = Target.of(from)

          if (Predicate.isTagged(raw, "Path")) yield* path(raw.path)
        }

        if (!isEntry(to)) {
          const raw = Target.of(to)

          if (Predicate.isTagged(raw, "Path")) {
            yield* path(raw.path).pipe(Effect.mapError((error) => noPath(contextual(error, "rename", to))))
          }
        }

        yield* protectRoot(from, "rename")
        yield* protectRoot(to, "rename")
        const source = yield* entry(runtime, from, caller)
        const sourceParent = yield* parentEntry(source)

        const destination = yield* entry(runtime, to, caller).pipe(
          Effect.mapError((error) => noPath(contextual(error, "rename", to)))
        )

        const destinationParent = yield* parentEntry(destination).pipe(
          Effect.mapError((error) => noPath(contextual(error, "rename", to)))
        )

        const sourceBefore = token(runtime, sourceParent).number
        const destinationBefore = token(runtime, destinationParent).number

        const reserved = (value: V.EntryInput) => {
          if (isEntry(value)) return false
          const path = Target.of(value)

          if (!Predicate.isTagged(path, "Path")) return false
          const raw = Result.getOrThrow(Paths.inputBytes(path.path))
          const trimmed = new TextDecoder().decode(raw).replace(/\/+$/, "")

          return trimmed === "" || trimmed === "." || trimmed === ".." || trimmed.endsWith("/.") ||
            trimmed.endsWith("/..")
        }

        if (reserved(from) || reserved(to)) return yield* Errors.fsFailure("InvalidArgument", "rename")
        const fromObject = yield* mapped(caller.linkStat(source))

        const destinationName = Predicate.isString(destination) || Path.isBytePath(destination)
          ? destination :
          destination.name

        const destinationBytes = Predicate.isString(destinationName)
          ? new TextEncoder().encode(destinationName) :
          Path.toBytes(destinationName)

        if (destinationBytes[destinationBytes.length - 1] === 47 && fromObject.kind !== "directory") {
          return yield* noPath(contextual(Errors.fsFailure("NotDirectory", "rename"), "rename", to))
        }

        const toObject = yield* Effect.result(mapped(caller.linkStat(destination)))

        if (Result.isSuccess(toObject)) {
          if (P.equalsObjectReference(fromObject.reference, toObject.success.reference)) {
            const sourceChange = change(sourceBefore, sourceBefore)
            const destinationChange = change(destinationBefore, destinationBefore)

            return P.equalsObjectReference(sourceParent.reference, destinationParent.reference)
              ? Data.taggedEnum<V.RenameReferenceResult>().SameDirectory({ directory: sourceChange })
              : Data.taggedEnum<V.RenameReferenceResult>().DifferentDirectories({
                sourceDirectory: sourceChange,
                destinationDirectory: destinationChange
              })
          }

          if (fromObject.kind !== "directory" && toObject.success.kind === "directory") {
            return yield* noPath(contextual(Errors.fsFailure("IsDirectory", "rename"), "rename", to))
          }

          if (fromObject.kind === "directory" && toObject.success.kind !== "directory") {
            return yield* noPath(contextual(Errors.fsFailure("NotDirectory", "rename"), "rename", to))
          }
        }

        if (fromObject.kind === "directory") {
          const cycle = yield* Effect.scoped(Effect.gen(function*() {
            const traversal = yield* mapped(caller.acquireTraversal({ base: destinationParent.reference }))
            let directory = traversal.base
            let prior = destinationParent.reference

            for (;;) {
              if (P.equalsObjectReference(prior, fromObject.reference)) return true
              const next = yield* mapped(traversal.select(directory, Data.taggedEnum<P.TraversalProbe>().Parent()))

              if (Option.isNone(next) || P.equalsObjectReference(next.value.object.reference, prior)) return false
              const classified = yield* mapped(traversal.classify(next.value))

              if (classified.kind !== "directory") return false
              directory = classified.directory
              prior = next.value.object.reference
            }
          }))

          if (cycle) return yield* noPath(contextual(Errors.fsFailure("InvalidArgument", "rename"), "rename", to))
        }

        yield* refreshGrants(runtime)
        yield* mapped(caller.rename(source, destination)).pipe(
          Effect.mapError((error) =>
            noPath(
              error.code === "NotEmpty"
                ? contextual(error, "rename", to) :
                contextual(error, "rename", from, to)
            )
          )
        )
        const sourceAfter = yield* mapped(caller.stat(sourceParent.reference))
        const destinationAfter = yield* mapped(caller.stat(destinationParent.reference))

        if (
          !P.equalsObjectRevision(sourceParent.revision, sourceAfter.revision) ||
          !P.equalsObjectRevision(destinationParent.revision, destinationAfter.revision)
        ) runtime.revision++

        const finalName = (entry: P.EntryTarget) => {
          const name = Predicate.isString(entry) || Path.isBytePath(entry) ? entry : entry.name
          const raw = Predicate.isString(name) ? new TextEncoder().encode(name) : Path.toBytes(name)
          let end = raw.length

          while (end > 1 && raw[end - 1] === 47) end--
          const trimmed = raw.subarray(0, end)

          return Result.getOrThrow(Path.fromBytes(trimmed.subarray(trimmed.lastIndexOf(47) + 1)))
        }

        remember(runtime, sourceAfter, finalName(source), true)
        remember(runtime, destinationAfter, finalName(destination))
        const sourceChange = change(sourceBefore, token(runtime, sourceAfter).number)
        const destinationChange = change(destinationBefore, token(runtime, destinationAfter).number)

        return P.equalsObjectReference(sourceParent.reference, destinationParent.reference)
          ? Data.taggedEnum<V.RenameReferenceResult>().SameDirectory({ directory: sourceChange })
          : Data.taggedEnum<V.RenameReferenceResult>().DifferentDirectories({
            sourceDirectory: sourceChange,
            destinationDirectory: destinationChange
          })
      })),
    chmod: dual(
      2,
      Effect.fnUntraced(function*(value: V.TargetInput, mode: number) {
        yield* decode(Mode, mode, "chmod")

        return yield* attributes(value, { mode })
      })
    ),
    chown: dual(
      2,
      Effect.fnUntraced(function*(value: V.TargetInput, owner: V.OwnerUpdate) {
        return yield* attributes(value, yield* decode(OwnerUpdate, owner, "chown"))
      })
    ),
    utimes: dual(
      2,
      Effect.fnUntraced(function*(value: V.TargetInput, t: Times) {
        t = yield* decode(TimesSchema, t, "utimes")
        yield* validateCurrentTimes(value, t)

        return yield* attributes(value, times(t))
      })
    ),
    truncate: dual(2, (value: V.TargetInput, size: bigint) =>
      Effect.gen(function*() {
        if (!Predicate.isBigInt(size) || size < 0n || size > 0x7fffffffffffffffn) {
          return yield* noPath(Errors.fsFailure("InvalidArgument", "truncate"))
        }

        const observed = yield* stat(runtime, caller, value)

        if (observed.kind !== "file") {
          return yield* Errors.fsFailure(observed.kind === "directory" ? "IsDirectory" : "SymlinkLoop", "truncate")
        }

        return yield* mutateTarget(value, (t, actor) => actor.truncate(t, size))
      })),
    setattr: dual(2, (value: V.TargetInput, a: V.SetattrOptions) =>
      Effect.gen(function*() {
        a = yield* decode(SetattrOptions, a, "setattr")
        const observed = yield* stat(runtime, caller, value)
        const prior = token(runtime, observed)

        if (a.size !== undefined && observed.kind !== "file") {
          return yield* Errors.fsFailure(observed.kind === "directory" ? "IsDirectory" : "SymlinkLoop", "setattr")
        }

        if (a.expected !== undefined && a.expected.revision !== prior.number) {
          return yield* Errors.fsFailure("StaleReference", "setattr", { field: "expected" })
        }

        if (a.size !== undefined) {
          if (a.mode !== undefined || a.owner !== undefined || a.times !== undefined) {
            return yield* blocked("atomicSetattrSizeAndMetadata")
          }

          const size = a.size
          yield* onTarget(value, (t, actor) => actor.access(t, { write: true }))

          if (size > limits.maxFileBytes) return yield* noPath(Errors.fsFailure("FileTooLarge", "setattr"))

          return yield* mutateTarget(value, (t, actor) =>
            actor.truncate(t, size, { expectedRevision: observed.revision }))
            .pipe(Effect.mapError((error) =>
              error.code === "NoSpace" || error.code === "FileTooLarge" ? noPath(error) : error
            ))
        }

        if (a.times !== undefined && a.mode === undefined && a.owner === undefined) {
          yield* validateCurrentTimes(value, a.times)
        }

        const selected: P.Attributes = { ...a.owner, mode: a.mode }

        return yield* attributes(
          value,
          a.times === undefined ? selected : { ...selected, ...times(a.times) },
          a.expected === undefined ? undefined : observed.revision
        )
      })),
    withRoot: (value) => derive(value, true),
    withDirectory: (value) => derive(value, false),
    watch: () => blocked("watch"),
    walk: (value, options) =>
      Stream.unwrap(
        Effect.as(alive, walkPreview(runtime, caller, value, options, [...inherited, ...boundariesOf(runtime, value)]))
      )
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
      ? execute(runtime, "open", value, Effect.andThen(alive, acquisition(fs.open(value, options))))
      : execute(runtime, "open", value, Effect.andThen(alive, acquisition(fs.open(value, options))))
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
    const operation = Effect.andThen(alive, options === undefined ? fs.remove(value) : fs.remove(value, options))

    return options?.recursive
      ? operation.pipe(Effect.mapError((error) => contextual(error, "remove", value)))
      : execute(runtime, "remove", value, operation)
  }

  const validateDirectory = Effect.fnUntraced(function*(value: V.TargetInput | V.EntryInput | undefined) {
    if (value === undefined || cwdIno === rootIno || isEntry(value)) return
    const selected = Target.of(value)

    if (!Predicate.isTagged(selected, "Path") || selected.relativeTo !== undefined) return

    const raw = yield* Effect.fromResult(Paths.inputBytes(selected.path)).pipe(
      Effect.mapError((code) => Errors.fsFailure(code, "path"))
    )

    if (raw[0] === 47) return
    const present = yield* Effect.result(mapped(caller.stat(".")))

    if (Result.isSuccess(present)) return
    const state = yield* Image.valueOf(yield* snapshot(runtime.owner)).pipe(Effect.orDie)

    if (State.getNode(state, State.Ino(Number(cwdIno))) === undefined) {
      return yield* Errors.fsFailure("NotFound", "path")
    }

    return yield* present.failure
  })

  const perform = <A, R>(
    operation: string,
    value: V.TargetInput | V.EntryInput | undefined,
    effect: Effect.Effect<A, V.FsFailure, R>,
    destination?: V.TargetInput | V.EntryInput
  ) =>
    execute(
      runtime,
      operation,
      value,
      Effect.andThen(alive, Effect.andThen(validateDirectory(value), effect)).pipe(Effect.mapError(callerFailure)),
      destination
    )

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
    openDirectory: (value) => perform("openDirectory", value, acquisition(fs.openDirectory(value))),
    withRoot: (value) => perform("withRoot", value, acquisition(fs.withRoot(value))),
    withDirectory: (value) => perform("withDirectory", value, acquisition(fs.withDirectory(value))),
    watch: (value, options) => perform("watch", value, fs.watch(value, options))
  }
}

const walkPreview = (
  runtime: Runtime,
  caller: P.VirtualFileSystem,
  value: V.TargetInput,
  options?: V.WalkOptions,
  boundaries: ReadonlyArray<Boundary> = []
): Stream.Stream<V.WalkEntry, V.WalkFailure> =>
  Stream.scoped(Stream.unwrap(Effect.gen(function*() {
    const checked = yield* Effect.fromResult(
      Errors.decodeConfiguration(WalkOptions, options === undefined ? {} : options, "walk")
    ).pipe(
      Effect.mapError(() => contextual(Errors.fsFailure("InvalidArgument", "walk"), "walk", value))
    )

    const initial = yield* stat(runtime, caller, value).pipe(
      Effect.mapError((error) => contextual(error, "walk", value))
    )

    if (initial.kind !== "directory") return yield* contextual(Errors.fsFailure("NotDirectory", "walk"), "walk", value)
    const selected = Target.of(value)
    let active = caller
    let base: P.Path

    if (Predicate.isTagged(selected, "Path") && selected.relativeTo === undefined) base = yield* path(selected.path)
    else {
      const directory = yield* mapped(caller.withCurrentDirectory(initial.reference))
      active = directory
      base = "."
    }

    const prefix = errorPath(value)

    const locate = (raw: Uint8Array) =>
      prefix === undefined ?
        Paths.ownedPath(raw)
        : Paths.ownedPath(Paths.joinPath(Result.getOrThrow(Paths.inputBytes(prefix)), raw))

    const baseBytes = Predicate.isString(base) ? new TextEncoder().encode(base) : Path.toBytes(base)
    const address = (raw: Uint8Array) => Result.getOrThrow(Path.fromBytes(Paths.joinPath(baseBytes, raw)))

    interface Frame {
      readonly entry: V.WalkEntry
      readonly reference: P.ObjectReference
      readonly bytes: bigint
      readonly raw: Uint8Array
      readonly listed: boolean
    }

    const shallow = (raw: Uint8Array, expected?: P.ObjectReference): Effect.Effect<Array<Frame>, V.FsFailure> =>
      execute(
        runtime,
        "walk",
        undefined,
        Effect.gen(function*() {
          yield* checkRoots(runtime, boundaries)

          for (const boundary of boundaries) yield* mapped(boundary.caller.stat(expected ?? initial.reference))
          const at = raw.length === 0 ? base : address(raw)

          if (expected !== undefined) {
            const current = yield* Effect.result(mapped(active.linkStat(at)))

            if (Result.isFailure(current)) {
              if (current.failure.code === "NotFound" || current.failure.code === "StaleReference") return []

              return yield* current.failure
            }

            if (
              !P.equalsObjectReference(current.success.reference, expected) || current.success.kind !== "directory"
            ) return []
          }

          const rows = yield* Stream.runCollect(active.walk(at, { maxDepth: 1 })).pipe(Effect.mapError(failure))
          const root = rows.find((record) => record.root)

          if (root === undefined) return []
          const directory = coreReference(runtime, root.object)

          return rows.flatMap((record): Array<Frame> => {
            if (record.root) return []
            const name = Path.toBytes(record.entry.name)
            const relative = Paths.joinPath(raw, name)

            return [{
              reference: record.object.reference,
              raw: relative,
              bytes: record.object.kind === "directory" ? 0n : record.object.metadata.size,
              listed: false,
              entry: {
                path: Paths.ownedPath(relative),
                name,
                reference: coreReference(runtime, record.object),
                directory,
                kind: record.object.kind,
                depth: relative.filter((byte) => byte === 47).length + 1
              }
            }]
          })
        }).pipe(Effect.mapError((error) => {
          const selected = raw.length === 0 ? prefix : locate(raw)

          return Errors.fsFailure(
            error.code,
            "walk",
            selected === undefined ? { cause: error.cause } : { cause: error.cause, path: selected }
          )
        }))
      )

    let pending: Array<Frame> | undefined
    let deferred: V.WalkFailure | undefined
    let entries = 0
    let bytes = 0n

    const step = Effect.gen(function*() {
      if (deferred !== undefined) return yield* deferred

      if (pending === undefined) pending = (yield* shallow(new Uint8Array())).reverse()
      const out: Array<V.WalkEntry> = []

      const stop = (error: V.WalkFailure) => {
        if (out.length === 0) return Effect.fail(error)
        deferred = error

        return Effect.succeed([out, Option.some(undefined)] as const)
      }

      while (out.length < 128) {
        const frame = pending.pop()

        if (frame === undefined) return [out, Option.none()] as const
        const unlisted = frame.entry.kind === "directory" && !frame.listed
        const field = checked.maxDepth !== undefined && frame.entry.depth > checked.maxDepth ? "maxDepth" : undefined

        if (field !== undefined) {
          return yield* stop(vfsError({ code: "LimitExceeded", operation: "walk", field, path: locate(frame.raw) }))
        }

        if (!unlisted || checked.order !== "post") {
          entries++
          bytes += frame.bytes

          const field = checked.maxEntries !== undefined && entries > checked.maxEntries ?
            "maxEntries"
            : checked.maxBytes !== undefined && bytes > checked.maxBytes
            ? "maxBytes"
            : undefined

          if (field !== undefined) {
            return yield* stop(vfsError({ code: "LimitExceeded", operation: "walk", field, path: locate(frame.raw) }))
          }

          out.push(frame.entry)
        }

        if (unlisted) {
          const listed = yield* Effect.result(shallow(frame.raw, frame.reference))

          if (Result.isFailure(listed)) return yield* stop(listed.failure)

          if (checked.order === "post") pending.push({ ...frame, listed: true })
          pending.push(...listed.success.reverse())

          return [out, Option.some(undefined)] as const
        }
      }

      return [out, Option.some(undefined)] as const
    })

    return Stream.paginate(undefined, () => step)
  })))

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

const sameRecord = (left: P.CaptureRecord, right: P.CaptureRecord): boolean => {
  if (Predicate.isTagged(left, "alias")) {
    return Predicate.isTagged(right, "alias") && left.parentId === right.parentId && left.targetId === right.targetId &&
      sameBytes(Path.toBytes(left.name), Path.toBytes(right.name))
  }

  if (Predicate.isTagged(right, "alias")) return false
  const a = left.metadata
  const b = right.metadata

  if (
    left.id !== right.id || a.objectNumber !== b.objectNumber || a.uid !== b.uid || a.gid !== b.gid ||
    a.mode !== b.mode || a.atime !== b.atime || a.mtime !== b.mtime || a.ctime !== b.ctime ||
    a.birthtime !== b.birthtime
  ) return false

  if (Predicate.isTagged(left, "root")) return Predicate.isTagged(right, "root")

  if (
    Predicate.isTagged(right, "root") || left.parentId !== right.parentId ||
    !sameBytes(Path.toBytes(left.name), Path.toBytes(right.name))
  ) return false

  if (Predicate.isTagged(left, "file")) return Predicate.isTagged(right, "file") && sameBytes(left.data, right.data)

  if (Predicate.isTagged(left, "symlink")) {
    return Predicate.isTagged(right, "symlink") && sameBytes(Path.toBytes(left.target), Path.toBytes(right.target))
  }

  return Predicate.isTagged(right, "directory")
}

const snapshots = new WeakMap<
  P.Owner,
  { readonly records: ReadonlyArray<P.CaptureRecord>; readonly snapshot: V.Snapshot; epoch: number | undefined }
>()

const snapshot = Effect.fnUntraced(function*(owner: P.Owner) {
  const prior = snapshots.get(owner)
  const epoch = ownerRuntimes.get(owner)?.snapshotEpoch

  // The owner stays private; core and native entry points invalidate before any possible state change.
  if (epoch !== undefined && prior?.epoch === epoch) return prior.snapshot
  const capture = yield* mapped(owner.capture())
  const input = yield* Stream.runCollect(capture.records()).pipe(Effect.mapError(failure))

  if (
    prior !== undefined && input.length === prior.records.length &&
    input.every((record, index) => prior.records[index] !== undefined && sameRecord(record, prior.records[index]))
  ) {
    prior.epoch = epoch

    return prior.snapshot
  }

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

  const snapshot = Image.make(assemble([...specs.values()]))
  snapshots.set(owner, { records: input, snapshot, epoch })

  return snapshot
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

    if (Predicate.isTagged(source, "Restored")) {
      const restored = yield* reachableValue(source.value)

      if (restored.largestFile > Number(ByteSize.toBigInt(limits.maxFileBytes))) {
        return yield* imageFailure("snapshot", "LimitExceeded", { field: "maxFileBytes" })
      }

      if (
        (limits.maxEntries !== undefined && restored.state.entries > limits.maxEntries) ||
        (limits.maxBytes !== undefined && restored.state.usedBytes > ByteSize.toBigInt(limits.maxBytes))
      ) {
        return yield* imageFailure("snapshot", "LimitExceeded", { field: "volume" })
      }
    }

    const configuration: P.LimitOptions = {
      synchronous: checked.options.execution === "sync",
      entries: limits.maxEntries ?? Number.MAX_SAFE_INTEGER,
      contentBytes: limits.maxBytes ?? ByteSize.bytes(Number.MAX_SAFE_INTEGER),
      fileBytes: limits.maxFileBytes,
      ioBytes: ByteSize.bytes(State.MAX_FILE_BYTES),
      pathBytes: ByteSize.bytes(Number.MAX_SAFE_INTEGER),
      expandedPathBytes: limits.maxPathBytes ?? ByteSize.bytes(Number.MAX_SAFE_INTEGER),
      namespaceVisits: Number.MAX_SAFE_INTEGER,
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

    const clock = yield* Clock.Clock
    const initialTime = clock.currentTimeNanosUnsafe()

    if (!Schema.is(Timestamp)(initialTime)) return yield* Errors.argumentFailure("make", "clock.currentTimeNanos")
    const time: Runtime["time"] = { active: true, value: initialTime }

    const readClock = () => {
      if (time.active && time.value !== undefined) return time.value
      const value = clock.currentTimeNanosUnsafe()

      if (!Schema.is(Timestamp)(value)) throw new InvalidClockSample()

      if (time.active) time.value = value

      return value
    }

    const previewClock: Clock.Clock = {
      currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
      currentTimeMillis: clock.currentTimeMillis,
      monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: clock.monotonicTimeNanos,
      sleep: (duration) => clock.sleep(duration),
      currentTimeNanosUnsafe: readClock,
      currentTimeNanos: Effect.sync(readClock)
    }

    const owner = yield* mapped((Predicate.isTagged(source, "Empty")
      ? P.make({ limits: configuration })
      : P.restore(Stream.fromIterable(records(source.value)), { limits: configuration })).pipe(
        Effect.provideService(Clock.Clock, previewClock)
      ))

    time.active = false
    time.value = undefined

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
      highestObjectNumber: Predicate.isTagged(source, "Restored") ? BigInt(source.value.nextInode) - 1n : 1n,
      snapshotEpoch: 0,
      busy: false,
      gate: Semaphore.makeUnsafe(1),
      orders: new Map(),
      retained: [],
      time,
      readClock,
      links: new Map(),
      grants: new WeakMap(),
      activeGrants: [],
      pending: []
    }

    ownerRuntimes.set(owner, runtime)

    if (Predicate.isTagged(source, "Restored")) {
      for (const [, node] of source.value.inodes) {
        if (node.kind === "symlink") runtime.links.set(BigInt(node.ino), node.target.slice())

        if (node.kind === "directory") runtime.orders.set(BigInt(node.ino), [...node.entries.keys()].sort())
      }
    }

    const random = yield* SecureRandom.SecureRandom
    const identity = checked.identity ?? VolumeIdentity.make(Hex.encode(yield* random.randomBytes(16)))
    const incarnation = VolumeIncarnation.make(Hex.encode(yield* random.randomBytes(16)))
    const identityBytes = Result.getOrThrow(Hex.decode(identity))
    const epochBytes = yield* random.randomBytes(16)
    const secret = yield* random.randomBytes(16)

    const keyTag = (ino: bigint) => {
      const message = new Uint8Array(40)
      message.set(identityBytes)
      message.set(epochBytes, 16)
      new DataView(message.buffer).setBigUint64(32, ino)

      return hmacSha256(secret, message).subarray(0, 16)
    }

    const keyCaller = yield* mapped(
      Scope.provide(owner.authorize({ credentials: { uid: 0, gid: 0, privileged: true } }), rootScope)
    )

    const keyObservation = Effect.fnUntraced(function*(selected: P.ObjectReference) {
      const observed = yield* Effect.result(mapped(keyCaller.stat(selected)))

      if (Result.isSuccess(observed)) return observed.success

      if (
        !(Predicate.isTagged(observed.failure.cause, "AccessDenied") &&
          Predicate.hasProperty(observed.failure.cause, "reason") &&
          observed.failure.cause.reason === "temporarilyInaccessibleReference")
      ) return yield* observed.failure

      for (const retained of runtime.retained) {
        const handle = retained.deref()

        if (handle === undefined) continue
        const object = yield* Effect.result(mapped(handle.stat()))

        if (Result.isSuccess(object) && P.equalsObjectReference(object.success.reference, selected)) {
          return object.success
        }
      }

      return yield* Errors.fsFailure("StaleReference", "referenceKey")
    })

    const volume: V.Volume = {
      [VolumeId]: true,
      durability: "memory-only",
      identity,
      incarnation,
      limits,
      usage: owner.usage.pipe(Effect.map((u) => ({ entries: u.entries, usedBytes: u.contentBytes }))),
      snapshot: snapshot(owner),
      caller: Effect.fnUntraced(function*(o) {
        const chosen = yield* Effect.fromResult(
          Errors.decodeConfiguration(RootCallerOptions, o === undefined ? {} : o, "caller")
        )

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

        return wrapCaller(runtime, caller, limits, [], 1n, chosen.identity)
      }),
      watch: () => blocked("watch"),
      referenceKey: Effect.fnUntraced(function*(value) {
        const selected = yield* reference(runtime, value)
        const observed = yield* keyObservation(selected)
        const ino = observed.metadata.objectNumber

        return { identity: identityBytes.slice(), epoch: epochBytes.slice(), ino, tag: keyTag(ino) }
      }),
      resolveReferenceKey: Effect.fnUntraced(function*(key) {
        if (!Schema.is(ReferenceKey)(key)) return yield* Errors.fsFailure("InvalidReference", "resolveReferenceKey")

        if (!sameBytes(key.identity, identityBytes) || !sameBytes(key.epoch, epochBytes)) {
          return yield* Errors.fsFailure("ForeignReference", "resolveReferenceKey")
        }

        if (!sameTag(key.tag, keyTag(key.ino))) {
          return yield* Errors.fsFailure("InvalidReference", "resolveReferenceKey")
        }

        const selected = runtime.tokens.find((token) => token.ino === key.ino)

        if (selected === undefined) return yield* Errors.fsFailure("StaleReference", "resolveReferenceKey")
        yield* keyObservation(selected.reference)

        return selected.core
      })
    }

    runtimes.set(volume, runtime)
    const changes: Effect.Effect<Array<ObservationEntry>> = blocked("overlay")
    const capture: Effect.Effect<{ snapshot: V.Snapshot; observation: Array<ObservationEntry> }> = blocked("overlay")

    return { volume, shutdown: Effect.void, observe: { changes, capture } }
  }
)
