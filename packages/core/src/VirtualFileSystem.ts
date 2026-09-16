/**
 * Runtime-neutral virtual filesystem contracts and constructors.
 *
 * **Details**
 *
 * Volumes own isolated namespaces. Callers carry path context and credentials,
 * while file and directory handles use `Scope` for deterministic release.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as SchemaAST from "effect/SchemaAST"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaTransformation from "effect/SchemaTransformation"
import type * as Scope from "effect/Scope"
import type * as Stream from "effect/Stream"
import type { BytePath } from "./BytePath.js"

export { BytePath } from "./BytePath.js"

import type { DecodeLimits, ImageError, Snapshot } from "./Snapshot.js"

export { DecodeLimits, ImageError, type Snapshot, SnapshotTypeId } from "./Snapshot.js"

import * as Image from "./internal/image.js"
import * as SnapshotDeltaInternal from "./internal/snapshotDelta.js"
import * as VfsModel from "./internal/virtualFileSystem.js"
import * as FixtureInternal from "./internal/virtualFileSystem/fixture.js"
import * as Path from "./internal/virtualFileSystem/path.js"
import * as SnapshotDeltaModel from "./SnapshotDelta.js"

export {
  SnapshotChange,
  SnapshotChangesOptions,
  type SnapshotDelta,
  SnapshotDeltaError,
  SnapshotDeltaLimits,
  SnapshotDeltaTypeId,
  SnapshotDifference,
  SnapshotNodeKind
} from "./SnapshotDelta.js"

const VolumeId: typeof VfsModel.VolumeId = VfsModel.VolumeId

const CallerId: typeof VfsModel.CallerId = VfsModel.CallerId

const FileHandleId: typeof VfsModel.FileHandleId = VfsModel.FileHandleId

const DirectoryHandleId: typeof VfsModel.DirectoryHandleId = VfsModel.DirectoryHandleId

const ObjectReferenceId: typeof VfsModel.ObjectReferenceId = VfsModel.ObjectReferenceId

/**
 * A UTF-8 string path or an opaque byte-preserving path.
 *
 * @category models
 * @since 0.1.0
 */
export type PathInput = string | BytePath

/**
 * Schema for portable virtual filesystem error codes.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FsCode: typeof VfsModel.FsCode = VfsModel.FsCode

/**
 * A portable virtual filesystem error code.
 *
 * @category models
 * @since 0.1.0
 */
export type FsCode = typeof FsCode.Type

/**
 * Describes an expected filesystem operation failure.
 *
 * @category errors
 * @since 0.1.0
 */
export const FsError = VfsModel.FsError

/** @internal */
export interface FsError extends VfsModel.FsError {}

/**
 * Describes an invalid volume or caller option and names the rejected field.
 *
 * @category errors
 * @since 0.1.0
 */
export const ConfigurationError = VfsModel.ConfigurationError

/** @internal */
export interface ConfigurationError extends VfsModel.ConfigurationError {}

/**
 * Schema for a caller's numeric identity, supplementary groups, and explicit privilege.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Identity: typeof VfsModel.Identity = VfsModel.Identity

/**
 * A caller identity used for permission checks.
 *
 * @category models
 * @since 0.1.0
 */
export type Identity = typeof Identity.Type

/**
 * Schema for root caller credentials and creation mask.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RootCallerOptions: typeof VfsModel.RootCallerOptions = VfsModel.RootCallerOptions

/**
 * Options for creating a root caller on a volume.
 *
 * @category models
 * @since 0.1.0
 */
export type RootCallerOptions = typeof RootCallerOptions.Type

/**
 * Schema for optional volume capacity and path limits.
 *
 * @category schemas
 * @since 0.1.0
 */
export const VolumeOptions: typeof VfsModel.VolumeOptions = VfsModel.VolumeOptions

/**
 * Capacity and path limits for a volume.
 *
 * @category models
 * @since 0.1.0
 */
export type VolumeOptions = typeof VolumeOptions.Type

/**
 * Schema for filesystem node metadata with bigint inode, size, and nanosecond fields.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Metadata: typeof VfsModel.Metadata = VfsModel.Metadata

/**
 * Metadata for a directory, regular file, or symbolic link.
 *
 * @category models
 * @since 0.1.0
 */
export type Metadata = typeof Metadata.Type

/**
 * An opaque identity for one object in one live volume.
 *
 * @category models
 * @since 0.1.0
 */
export interface ObjectReference {
  readonly [ObjectReferenceId]: true
}

/**
 * A value and the revision of the object from the same coordinated observation.
 *
 * @category models
 * @since 0.1.0
 */
export interface ObjectObservation<A> {
  readonly value: A
  readonly revision: bigint
}

/**
 * One owned directory name paired with the referenced child object.
 *
 * @category models
 * @since 0.1.0
 */
export interface DirectoryEntry {
  readonly name: Uint8Array
  readonly reference: ObjectReference
}

/**
 * Resolves a relative path from a live directory handle instead of the caller's directory.
 *
 * @category models
 * @since 0.1.0
 */
export interface RelativeOptions {
  /** Resolve relative paths from this live, same-volume handle instead of the caller's current directory. */
  readonly relativeTo?: DirectoryHandle
}

/**
 * Controls the base directory and whether metadata operations follow the final symbolic link.
 *
 * @category models
 * @since 0.1.0
 */
export interface MetadataOptions extends RelativeOptions {
  /** Follow the final symbolic link. Defaults to `true`. */
  readonly followFinalSymlink?: boolean
}

/**
 * Schema for an owner update. Omitted fields retain their existing values.
 *
 * @category schemas
 * @since 0.1.0
 */
export const OwnerUpdate: typeof VfsModel.OwnerUpdate = VfsModel.OwnerUpdate

/**
 * An owner update for `chown` operations.
 *
 * @category models
 * @since 0.1.0
 */
export type OwnerUpdate = typeof OwnerUpdate.Type

/**
 * Schema for setting a timestamp to the clock, retaining it, or supplying nanoseconds.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TimeUpdate: typeof VfsModel.TimeUpdate = VfsModel.TimeUpdate

/**
 * Schema for independent access and modification time updates.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Times: typeof VfsModel.Times = VfsModel.Times

/**
 * Access and modification time updates for `utimes` operations.
 *
 * @category models
 * @since 0.1.0
 */
export type Times = typeof Times.Type

/**
 * A scoped directory capability that can be used for metadata and relative lookup.
 *
 * @category models
 * @since 0.1.0
 */
export interface DirectoryHandle {
  readonly [DirectoryHandleId]: true
  readonly stat: Effect.Effect<Metadata, FsError>
  readonly close: Effect.Effect<void, FsError>
}

/**
 * Schema for file seek origins, including dense-file data and hole queries.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SeekMode: typeof VfsModel.SeekMode = VfsModel.SeekMode

/**
 * The origin used by a file handle seek operation.
 *
 * @category models
 * @since 0.1.0
 */
export type SeekMode = typeof SeekMode.Type

/**
 * Schema for file access, creation, append, truncate, and symlink behavior.
 *
 * @category schemas
 * @since 0.1.0
 */
export const OpenSettings: typeof VfsModel.OpenSettings = VfsModel.OpenSettings

/**
 * Options for acquiring a scoped file handle.
 *
 * @category models
 * @since 0.1.0
 */
export type OpenOptions = typeof OpenSettings.Type & RelativeOptions

/**
 * Options for an atomic whole-file write, including replacement and final mode controls.
 *
 * @category models
 * @since 0.1.0
 */
export type WriteFileOptions = VfsModel.WriteFileOptions

/**
 * A scoped regular-file capability with an independent bigint cursor.
 *
 * @category models
 * @since 0.1.0
 */
export interface FileHandle {
  readonly [FileHandleId]: true
  /** Reads up to `maximumBytes` from the cursor and advances it by the returned length. */
  readonly read: (maximumBytes: number) => Effect.Effect<Uint8Array, FsError>
  /** Reads at `offset` without changing the cursor. */
  readonly pread: (maximumBytes: number, offset: bigint) => Effect.Effect<Uint8Array, FsError>
  /** Writes at the cursor and advances it, or writes at end of file when opened for append. */
  readonly write: (bytes: Uint8Array) => Effect.Effect<number, FsError>
  /** Writes at `offset` without changing the cursor. Append mode does not affect positional writes. */
  readonly pwrite: (bytes: Uint8Array, offset: bigint) => Effect.Effect<number, FsError>
  /** Moves the cursor and returns its new offset. `data` finds content and `hole` finds end of file. */
  readonly seek: (offset: bigint, mode: SeekMode) => Effect.Effect<bigint, FsError>
  /** Sets the file length without changing the cursor. */
  readonly truncate: (length: bigint) => Effect.Effect<void, FsError>
  /** Reads metadata for the open file. */
  readonly stat: Effect.Effect<Metadata, FsError>
  /** Checks handle liveness. In-memory storage has no host or crash durability to flush. */
  readonly sync: Effect.Effect<void, FsError>
  /** Closes the handle. A repeated explicit close fails; scope cleanup remains safe. */
  readonly close: Effect.Effect<void, FsError>
}

/**
 * A filesystem caller with its own identity, creation mask, and current directory.
 *
 * @category models
 * @since 0.1.0
 */
export interface Caller {
  readonly [CallerId]: true
  /** Returns the stable reference for this volume's root directory. */
  readonly rootReference: Effect.Effect<ObjectReference, FsError>
  /** Looks up one byte-preserving child name from a referenced directory. */
  readonly lookupReference: (directory: ObjectReference, name: Uint8Array) => Effect.Effect<ObjectReference, FsError>
  /** Returns a referenced directory's current parent. The root is its own parent. */
  readonly parentReference: (directory: ObjectReference) => Effect.Effect<ObjectReference, FsError>
  /** Reads metadata and its matching live revision. */
  readonly observeMetadata: (reference: ObjectReference) => Effect.Effect<ObjectObservation<Metadata>, FsError>
  /** Reads owned directory entries and their matching directory revision. */
  readonly observeDirectory: (
    reference: ObjectReference
  ) => Effect.Effect<ObjectObservation<ReadonlyArray<DirectoryEntry>>, FsError>
  /** Reads an owned symbolic-link target through a stable reference. */
  readonly readLinkReference: (reference: ObjectReference) => Effect.Effect<Uint8Array, FsError>
  /** Opens a referenced regular file for reading. */
  readonly openReference: (reference: ObjectReference) => Effect.Effect<FileHandle, FsError, Scope.Scope>
  /** Reads metadata, following the final symbolic link by default. */
  readonly stat: (path: PathInput, options?: RelativeOptions) => Effect.Effect<Metadata, FsError>
  /** Atomically moves an entry within this volume without replacing a non-empty directory. */
  readonly rename: (
    source: PathInput,
    destination: PathInput,
    options?: {
      readonly sourceRelativeTo?: DirectoryHandle
      readonly destinationRelativeTo?: DirectoryHandle
    }
  ) => Effect.Effect<void, FsError>
  /** Reads and returns an owned copy of a regular file's complete contents. */
  readonly readFile: (path: PathInput, options?: RelativeOptions) => Effect.Effect<Uint8Array, FsError>
  /** Atomically writes a complete regular file according to the replacement options. */
  readonly writeFile: (path: PathInput, bytes: Uint8Array, options: WriteFileOptions) => Effect.Effect<void, FsError>
  /** Checks the requested permission bits without opening the entry. */
  readonly access: (path: PathInput, bits?: number, options?: RelativeOptions) => Effect.Effect<void, FsError>
  /** Sets a regular file's length. Extending creates a zero-filled region. */
  readonly truncate: (path: PathInput, length: bigint, options?: RelativeOptions) => Effect.Effect<void, FsError>
  /** Changes permission bits, following the final symbolic link by default. */
  readonly chmod: (path: PathInput, mode: number, options?: MetadataOptions) => Effect.Effect<void, FsError>
  /** Changes uid, gid, or both, following the final symbolic link by default. */
  readonly chown: (path: PathInput, owner: OwnerUpdate, options?: MetadataOptions) => Effect.Effect<void, FsError>
  /** Updates access and modification times, following the final symbolic link by default. */
  readonly utimes: (path: PathInput, times: Times, options?: MetadataOptions) => Effect.Effect<void, FsError>
  /** Changes permission bits through a live, same-volume handle. */
  readonly chmodHandle: (handle: FileHandle | DirectoryHandle, mode: number) => Effect.Effect<void, FsError>
  /** Changes uid, gid, or both through a live, same-volume handle. */
  readonly chownHandle: (handle: FileHandle | DirectoryHandle, owner: OwnerUpdate) => Effect.Effect<void, FsError>
  /** Updates access and modification times through a live, same-volume handle. */
  readonly utimesHandle: (handle: FileHandle | DirectoryHandle, times: Times) => Effect.Effect<void, FsError>
  /** Reads metadata without following the final symbolic link. */
  readonly lstat: (path: PathInput, options?: RelativeOptions) => Effect.Effect<Metadata, FsError>
  /** Creates a hard link to an existing non-directory entry. */
  readonly link: (
    source: PathInput,
    destination: PathInput,
    options?: {
      readonly sourceRelativeTo?: DirectoryHandle
      readonly destinationRelativeTo?: DirectoryHandle
      readonly followSourceSymlink?: boolean
    }
  ) => Effect.Effect<void, FsError>
  /** Creates a symbolic link. The target bytes are stored without resolving them. */
  readonly symlink: (target: PathInput, path: PathInput, options?: RelativeOptions) => Effect.Effect<void, FsError>
  /** Reads a symbolic-link target as UTF-8, failing with `UnrepresentableName` for other bytes. */
  readonly readLink: (path: PathInput, options?: RelativeOptions) => Effect.Effect<string, FsError>
  /** Reads a symbolic-link target as owned bytes. */
  readonly readLinkBytes: (path: PathInput, options?: RelativeOptions) => Effect.Effect<Uint8Array, FsError>
  /** Reads directory names as UTF-8, failing if any name is not representable. */
  readonly readDirectory: (path: PathInput, options?: RelativeOptions) => Effect.Effect<ReadonlyArray<string>, FsError>
  /** Reads directory names as owned byte arrays. */
  readonly readDirectoryBytes: (
    path: PathInput,
    options?: RelativeOptions
  ) => Effect.Effect<ReadonlyArray<Uint8Array>, FsError>
  /** Resolves links and normalizes a path as UTF-8. */
  readonly realPath: (path: PathInput, options?: RelativeOptions) => Effect.Effect<string, FsError>
  /** Resolves links and normalizes a path without requiring UTF-8 names. */
  readonly realPathBytes: (path: PathInput, options?: RelativeOptions) => Effect.Effect<BytePath, FsError>
  /** Opens a scoped regular-file handle. The surrounding scope closes it automatically. */
  readonly open: (path: PathInput, options: OpenOptions) => Effect.Effect<FileHandle, FsError, Scope.Scope>
  /** Removes a non-directory entry. Open handles remain usable until closed. */
  readonly unlink: (path: PathInput, options?: RelativeOptions) => Effect.Effect<void, FsError>
  /** Removes an empty directory. */
  readonly rmdir: (path: PathInput, options?: RelativeOptions) => Effect.Effect<void, FsError>
  /** Creates one directory. Parent directories must already exist. */
  readonly mkdir: (
    path: PathInput,
    options?: RelativeOptions & {
      readonly mode?: number
    }
  ) => Effect.Effect<void, FsError>
  /** Creates a scoped caller whose current directory is the resolved directory identity. */
  readonly withDirectory: (path: PathInput, options?: RelativeOptions) => Effect.Effect<Caller, FsError, Scope.Scope>
  /** Opens a scoped directory handle for metadata and relative path resolution. */
  readonly openDirectory: (
    path: PathInput,
    options?: RelativeOptions
  ) => Effect.Effect<DirectoryHandle, FsError, Scope.Scope>
}

/**
 * A committed namespace or content change emitted by a volume watch stream.
 *
 * @category models
 * @since 0.1.0
 */
export interface Change {
  /** Kind of committed namespace or content change. */
  readonly _tag: "Create" | "Update" | "Remove"
  /** Absolute path of the changed entry. */
  readonly path: BytePath
}

/**
 * Schema for the filesystem entry kinds reported by overlay summaries.
 *
 * @category schemas
 * @since 0.1.0
 */
export const OverlayNodeKind: typeof VfsModel.OverlayNodeKind = VfsModel.OverlayNodeKind

/**
 * A filesystem entry kind reported by an overlay summary.
 *
 * @category models
 * @since 0.1.0
 */
export type OverlayNodeKind = typeof OverlayNodeKind.Type

/**
 * Schema for observable fields that can differ from an overlay's immutable base.
 *
 * @category schemas
 * @since 0.1.0
 */
export const OverlayDifference: typeof VfsModel.OverlayDifference = VfsModel.OverlayDifference

/**
 * A content, ownership, permission, or timestamp field that differs from the overlay base.
 *
 * @category models
 * @since 0.1.0
 */
export type OverlayDifference = typeof OverlayDifference.Type

/**
 * Schema for a final-state overlay difference.
 *
 * **Details**
 *
 * Paths retain arbitrary non-NUL bytes. Renames are reported only when retained
 * base identity makes the removed and added names unambiguous.
 *
 * @category schemas
 * @since 0.1.0
 */
export const OverlayChange: typeof VfsModel.OverlayChange = VfsModel.OverlayChange

/**
 * A path-oriented final-state difference from an overlay's immutable base.
 *
 * @category models
 * @since 0.1.0
 */
export type OverlayChange = typeof OverlayChange.Type

/**
 * Schema for overlay summary filtering.
 *
 * @category schemas
 * @since 0.1.0
 */
export const OverlayChangesOptions: typeof VfsModel.OverlayChangesOptions = VfsModel.OverlayChangesOptions

/**
 * Filtering options for an overlay final-difference summary.
 *
 * @category models
 * @since 0.1.0
 */
export type OverlayChangesOptions = typeof OverlayChangesOptions.Type

/**
 * A complete snapshot and final-difference summary captured from one committed state.
 *
 * @category models
 * @since 0.1.0
 */
export interface OverlayCapture {
  /** Complete version 1 snapshot owned by this capture. */
  readonly snapshot: Snapshot
  /** Owned summary that describes the same state as `snapshot`. */
  readonly changes: ReadonlyArray<OverlayChange>
}

/**
 * An isolated virtual filesystem namespace that creates callers, snapshots, and watch streams.
 *
 * @category models
 * @since 0.1.0
 */
export interface Volume {
  /** Opens a scoped stream of future committed changes. Events are not replayed. */
  readonly watch: Effect.Effect<Stream.Stream<Change>, never, Scope.Scope>
  /** Captures an isolated snapshot of the reachable namespace and metadata. */
  readonly snapshot: Effect.Effect<Snapshot, ImageError>
  readonly [VolumeId]: true
  /** Creates a caller rooted at `/` with independent credentials, umask, and current directory. */
  readonly caller: (options?: RootCallerOptions) => Effect.Effect<Caller, ConfigurationError>
}

/**
 * An ordinary volume with final-state inspection relative to one immutable snapshot base.
 *
 * @category models
 * @since 0.1.0
 */
export interface OverlayVolume extends Volume {
  /** Computes final differences from the immutable base when this reusable effect executes. */
  readonly changes: (
    options?: OverlayChangesOptions
  ) => Effect.Effect<ReadonlyArray<OverlayChange>, ConfigurationError | ImageError>
  /** Captures one committed state when this reusable effect executes. */
  readonly capture: (
    options?: OverlayChangesOptions
  ) => Effect.Effect<OverlayCapture, ConfigurationError | ImageError>
}

/**
 * Optional Effect service for providing an existing filesystem caller.
 *
 * @category services
 * @since 0.1.0
 */
export const CurrentFileSystem = VfsModel.CurrentFileSystem

/** @internal */
export type CurrentFileSystem = VfsModel.CurrentFileSystem

/**
 * Encodes a snapshot as owned UTF-8 JSON bytes using the version 1 snapshot format.
 *
 * @category serialization
 * @since 0.1.0
 */
export const encodeSnapshot: (snapshot: Snapshot) => Effect.Effect<Uint8Array, ImageError> = Image.encodeSnapshot

/**
 * Decodes version 1 snapshot bytes while enforcing explicit input and payload limits.
 *
 * @category serialization
 * @since 0.1.0
 */
export const decodeSnapshot: (
  input: Uint8Array,
  limits: DecodeLimits
) => Effect.Effect<Snapshot, ImageError> = Image.decodeSnapshot

const deltaLimits = (limits?: SnapshotDeltaModel.SnapshotDeltaLimits) => {
  const decoded = Path.decodeConfiguration(
    SnapshotDeltaModel.SnapshotDeltaLimits,
    limits ?? SnapshotDeltaModel.SnapshotDeltaLimits.default
  )

  return Result.isFailure(decoded) ? Effect.fail(decoded.failure) : Effect.succeed(decoded.success)
}

/**
 * Computes an exact portable delta between two immutable snapshots.
 * Requires the platform-neutral `Crypto.Crypto` service for base identity.
 *
 * @category snapshots
 * @since 0.1.0
 */
export const diffSnapshots = Effect.fn("VirtualFileSystem.diffSnapshots")(function*(
  base: Snapshot,
  target: Snapshot,
  limits?: SnapshotDeltaModel.SnapshotDeltaLimits
) {
  return yield* SnapshotDeltaInternal.diffSnapshots(base, target, yield* deltaLimits(limits))
})

/**
 * Verifies an exact snapshot delta against its base and derives an owned path-oriented summary.
 * Requires the platform-neutral `Crypto.Crypto` service for base identity.
 *
 * @category snapshots
 * @since 0.1.0
 */
export const inspectSnapshotDelta = Effect.fn("VirtualFileSystem.inspectSnapshotDelta")(function*(
  base: Snapshot,
  delta: SnapshotDeltaModel.SnapshotDelta,
  options?: SnapshotDeltaModel.SnapshotChangesOptions,
  limits?: SnapshotDeltaModel.SnapshotDeltaLimits
) {
  const decoded = Path.decodeConfiguration(SnapshotDeltaModel.SnapshotChangesOptions, options ?? {})

  if (Result.isFailure(decoded)) return yield* decoded.failure

  return yield* SnapshotDeltaInternal.inspectSnapshotDelta(base, delta, decoded.success, yield* deltaLimits(limits))
})

/**
 * Applies an exact delta to its semantically matching base and returns a new snapshot.
 * Requires the platform-neutral `Crypto.Crypto` service for base identity.
 *
 * @category snapshots
 * @since 0.1.0
 */
export const applySnapshotDelta = Effect.fn("VirtualFileSystem.applySnapshotDelta")(function*(
  base: Snapshot,
  delta: SnapshotDeltaModel.SnapshotDelta,
  limits?: SnapshotDeltaModel.SnapshotDeltaLimits
) {
  return yield* SnapshotDeltaInternal.applySnapshotDelta(base, delta, yield* deltaLimits(limits))
})

const deltaSchemaIssue = (cause: ImageError, input: typeof Schema.Unknown.Type, options: SchemaAST.ParseOptions) =>
  new SchemaIssue.InvalidValue(
    { message: `Snapshot delta ${cause.code}${cause.field === undefined ? "" : ` at ${cause.field}`}` },
    input,
    options
  )

/**
 * Creates an Effect Schema codec between owned bytes and opaque snapshot deltas.
 * Omission uses `SnapshotDeltaLimits.default`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SnapshotDeltaFromBytes = (limits?: SnapshotDeltaModel.SnapshotDeltaLimits) => {
  const selected = Schema.decodeResult(SnapshotDeltaModel.SnapshotDeltaLimits, { onExcessProperty: "error" })(
    limits ?? SnapshotDeltaModel.SnapshotDeltaLimits.default
  )

  return Schema.Uint8Array.pipe(
    Schema.decodeTo(
      SnapshotDeltaModel.SnapshotDelta,
      SchemaTransformation.transformEffect({
        decode: (input, options) =>
          Result.isFailure(selected)
            ? Effect.fail(new SchemaIssue.InvalidValue({ message: "Invalid snapshot delta limits" }, limits, options))
            : SnapshotDeltaInternal.decodeSnapshotDelta(input, selected.success).pipe(
              Effect.mapError((cause) => deltaSchemaIssue(cause, input, options))
            ),
        encode: (delta, options) =>
          Result.isFailure(selected)
            ? Effect.fail(new SchemaIssue.InvalidValue({ message: "Invalid snapshot delta limits" }, limits, options))
            : SnapshotDeltaInternal.encodeSnapshotDelta(delta, selected.success).pipe(
              Effect.mapError((cause) => deltaSchemaIssue(cause, delta, options))
            )
      })
    )
  )
}

/**
 * Creates an opaque byte path by copying the input when the Effect executes.
 *
 * **Gotchas**
 *
 * Shared-memory-backed and detached views fail with `InvalidArgument`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const pathFromBytes: (bytes: Uint8Array) => Effect.Effect<BytePath, FsError> = Path.pathFromBytes

/**
 * Copies the bytes held by an opaque byte path.
 *
 * @category getters
 * @since 0.1.0
 */
export const pathToBytes: (path: BytePath) => Effect.Effect<Uint8Array, FsError> = Path.pathToBytes

/**
 * Schema for a complete fixture namespace with optional metadata and forward hard links.
 *
 * **Details**
 *
 * Fixture paths must be absolute, unique, and explicitly include their parent directories.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Fixture: typeof VfsModel.Fixture = VfsModel.Fixture

/**
 * A complete filesystem fixture accepted by `fromFixture`.
 *
 * @category models
 * @since 0.1.0
 */
export type Fixture = typeof Fixture.Type

/**
 * Creates a fresh empty volume and captures the current Effect `Clock`.
 *
 * **Details**
 *
 * Each execution creates independent storage. Snapshot image failures cannot
 * arise because this constructor does not accept persisted input.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make: (options?: VolumeOptions) => Effect.Effect<Volume, ConfigurationError> = VfsModel.make

/**
 * Restores a fresh volume from an opaque snapshot under the supplied destination limits.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromSnapshot: (
  snapshot: Snapshot,
  options?: VolumeOptions
) => Effect.Effect<Volume, ConfigurationError | ImageError> = VfsModel.fromSnapshot

/**
 * Creates an isolated writable volume relative to one immutable snapshot base.
 *
 * **Details**
 *
 * Workspaces made from the same snapshot share unchanged regular-file payloads.
 * The first content mutation copies the whole file into workspace-private
 * storage. Metadata, namespace state, coordination, handles, and watches are
 * always private to the new workspace.
 *
 * Invalid base snapshots fail with `ImageError`; invalid volume limits fail
 * with `ConfigurationError`. Each execution creates a fresh workspace.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeOverlay: (
  base: Snapshot,
  options?: VolumeOptions
) => Effect.Effect<OverlayVolume, ConfigurationError | ImageError> = VfsModel.makeOverlay

/**
 * Builds a fresh volume from a validated final-state fixture.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromFixture: (
  fixture: Fixture,
  options?: VolumeOptions
) => Effect.Effect<Volume, ConfigurationError | ImageError> = FixtureInternal.fromFixture
