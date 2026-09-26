import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as ByteSize from "effect/ByteSize"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Exit from "effect/Exit"
import * as Result from "effect/Result"
import * as Scope from "effect/Scope"

// Version 1 handles carried a per-process serial; version 2 carries the object's reference key.
const HANDLE_VERSION = 2

// A reference key's identity, epoch and tag, each 16 bytes.
const KEY_PART_BYTES = 16

const IDENTITY_OFFSET = 1

const EPOCH_OFFSET = IDENTITY_OFFSET + KEY_PART_BYTES

const INO_OFFSET = EPOCH_OFFSET + KEY_PART_BYTES

const TAG_OFFSET = INO_OFFSET + 8

// version | identity | epoch | ino | tag: 57 bytes, within NFS4_FHSIZE (128). The tag is what keeps a client that
// holds one handle from writing another by changing its inode number.
const HANDLE_BYTES = TAG_OFFSET + KEY_PART_BYTES

/** @internal */
export interface ExportLimits {
  readonly maxNameBytes: ByteSize.ByteSize
}

// What the export needs of its volume: the identity behind the fsid, the durability, reference keys, and the
// limits and usage behind the capacity attributes.
/** @internal */
export type ExportVolume = Pick<
  Vfs.Volume,
  "identity" | "durability" | "referenceKey" | "resolveReferenceKey" | "limits" | "usage"
>

/** @internal */
export interface OpenedFile {
  readonly handle: Vfs.FileHandle
  readonly close: Effect.Effect<void>
}

/** @internal */
export interface NfsExport {
  readonly capacity: Pick<Vfs.Volume, "limits" | "usage">
  /** Whether filehandles outlive the server: the volume's committed state survives at least a process crash. */
  readonly persistentHandles: boolean
  /** Selects a caller for one compound; filehandles belong to the volume, not the caller. */
  readonly withCaller: (caller: Vfs.Caller) => NfsExport
  readonly root: Effect.Effect<Vfs.ObjectReference, Vfs.VfsError>
  readonly handleFor: (reference: Vfs.ObjectReference) => Effect.Effect<Uint8Array, Vfs.VfsError>
  readonly resolve: (handle: Uint8Array) => Effect.Effect<Vfs.ObjectReference, InvalidFilehandleError | Vfs.VfsError>
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
    settings?: Vfs.MkdirOptions
  ) => Effect.Effect<Vfs.ReferenceEntryResult, Vfs.VfsError | InvalidNameError>
  readonly symlink: (
    target: Vfs.PathInput,
    directory: Vfs.ObjectReference,
    name: Uint8Array,
    settings?: Vfs.SymlinkOptions
  ) => Effect.Effect<Vfs.ReferenceEntryResult, Vfs.VfsError | InvalidNameError>
  readonly link: (
    source: Vfs.ObjectReference,
    directory: Vfs.ObjectReference,
    name: Uint8Array
  ) => Effect.Effect<Vfs.ReferenceEntryResult, Vfs.VfsError>
  readonly remove: (
    directory: Vfs.ObjectReference,
    name: Uint8Array
  ) => Effect.Effect<Vfs.DirectoryChange, Vfs.VfsError>
  readonly rename: (
    sourceDirectory: Vfs.ObjectReference,
    sourceName: Uint8Array,
    destinationDirectory: Vfs.ObjectReference,
    destinationName: Uint8Array
  ) => Effect.Effect<Vfs.RenameReferenceResult, Vfs.VfsError>
  readonly setattr: (
    reference: Vfs.ObjectReference,
    attributes: Vfs.SetattrOptions
  ) => Effect.Effect<void, Vfs.VfsError>
  /** The bits of `bits` the caller may exercise on the object. */
  readonly access: (reference: Vfs.ObjectReference, bits: number) => Effect.Effect<number, Vfs.VfsError>
  /**
   * Opens into a scope forked from the one in context, so closing that scope closes the file, and `close`
   * closes the file early and unregisters it, never failing.
   */
  readonly open: (
    reference: Vfs.ObjectReference,
    access?: Vfs.OpenOptions["access"]
  ) => Effect.Effect<OpenedFile, Vfs.VfsError, Scope.Scope>
  /** Looks up or creates and opens a child, into a forked scope as `open` does. */
  readonly openChild: (
    directory: Vfs.ObjectReference,
    name: Uint8Array,
    settings: Vfs.OpenEntryOptions
  ) => Effect.Effect<
    Vfs.OpenEntryResult & { readonly close: Effect.Effect<void> },
    Vfs.VfsError | InvalidNameError,
    Scope.Scope
  >
  readonly fsid: readonly [bigint, bigint]
}

// Why a filehandle names nothing, where the volume's own failure does not say it: its bytes are not a handle this
// export issued, or it belongs to another volume or epoch, which expires a volatile handle and leaves a persistent
// one stale. Every other failure, such as a gone object or a busy volume, stays the volume's error.
/** @internal */
export type InvalidFilehandleReason = "Malformed" | "Expired" | "Stale"

/** @internal */
export class InvalidFilehandleError extends Data.TaggedError("InvalidFilehandleError")<{
  readonly reason: InvalidFilehandleReason
}> {
  constructor(reason: InvalidFilehandleReason) {
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
export const makeExport = (volume: ExportVolume, caller: Vfs.Caller, limits: ExportLimits): NfsExport => {
  assertPositiveInteger("maxNameBytes", ByteSize.toNumberUnsafe(limits.maxNameBytes))

  const identity = Result.getOrThrow(Encoding.decodeHex(volume.identity))
  const persistentHandles = Vfs.isVolumeDurabilityAtLeast(volume.durability, "survives-process-crash")

  const handleFor = (reference: Vfs.ObjectReference): Effect.Effect<Uint8Array, Vfs.VfsError> =>
    Effect.map(volume.referenceKey(reference), (key) => {
      const bytes = new Uint8Array(HANDLE_BYTES)
      bytes[0] = HANDLE_VERSION
      bytes.set(key.identity, IDENTITY_OFFSET)
      bytes.set(key.epoch, EPOCH_OFFSET)
      new DataView(bytes.buffer).setBigUint64(INO_OFFSET, key.ino)
      bytes.set(key.tag, TAG_OFFSET)

      return bytes
    })

  // A key the volume did not mint, a forged tag included, is not a handle. One from another volume or epoch expires
  // when handles are volatile (RFC 8881 Section 4.2.3); a persistent handle that names nothing is stale (Section
  // 4.2.2), like one whose object is gone.
  const filehandleFailure = (error: Vfs.VfsError): InvalidFilehandleError | Vfs.VfsError =>
    error.code === "InvalidReference"
      ? new InvalidFilehandleError("Malformed")
      : error.code === "ForeignReference"
      ? new InvalidFilehandleError(persistentHandles ? "Stale" : "Expired")
      : error

  const resolve = (handle: Uint8Array): Effect.Effect<Vfs.ObjectReference, InvalidFilehandleError | Vfs.VfsError> =>
    Effect.suspend(() => {
      if (handle.length !== HANDLE_BYTES || handle[0] !== HANDLE_VERSION) {
        return Effect.fail(new InvalidFilehandleError("Malformed"))
      }

      const key = {
        identity: handle.slice(IDENTITY_OFFSET, EPOCH_OFFSET),
        epoch: handle.slice(EPOCH_OFFSET, INO_OFFSET),
        ino: uint64From(handle, INO_OFFSET),
        tag: handle.slice(TAG_OFFSET, HANDLE_BYTES)
      }

      return volume.resolveReferenceKey(key).pipe(Effect.mapError(filehandleFailure))
    })

  const open = (
    activeCaller: Vfs.Caller,
    reference: Vfs.ObjectReference,
    access: Vfs.OpenOptions["access"] = "read"
  ): Effect.Effect<OpenedFile, Vfs.VfsError, Scope.Scope> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function*() {
        const scope = yield* Scope.fork(yield* Effect.scope)

        const opened = yield* Effect.exit(restore(
          activeCaller.open(reference, { access }).pipe(Effect.provideService(Scope.Scope, scope))
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
    capacity: volume,
    persistentHandles,
    withCaller,
    root: activeCaller.root,
    handleFor,
    resolve,
    observeMetadata: (reference) =>
      Effect.map(activeCaller.stat(reference), (metadata) => ({ value: metadata, revision: metadata.revision })),
    observeDirectory: (reference) => activeCaller.readDirectory(reference),
    lookup: (directory, name) =>
      Effect.suspend<Vfs.ObjectReference, Vfs.VfsError | InvalidNameError, never>(() => {
        try {
          validateName(name, limits.maxNameBytes)

          return activeCaller.lookup(Vfs.Entry(directory, name))
        } catch (error) {
          if (error instanceof InvalidNameError) return Effect.fail(error)
          throw error
        }
      }),
    parent: (directory) => activeCaller.parent(directory),
    readLink: (reference) => activeCaller.readLink(reference),
    mkdir: (directory, name, settings) =>
      Effect.gen(function*() {
        yield* Effect.try({
          try: () => validateName(name, limits.maxNameBytes),
          catch: (error) => {
            if (error instanceof InvalidNameError) return error
            throw error
          }
        })

        return yield* activeCaller.mkdir(Vfs.Entry(directory, name), settings)
      }),
    symlink: (target, directory, name, settings) =>
      Effect.gen(function*() {
        yield* Effect.try({
          try: () => validateName(name, limits.maxNameBytes),
          catch: (error) => {
            if (error instanceof InvalidNameError) return error
            throw error
          }
        })

        return yield* activeCaller.symlink(target, Vfs.Entry(directory, name), settings)
      }),
    link: (source, directory, name) => activeCaller.link(source, Vfs.Entry(directory, name)),
    remove: (directory, name) => activeCaller.remove(Vfs.Entry(directory, name)),
    rename: (sourceDirectory, sourceName, destinationDirectory, destinationName) =>
      activeCaller.rename(Vfs.Entry(sourceDirectory, sourceName), Vfs.Entry(destinationDirectory, destinationName)),
    setattr: (reference, attributes) => activeCaller.setattr(reference, attributes),
    access: (reference, bits) => activeCaller.access(reference, bits),
    open: (reference, access) => open(activeCaller, reference, access),
    openChild: (directory, name, settings) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function*() {
          yield* Effect.try({
            try: () => validateName(name, limits.maxNameBytes),
            catch: (error) => {
              if (error instanceof InvalidNameError) return error
              throw error
            }
          })
          const scope = yield* Scope.fork(yield* Effect.scope)

          const opened = yield* Effect.exit(restore(
            activeCaller.open(Vfs.Entry(directory, name), settings).pipe(Effect.provideService(Scope.Scope, scope))
          ))

          if (Exit.isFailure(opened)) {
            yield* Scope.close(scope, opened)

            return yield* Effect.failCause(opened.cause)
          }

          return { ...opened.value, close: Scope.close(scope, Exit.void).pipe(Effect.orDie) }
        })
      ),
    fsid: [uint64From(identity, 0), uint64From(identity, 8)]
  })

  return withCaller(caller)
}
