import type { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as ByteSize from "effect/ByteSize"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Result from "effect/Result"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"

const HANDLE_VERSION = 1

const HANDLE_BYTES = 25

/** @internal */
export interface ExportLimits {
  readonly maxFilehandles: number
  readonly maxNameBytes: ByteSize.ByteSize
}

/** @internal */
export interface OpenedFile {
  readonly handle: Vfs.FileHandle
  readonly close: Effect.Effect<void>
}

/** @internal */
export interface NfsExport {
  readonly capacity: Pick<Vfs.Volume, "limits" | "usage"> | undefined
  /** Selects a caller for one compound while retaining the export's filehandle registry. */
  readonly withCaller: (caller: Vfs.Caller) => NfsExport
  readonly root: Effect.Effect<Vfs.ObjectReference, Vfs.VfsError>
  readonly handleFor: (reference: Vfs.ObjectReference) => Effect.Effect<Uint8Array, ExportCapacityError>
  readonly resolve: (handle: Uint8Array) => Effect.Effect<Vfs.ObjectReference, InvalidFilehandleError>
  readonly observeMetadata: (
    reference: Vfs.ObjectReference
  ) => Effect.Effect<Vfs.ObjectObservation<Vfs.Metadata>, Vfs.VfsError>
  readonly observeDirectory: (
    reference: Vfs.ObjectReference
  ) => Effect.Effect<Vfs.ObjectObservation<ReadonlyArray<Vfs.DirectoryEntry>>, Vfs.VfsError>
  readonly lookup: (
    directory: Vfs.ObjectReference,
    name: Uint8Array
  ) => Effect.Effect<Vfs.ObjectReference, Vfs.VfsError | InvalidNameError>
  readonly parent: (directory: Vfs.ObjectReference) => Effect.Effect<Vfs.ObjectReference, Vfs.VfsError>
  readonly readLink: (reference: Vfs.ObjectReference) => Effect.Effect<Uint8Array, Vfs.VfsError>
  readonly mkdir: (
    directory: Vfs.ObjectReference,
    name: Uint8Array,
    settings?: Vfs.MkdirReferenceSettings
  ) => Effect.Effect<Vfs.ReferenceEntryResult, Vfs.VfsError | InvalidNameError | ExportCapacityError>
  readonly symlink: (
    target: Vfs.PathInput,
    directory: Vfs.ObjectReference,
    name: Uint8Array,
    settings?: Vfs.SymlinkReferenceSettings
  ) => Effect.Effect<Vfs.ReferenceEntryResult, Vfs.VfsError | InvalidNameError | ExportCapacityError>
  readonly link: Vfs.Caller["linkReference"]
  readonly remove: Vfs.Caller["removeReference"]
  readonly rename: Vfs.Caller["renameReference"]
  readonly chmod: Vfs.Caller["chmodReference"]
  readonly chown: Vfs.Caller["chownReference"]
  readonly utimes: Vfs.Caller["utimesReference"]
  readonly truncate: Vfs.Caller["truncateReference"]
  readonly open: (
    reference: Vfs.ObjectReference,
    access?: Vfs.OpenReferenceSettings["access"]
  ) => Effect.Effect<OpenedFile, Vfs.VfsError>
  readonly openChild: (
    directory: Vfs.ObjectReference,
    name: Uint8Array,
    settings: Vfs.OpenChildReferenceSettings
  ) => Effect.Effect<
    Vfs.OpenChildReferenceResult & { readonly close: Effect.Effect<void> },
    Vfs.VfsError | InvalidNameError | ExportCapacityError
  >
  readonly fsid: readonly [bigint, bigint]
}

/** @internal */
export class ExportCapacityError extends Data.TaggedError("ExportCapacityError")<{ readonly detail: string }> {
  constructor(message: string) {
    super({ detail: message })
  }
}

/** @internal */
export class InvalidFilehandleError extends Data.TaggedError("InvalidFilehandleError")<{
  readonly reason: "Malformed" | "WrongGeneration" | "Stale" | "Unknown" | "Unavailable"
}> {
  constructor(reason: "Malformed" | "WrongGeneration" | "Stale" | "Unknown" | "Unavailable") {
    super({ reason })
  }
}

/** @internal */
export type InvalidNameReason = "Empty" | "TooLong" | "ForbiddenByte" | "Encoding" | "Reserved"

/** @internal */
export class InvalidNameError extends Data.TaggedError("InvalidNameError")<{
  readonly detail: string
  readonly reason: InvalidNameReason
}> {
  constructor(message: string, reason: InvalidNameReason) {
    super({ detail: message, reason })
  }
}

const assertPositiveInteger = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`)
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false
  let difference = 0

  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!

  return difference === 0
}

const validateGeneration = (generation: Uint8Array): void => {
  if (generation.length !== 16) throw new RangeError("generation must contain exactly 16 bytes")
}

const decodeUtf8 = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new InvalidNameError("Name is not valid UTF-8", "Encoding")
  }
}

/** @internal */
export const validateName = (bytes: Uint8Array, maxNameBytes: ByteSize.ByteSize): string => {
  if (bytes.length === 0) throw new InvalidNameError("Name is empty", "Empty")

  if (BigInt(bytes.length) > maxNameBytes) throw new InvalidNameError("Name is too long", "TooLong")

  if (bytes.includes(0) || bytes.includes(0x2f)) {
    throw new InvalidNameError("Name contains a forbidden byte", "ForbiddenByte")
  }

  const decoded = decodeUtf8(bytes)

  if (decoded === "." || decoded === "..") {
    throw new InvalidNameError("Reserved path components are not names", "Reserved")
  }

  // A fatal decode plus byte-for-byte re-encoding prevents replacement or normalization.
  if (!sameBytes(bytes, new TextEncoder().encode(decoded))) {
    throw new InvalidNameError("Name cannot be represented exactly", "Encoding")
  }

  return decoded
}

const uint64From = (bytes: Uint8Array, offset: number): bigint =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset)

/** @internal */
export const makeExport = (
  caller: Vfs.Caller,
  generation: Uint8Array,
  limits: ExportLimits,
  identity: Uint8Array = generation,
  capacity?: Pick<Vfs.Volume, "limits" | "usage">
): NfsExport => {
  validateGeneration(generation)
  validateGeneration(identity)
  assertPositiveInteger("maxFilehandles", limits.maxFilehandles)
  assertPositiveInteger("maxNameBytes", ByteSize.toNumberUnsafe(limits.maxNameBytes))

  const generationCopy = new Uint8Array(generation)
  const identityCopy = new Uint8Array(identity)
  const referencesById = new Map<bigint, Vfs.ObjectReference>()
  const idsByReference = new WeakMap<object, bigint>()
  const registryGate = Semaphore.makeUnsafe(1)
  let nextId = 1n

  const admitHandle = Effect.gen(function*() {
    if (referencesById.size >= limits.maxFilehandles) {
      for (const [candidateId, candidate] of referencesById) {
        const result = yield* Effect.result(caller.observeMetadata(candidate))

        if (Result.isFailure(result) && result.failure.code === "StaleReference") {
          referencesById.delete(candidateId)
          // SAFETY: ObjectReference values are opaque object identities created by the core volume.
          idsByReference.delete(candidate)
        }
      }

      if (referencesById.size >= limits.maxFilehandles) {
        return yield* new ExportCapacityError("Filehandle registry is full")
      }
    }
  })

  const registerHandle = (reference: Vfs.ObjectReference): Uint8Array => {
    // SAFETY: ObjectReference values are opaque object identities created by the core volume.
    let id = idsByReference.get(reference)

    if (id === undefined) {
      id = nextId++
      // SAFETY: ObjectReference values are opaque object identities created by the core volume.
      idsByReference.set(reference, id)
      referencesById.set(id, reference)
    }

    const bytes = new Uint8Array(HANDLE_BYTES)
    bytes[0] = HANDLE_VERSION
    bytes.set(generationCopy, 1)
    new DataView(bytes.buffer).setBigUint64(17, id)

    return bytes
  }

  const handleFor = (reference: Vfs.ObjectReference): Effect.Effect<Uint8Array, ExportCapacityError> =>
    registryGate.withPermit(Effect.gen(function*() {
      if (!idsByReference.has(reference)) yield* admitHandle

      return registerHandle(reference)
    }))

  const resolve = (handle: Uint8Array): Effect.Effect<Vfs.ObjectReference, InvalidFilehandleError> =>
    Effect.suspend(() => {
      if (handle.length !== HANDLE_BYTES || handle[0] !== HANDLE_VERSION) {
        return Effect.fail(new InvalidFilehandleError("Malformed"))
      }

      if (!sameBytes(handle.subarray(1, 17), generationCopy)) {
        return Effect.fail(new InvalidFilehandleError("WrongGeneration"))
      }

      const reference = referencesById.get(uint64From(handle, 17))

      if (reference === undefined) return Effect.fail(new InvalidFilehandleError("Unknown"))

      return caller.observeMetadata(reference).pipe(
        Effect.as(reference),
        Effect.mapError((error) =>
          new InvalidFilehandleError(
            error.code === "StaleReference" ? "Stale" : error.code === "VolumeUnavailable" ? "Unavailable" : "Unknown"
          )
        )
      )
    })

  const open = (
    activeCaller: Vfs.Caller,
    reference: Vfs.ObjectReference,
    access: Vfs.OpenReferenceSettings["access"] = "read"
  ): Effect.Effect<OpenedFile, Vfs.VfsError> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function*() {
        const scope = yield* Scope.make()

        const opened = yield* Effect.exit(restore(
          activeCaller.openReference(reference, { access }).pipe(Effect.provideService(Scope.Scope, scope))
        ))

        if (Exit.isFailure(opened)) {
          yield* Scope.close(scope, opened)

          return yield* Effect.failCause(opened.cause)
        }

        return {
          handle: opened.value,
          close: Scope.close(scope, Exit.void).pipe(Effect.orDie)
        }
      })
    )

  const withCaller = (activeCaller: Vfs.Caller): NfsExport => ({
    capacity,
    withCaller,
    root: activeCaller.rootReference,
    handleFor,
    resolve,
    observeMetadata: activeCaller.observeMetadata,
    observeDirectory: activeCaller.observeDirectory,
    lookup: (directory, name) =>
      Effect.suspend<Vfs.ObjectReference, Vfs.VfsError | InvalidNameError, never>(() => {
        try {
          validateName(name, limits.maxNameBytes)

          return activeCaller.lookupReference(directory, name)
        } catch (error) {
          if (error instanceof InvalidNameError) return Effect.fail(error)
          throw error
        }
      }),
    parent: activeCaller.parentReference,
    readLink: activeCaller.readLinkReference,
    mkdir: (directory, name, settings) =>
      registryGate.withPermit(Effect.gen(function*() {
        yield* Effect.try({
          try: () => validateName(name, limits.maxNameBytes),
          catch: (error) => {
            if (error instanceof InvalidNameError) return error
            throw error
          }
        })
        yield* admitHandle
        const result = yield* activeCaller.mkdirReference(directory, name, settings)
        registerHandle(result.reference)

        return result
      })),
    symlink: (target, directory, name, settings) =>
      registryGate.withPermit(Effect.gen(function*() {
        yield* Effect.try({
          try: () => validateName(name, limits.maxNameBytes),
          catch: (error) => {
            if (error instanceof InvalidNameError) return error
            throw error
          }
        })
        yield* admitHandle
        const result = yield* activeCaller.symlinkReference(target, directory, name, settings)
        registerHandle(result.reference)

        return result
      })),
    link: activeCaller.linkReference,
    remove: activeCaller.removeReference,
    rename: activeCaller.renameReference,
    chmod: activeCaller.chmodReference,
    chown: activeCaller.chownReference,
    utimes: activeCaller.utimesReference,
    truncate: activeCaller.truncateReference,
    open: (reference, access) => open(activeCaller, reference, access),
    openChild: (directory, name, settings) =>
      registryGate.withPermit(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function*() {
            yield* Effect.try({
              try: () => validateName(name, limits.maxNameBytes),
              catch: (error) => {
                if (error instanceof InvalidNameError) return error
                throw error
              }
            })
            const expected = settings.expectedChild

            if (expected == null || !idsByReference.has(expected.reference)) yield* restore(admitHandle)
            const scope = yield* Scope.make()

            const opened = yield* Effect.exit(restore(
              activeCaller.openChildReference(directory, name, settings).pipe(Effect.provideService(Scope.Scope, scope))
            ))

            if (Exit.isFailure(opened)) {
              yield* Scope.close(scope, opened)

              return yield* Effect.failCause(opened.cause)
            }

            registerHandle(opened.value.reference)

            return { ...opened.value, close: Scope.close(scope, Exit.void).pipe(Effect.orDie) }
          })
        )
      ),
    fsid: [uint64From(identityCopy, 0), uint64From(identityCopy, 8)]
  })

  return withCaller(caller)
}
