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
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import { DecodeLimits, ImageError, type Snapshot } from "./Snapshot.js"
export { DecodeLimits, ImageError, type Snapshot, SnapshotTypeId } from "./Snapshot.js"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as PubSub from "effect/PubSub"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as SchemaAST from "effect/SchemaAST"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import { BytePath, BytePathId, getBytes as getBytePathBytes, make as makeBytePath } from "./BytePath.js"
export { BytePath } from "./BytePath.js"
import * as Content from "./internal/content.js"
import * as Image from "./internal/image.js"
import { compareOverlay, type ObservationEntry, type RawOverlayChange } from "./internal/overlayChanges.js"
import * as OverlayTesting from "./internal/overlayTesting.js"
import * as SnapshotDeltaInternal from "./internal/snapshotDelta.js"
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

const VolumeId = Symbol("@effect-vfs/core/Volume")
const CallerId = Symbol("@effect-vfs/core/Caller")
const FileHandleId = Symbol("@effect-vfs/core/FileHandle")
const DirectoryHandleId = Symbol("@effect-vfs/core/DirectoryHandle")
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
export class FsError extends Data.TaggedError("FsError")<{
  /** Machine-readable reason for the failure. */
  readonly code: FsCode
  /** Operation that detected the failure. */
  readonly operation: string
  /** Path involved in the failure, when one path identifies it. */
  readonly path?: PathInput
}> {}
/**
 * Describes an invalid volume or caller option and names the rejected field.
 *
 * @category errors
 * @since 0.1.0
 */
export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  /** Name of the rejected option. */
  readonly field: string
}> {}

const Natural = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)
const Mode = Natural.check(Schema.isLessThanOrEqualTo(0o7777))
/**
 * Schema for a caller's numeric identity, supplementary groups, and explicit privilege.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Identity = Schema.Struct({
  /** Numeric user identifier used by ownership and permission checks. */
  uid: Natural,
  /** Primary numeric group identifier. */
  gid: Natural,
  /** Supplementary group identifiers used by group permission checks. */
  groups: Schema.Array(Natural),
  /** Grants root-style permission bypasses independently of `uid`. */
  privileged: Schema.Boolean
})
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
export const RootCallerOptions = Schema.Struct({
  /** Caller identity. Defaults to privileged uid and gid `0`. */
  identity: Schema.optionalKey(Identity),
  /** Creation mask applied to requested modes. Defaults to `0o022`. */
  umask: Schema.optionalKey(Natural.check(Schema.isLessThanOrEqualTo(0o777)))
})
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
export const VolumeOptions = Schema.Struct({
  /** Maximum number of filesystem nodes. Omission leaves the count unbounded. */
  maxEntries: Schema.optionalKey(Natural),
  /** Maximum combined regular-file content in bytes. */
  maxBytes: Schema.optionalKey(Natural),
  /** Maximum content size of one regular file in bytes. */
  maxFileBytes: Schema.optionalKey(Natural.check(Schema.isLessThanOrEqualTo(0xffffffff))),
  /** Maximum encoded byte length of an absolute or relative path. */
  maxPathBytes: Schema.optionalKey(Natural.check(Schema.isGreaterThanOrEqualTo(1)))
})
/**
 * Capacity and path limits for a volume.
 *
 * @category models
 * @since 0.1.0
 */
export type VolumeOptions = typeof VolumeOptions.Type
// Match snapshot v1's canonical signed decimal timestamp domain.
const timestampLimit = 10n ** 128n - 1n
const Timestamp = Schema.BigInt.check(
  Schema.isGreaterThanOrEqualToBigInt(-timestampLimit),
  Schema.isLessThanOrEqualToBigInt(timestampLimit)
)
/**
 * Schema for filesystem node metadata with bigint inode, size, and nanosecond fields.
 *
 * @category schemas
 * @since 0.1.0
 */
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
/**
 * Metadata for a directory, regular file, or symbolic link.
 *
 * @category models
 * @since 0.1.0
 */
export type Metadata = typeof Metadata.Type

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
export const OwnerUpdate = Schema.Struct({ uid: Schema.optionalKey(Natural), gid: Schema.optionalKey(Natural) })
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
export const TimeUpdate = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("now") }),
  Schema.Struct({ kind: Schema.Literal("omit") }),
  Schema.Struct({ kind: Schema.Literal("value"), nanoseconds: Timestamp })
])
/**
 * Schema for independent access and modification time updates.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Times = Schema.Struct({ access: TimeUpdate, modification: TimeUpdate })
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
  /** Reads metadata for the directory while the handle remains open. */
  readonly stat: Effect.Effect<Metadata, FsError>
  /** Closes the handle. A repeated explicit close fails; scope cleanup remains safe. */
  readonly close: Effect.Effect<void, FsError>
}
/**
 * Schema for file seek origins, including dense-file data and hole queries.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SeekMode = Schema.Literals(["start", "current", "end", "data", "hole"])
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
export const OpenSettings = Schema.Struct({
  /** Permitted operations on the returned handle. */
  access: Schema.Literals(["read", "write", "readWrite"]),
  /** Creation policy. Defaults to `"never"`. */
  create: Schema.optionalKey(Schema.Literals(["never", "ifMissing", "exclusive"])),
  /** Requested mode for a new file, before applying the caller's umask. */
  mode: Schema.optionalKey(Mode),
  /** Write at the current end of file regardless of the handle cursor. */
  append: Schema.optionalKey(Schema.Boolean),
  /** Truncate an existing regular file to zero bytes during open. */
  truncate: Schema.optionalKey(Schema.Boolean),
  /** Follow the final symbolic link. Defaults to `true`. */
  followFinalSymlink: Schema.optionalKey(Schema.Boolean)
})
/**
 * Options for acquiring a scoped file handle.
 *
 * @category models
 * @since 0.1.0
 */
export type OpenOptions = typeof OpenSettings.Type & RelativeOptions
const WriteFileSettings = Schema.Struct({
  ...OpenSettings.fields,
  /** Replace the final symbolic link itself instead of its target. */
  replaceFinalSymlink: Schema.optionalKey(Schema.Boolean),
  /** Mode to apply after replacing an existing file. */
  finalMode: Schema.optionalKey(Mode)
})
/**
 * Options for an atomic whole-file write, including replacement and final mode controls.
 *
 * @category models
 * @since 0.1.0
 */
export type WriteFileOptions = typeof WriteFileSettings.Type & RelativeOptions
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
  /** Reads metadata, following the final symbolic link by default. */
  readonly stat: (path: PathInput, options?: RelativeOptions) => Effect.Effect<Metadata, FsError>
  /** Atomically moves an entry within this volume without replacing a non-empty directory. */
  readonly rename: (
    source: PathInput,
    destination: PathInput,
    options?: {
      /** Base directory for a relative source path. */
      readonly sourceRelativeTo?: DirectoryHandle
      /** Base directory for a relative destination path. */
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
      /** Base directory for a relative source path. */
      readonly sourceRelativeTo?: DirectoryHandle
      /** Base directory for a relative destination path. */
      readonly destinationRelativeTo?: DirectoryHandle
      /** Link to the final symbolic link's target instead of the link itself. */
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
      /** Requested mode before applying the caller's umask. Defaults to `0o777`. */
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
export const OverlayNodeKind = Schema.Literals(["directory", "file", "symlink"])
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
export const OverlayDifference = Schema.Literals([
  "content",
  "mode",
  "uid",
  "gid",
  "atimeNs",
  "mtimeNs",
  "ctimeNs",
  "birthtimeNs"
])
/**
 * A content, ownership, permission, or timestamp field that differs from the overlay base.
 *
 * @category models
 * @since 0.1.0
 */
export type OverlayDifference = typeof OverlayDifference.Type
const OverlayDifferences = Schema.Array(OverlayDifference)
const NonEmptyOverlayDifferences = OverlayDifferences.check(Schema.isMinLength(1))
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
export const OverlayChange = Schema.Union([
  Schema.TaggedStruct("Added", { path: BytePath, kind: OverlayNodeKind }),
  Schema.TaggedStruct("Removed", { path: BytePath, kind: OverlayNodeKind }),
  Schema.TaggedStruct("Replaced", {
    path: BytePath,
    beforeKind: OverlayNodeKind,
    afterKind: OverlayNodeKind,
    differences: OverlayDifferences
  }),
  Schema.TaggedStruct("Renamed", {
    from: BytePath,
    to: BytePath,
    kind: OverlayNodeKind,
    differences: OverlayDifferences
  }),
  Schema.TaggedStruct("Updated", { path: BytePath, kind: OverlayNodeKind, differences: NonEmptyOverlayDifferences })
])
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
export const OverlayChangesOptions = Schema.Struct({
  /** Include access, modification, change, and birth-time differences. Defaults to `false`. */
  includeTimestamps: Schema.optionalKey(Schema.Boolean)
})
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
export class CurrentFileSystem
  extends Context.Service<CurrentFileSystem, Caller>()("@effect-vfs/core/CurrentFileSystem")
{}

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
  const decoded = decodeConfiguration(
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
 */
export const inspectSnapshotDelta = Effect.fn("VirtualFileSystem.inspectSnapshotDelta")(function*(
  base: Snapshot,
  delta: SnapshotDeltaModel.SnapshotDelta,
  options?: SnapshotDeltaModel.SnapshotChangesOptions,
  limits?: SnapshotDeltaModel.SnapshotDeltaLimits
) {
  const decoded = decodeConfiguration(SnapshotDeltaModel.SnapshotChangesOptions, options ?? {})
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

const deltaSchemaIssue = (cause: ImageError, input: unknown, options: SchemaAST.ParseOptions) =>
  new SchemaIssue.InvalidValue(
    { message: `Snapshot delta ${cause.code}${cause.field === undefined ? "" : ` at ${cause.field}`}` },
    input,
    options
  )

/**
 * Creates an Effect Schema codec between owned bytes and opaque snapshot deltas.
 * Omission uses `SnapshotDeltaLimits.default`.
 */
export const SnapshotDeltaFromBytes = (limits?: SnapshotDeltaModel.SnapshotDeltaLimits) => {
  const selected = Schema.decodeResult(SnapshotDeltaModel.SnapshotDeltaLimits, { onExcessProperty: "error" })(
    limits ?? SnapshotDeltaModel.SnapshotDeltaLimits.default
  )
  return Schema.Uint8Array.pipe(
    Schema.decodeTo(
      SnapshotDeltaModel.SnapshotDelta,
      SchemaTransformation.transformOrFail({
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

const failure = (code: FsCode, operation: string, path?: PathInput) =>
  new FsError({ code, operation, ...(path === undefined ? {} : { path }) })

const ownedPath = (bytes: Uint8Array): BytePath => {
  return makeBytePath(bytes)
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
export const pathFromBytes = Effect.fn("VirtualFileSystem.pathFromBytes")(function*(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)) {
    return yield* failure("InvalidArgument", "pathFromBytes")
  }
  if (!attachedBuffer(bytes)) return yield* failure("InvalidArgument", "pathFromBytes")
  const owned = new Uint8Array(bytes)
  if (owned.length === 0 || owned.includes(0)) return yield* failure("InvalidArgument", "pathFromBytes")
  return makeBytePath(owned)
})

/**
 * Copies the bytes held by an opaque byte path.
 *
 * @category getters
 * @since 0.1.0
 */
export const pathToBytes = Effect.fn("VirtualFileSystem.pathToBytes")(function*(path: BytePath) {
  const bytes = getBytePathBytes(path)
  if (bytes === undefined) return yield* failure("InvalidArgument", "pathToBytes")
  return new Uint8Array(bytes)
})

interface Directory {
  readonly kind: "directory"
  readonly lineage: string | undefined
  parent: Directory | undefined
  readonly entries: Map<string, Node>
  metadata: Metadata
}
interface RegularFile {
  readonly kind: "file"
  readonly lineage: string | undefined
  data: Content.Content
  openCount: number
  metadata: Metadata
}
interface SymbolicLink {
  readonly kind: "symlink"
  readonly lineage: string | undefined
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
    bytes = getBytePathBytes(input)
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

type VolumeSource =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Snapshot"; readonly image: Image.Document }
  | {
    readonly _tag: "Overlay"
    readonly base: Snapshot
    readonly image: Image.Document
  }

/** Each execution constructs a fresh volume and captures its Clock. */
const makeVolume = Effect.fn("VirtualFileSystem.makeVolume")(
  function*(source: VolumeSource, options?: VolumeOptions) {
    const image = source._tag === "Empty" ? undefined : source.image
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
      lineage: image?.root,
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
            return yield* new ImageError({ code: "LimitExceeded", field: "maxFileBytes" })
          }
          content += length
        }
      }
      if (
        (settings.maxEntries !== undefined && count > settings.maxEntries) ||
        (settings.maxBytes !== undefined && content > settings.maxBytes)
      ) {
        return yield* new ImageError({ code: "LimitExceeded", field: "volume" })
      }
      const baseContents = source._tag === "Overlay" ? Content.forOverlay(source.base, image) : undefined
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
            : { kind: "directory", lineage: record.id, parent: undefined, entries: new Map(), metadata }
          node.metadata = metadata
          incoming.set(record.id, node)
        } else if (record.kind === "file") {
          const data = baseContents?.get(record.id) ?? Content.make(Image.bytes(record.data))
          incoming.set(record.id, {
            kind: "file",
            lineage: record.id,
            data,
            openCount: 0,
            metadata: { ...metadata, size: BigInt(data.bytes.length) }
          })
        } else {
          const target = Image.bytes(record.target)
          incoming.set(record.id, {
            kind: "symlink",
            lineage: record.id,
            target,
            metadata: { ...metadata, size: BigInt(target.length) }
          })
        }
      }
      for (const record of image.records) {
        if (record.kind !== "directory") continue
        const parent = incoming.get(record.id)
        if (parent?.kind !== "directory") return yield* new ImageError({ code: "InvalidStructure" })
        for (const entry of record.entries) {
          const node = incoming.get(entry.target)
          if (node === undefined) return yield* new ImageError({ code: "InvalidStructure" })
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

    const captureSnapshot = Effect.fnUntraced(function*() {
      const ids = new Map<Node, string>([[root, "0"]])
      const pending: Array<Node> = [root]
      const records: Array<Image.Record> = []
      for (let index = 0; index < pending.length; index++) {
        const node = pending[index]
        if (node === undefined) continue
        const id = ids.get(node)
        if (id === undefined) return yield* new ImageError({ code: "InvalidStructure" })
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
            children.push({ name: Image.base64(nameBytes(name)), target })
          }
          records.push({ id, kind: "directory", metadata, entries: children })
        } else if (node.kind === "file") {
          records.push({ id, kind: "file", metadata, data: Image.base64(node.data.bytes) })
        } else records.push({ id, kind: "symlink", metadata, target: Image.base64(node.target) })
      }

      return yield* Image.capture({ format: "effect-vfs", version: 1, root: "0", records })
    })

    const observeChanges = () => {
      const observation: Array<ObservationEntry> = []
      const paths: Array<readonly [Node, Uint8Array]> = [[root, new Uint8Array([47])]]
      for (let index = 0; index < paths.length; index++) {
        const current = paths[index]
        if (current === undefined) continue
        const [node, path] = current
        observation.push({
          path: new Uint8Array(path),
          lineage: node.lineage,
          kind: node.kind,
          content: node.kind === "file" ? node.data.bytes : node.kind === "symlink" ? node.target : undefined,
          metadata: storedMetadata(node.metadata)
        })
        if (node.kind !== "directory") continue
        for (const [name, child] of node.entries) {
          const bytes = nameBytes(name)
          const childPath = new Uint8Array(path.length + (path.length === 1 ? 0 : 1) + bytes.length)
          childPath.set(path)
          let offset = path.length
          if (path.length !== 1) childPath[offset++] = 47
          childPath.set(bytes, offset)
          paths.push([child, childPath])
        }
      }
      return observation
    }

    const captureState = Effect.fnUntraced(function*(hook?: OverlayTesting.ObservationHook) {
      const snapshot = yield* captureSnapshot()
      if (hook !== undefined) yield* hook.betweenSnapshotAndSummary
      return { snapshot, observation: observeChanges() }
    })

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
        usedBytes -= file.data.bytes.length
        file.data = Content.empty()
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
    const resize = Effect.fnUntraced(function*(file: RegularFile, length: bigint, operation: string) {
      if (typeof length !== "bigint" || length < 0n) return yield* failure("InvalidArgument", operation)
      if (length > BigInt(maxFileBytes)) return yield* failure("FileTooLarge", operation)
      const size = Number(length)
      if (size - file.data.bytes.length > (settings.maxBytes ?? Number.MAX_SAFE_INTEGER) - usedBytes) {
        return yield* failure("NoSpace", operation)
      }
      const data = new Uint8Array(size)
      data.set(file.data.bytes.subarray(0, size))
      const now = yield* timestamp(operation)
      usedBytes += size - file.data.bytes.length
      file.data = Content.make(data)
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
      const read = Effect.fnUntraced(function*(maximum: number, position?: bigint) {
        const file = yield* get(position === undefined ? "read" : "pread", "read")
        if (!Schema.is(Natural)(maximum)) return yield* failure("InvalidArgument", "read")
        const offset = position ?? ref.offset
        if (typeof offset !== "bigint" || offset < 0n || offset > 0x7fffffffffffffffn) {
          return yield* failure("InvalidArgument", "read")
        }
        const start = Number(offset > file.metadata.size ? file.metadata.size : offset)
        const data = file.data.bytes.slice(start, start + Math.min(maximum, file.data.bytes.length - start))
        if (maximum > 0) {
          file.metadata = { ...file.metadata, atimeNs: (yield* timestamp("read")) }
        }
        if (position === undefined) ref.offset += BigInt(data.length)
        return data
      }, coordinated)
      const write = Effect.fnUntraced(function*(input: Uint8Array, position?: bigint) {
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
          const end = Math.min(maxFileBytes, file.data.bytes.length + free)
          const count = Math.min(bytes.length, Math.max(0, end - start))
          if (count === 0) return yield* failure("NoSpace", "write")
          const size = Math.max(file.data.bytes.length, start + count)
          // Always detach before mutation. A same-sized write is the critical
          // case: the current payload may belong to the base or a prior capture.
          const data = new Uint8Array(size)
          data.set(file.data.bytes)
          const now = yield* timestamp("write")
          data.set(bytes.subarray(0, count), start)
          usedBytes += size - file.data.bytes.length
          file.data = Content.make(data)
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
        stat: coordinated(Effect.gen(function*() {
          return { ...(yield* get("stat")).metadata }
        })).pipe(Effect.withSpan("FileHandle.stat")),
        sync: coordinated(Effect.suspend(() => Effect.asVoid(get("sync")))).pipe(Effect.withSpan("FileHandle.sync")),
        close: coordinated(Effect.gen(function*() {
          yield* get("close")
          releaseFile(ref)
        })).pipe(Effect.withSpan("FileHandle.close"))
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

      const acquireDirectory = Effect.fnUntraced(
        function*(input: PathInput, options: RelativeOptions | undefined, operation: string) {
          const prepared = preparePath(input, operation, settings.maxPathBytes)
          const base = options?.relativeTo
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
        }
      )

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
            const data = new Uint8Array(node.data.bytes)
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
              const previous = file?.data.bytes.length ?? 0
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
              let data = captured
              if (position !== 0 || size !== captured.length) {
                data = new Uint8Array(size)
                if (file !== undefined && !chosen.truncate) data.set(file.data.bytes)
                data.set(captured, position)
              }
              const now = yield* timestamp("writeFile")
              const node: RegularFile = file ??
                {
                  kind: "file",
                  lineage: undefined,
                  data: Content.make(data),
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
              node.data = Content.make(data)
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
          const rawTarget = typeof target === "string" ? new TextEncoder().encode(target) : getBytePathBytes(target)
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
              lineage: undefined,
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
                lineage: undefined,
                data: Content.empty(),
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
                lineage: undefined,
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
            stat: coordinated(Effect.suspend(() =>
              acquired.directory === undefined
                ? Effect.fail(failure("InvalidHandle", "stat"))
                : Effect.succeed({ ...acquired.directory.metadata })
            )).pipe(Effect.withSpan("DirectoryHandle.stat")),
            close: coordinated(Effect.suspend(() => {
              if (acquired.directory === undefined) return Effect.fail(failure("InvalidHandle", "close"))
              acquired.directory = undefined
              acquired.closed = true
              return Effect.void
            })).pipe(Effect.withSpan("DirectoryHandle.close"))
          })
          handles.set(handle, acquired)
          return handle
        })
      })
    }

    const baseObservation = source._tag === "Overlay" ? observeChanges() : undefined
    const publicChange = (change: RawOverlayChange): OverlayChange => {
      switch (change._tag) {
        case "Added":
        case "Removed":
        case "Updated":
        case "Replaced":
          return Object.freeze({ ...change, path: ownedPath(new Uint8Array(change.path)) })
        case "Renamed":
          return Object.freeze({
            ...change,
            from: ownedPath(new Uint8Array(change.from)),
            to: ownedPath(new Uint8Array(change.to))
          })
      }
      throw new Error("Unknown internal overlay change")
    }
    const publicChanges = (changes: ReadonlyArray<RawOverlayChange>): ReadonlyArray<OverlayChange> =>
      Object.freeze(changes.map(publicChange))
    const changeOptions = (options?: OverlayChangesOptions) => {
      const decoded = decodeConfiguration(OverlayChangesOptions, options === undefined ? {} : options)
      return Result.isFailure(decoded) ? Effect.fail(decoded.failure) : Effect.succeed(decoded.success)
    }
    const volume: Volume = Object.freeze({
      [VolumeId]: true as const,
      watch: Effect.gen(function*() {
        const subscription = yield* PubSub.subscribe(events)
        subscribers += 1
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            subscribers -= 1
          })
        )
        return Stream.fromEffectRepeat(PubSub.take(subscription))
      }).pipe(Effect.withSpan("Volume.watch")),
      snapshot: coordinated(captureSnapshot()).pipe(Effect.withSpan("Volume.snapshot")),

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
    if (source._tag !== "Overlay" || baseObservation === undefined) {
      return { _tag: "Volume" as const, volume }
    }
    const hook = OverlayTesting.getObservationHook(source.base)
    const overlay: OverlayVolume = Object.freeze({
      ...volume,
      changes: Effect.fn("OverlayVolume.changes")(function*(options?: OverlayChangesOptions) {
        const selected = yield* changeOptions(options)
        const current = yield* coordinated(Effect.sync(observeChanges))
        return publicChanges(compareOverlay(baseObservation, current, selected.includeTimestamps ?? false))
      }),
      capture: Effect.fn("OverlayVolume.capture")(function*(options?: OverlayChangesOptions) {
        const selected = yield* changeOptions(options)
        const current = yield* coordinated(captureState(hook))
        return Object.freeze({
          snapshot: current.snapshot,
          changes: publicChanges(
            compareOverlay(baseObservation, current.observation, selected.includeTimestamps ?? false)
          )
        })
      })
    })
    return { _tag: "Overlay" as const, volume: overlay }
  }
)

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
export const make = Effect.fn("VirtualFileSystem.make")(function*(options?: VolumeOptions) {
  const result = yield* makeVolume({ _tag: "Empty" }, options).pipe(Effect.catchTag("ImageError", Effect.die))
  if (result._tag === "Overlay") return yield* Effect.die(new Error("empty volume constructed as overlay"))
  return result.volume
})
/**
 * Restores a fresh volume from an opaque snapshot under the supplied destination limits.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromSnapshot = Effect.fn("VirtualFileSystem.fromSnapshot")(
  function*(snapshot: Snapshot, options?: VolumeOptions) {
    const image = yield* Image.inspect(snapshot)
    const result = yield* makeVolume({ _tag: "Snapshot", image }, options)
    if (result._tag === "Overlay") return yield* new ImageError({ code: "InvalidStructure" })
    return result.volume
  }
)

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
export const makeOverlay = Effect.fn("VirtualFileSystem.makeOverlay")(
  function*(base: Snapshot, options?: VolumeOptions): Effect.fn.Return<OverlayVolume, ConfigurationError | ImageError> {
    const image = yield* Image.inspect(base)
    const result = yield* makeVolume(
      { _tag: "Overlay", base, image },
      options
    )
    if (result._tag === "Volume") return yield* new ImageError({ code: "InvalidStructure" })
    return result.volume
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
/**
 * A complete filesystem fixture accepted by `fromFixture`.
 *
 * @category models
 * @since 0.1.0
 */
export type Fixture = typeof Fixture.Type
/**
 * Builds a fresh volume from a validated final-state fixture.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromFixture = Effect.fn("VirtualFileSystem.fromFixture")(
  function*(fixture: Fixture, options?: VolumeOptions) {
    const config = decodeConfiguration(VolumeOptions, options ?? {})
    if (Result.isFailure(config)) return yield* config.failure
    const decoded = Schema.decodeResult(Fixture, { onExcessProperty: "error" })(fixture)
    if (Result.isFailure(decoded)) return yield* new ImageError({ code: "InvalidStructure", field: "fixture" })
    const source = decoded.success
    for (const entry of source.entries) {
      if (
        entry.kind === "file" && (!(entry.bytes.buffer instanceof ArrayBuffer) || !attachedBuffer(entry.bytes))
      ) return yield* new ImageError({ code: "InvalidEncoding", field: "bytes" })
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
    // All byte inputs become immutable strings before the first successful suspension.
    for (const entry of source.entries) {
      const parsed = fixturePath(entry.path)
      if (Result.isFailure(parsed)) {
        return yield* new ImageError({ code: "InvalidStructure", field: "path" })
      }
      const components = parsed.success
      const key = components.join("/")
      if (paths.has(key)) return yield* new ImageError({ code: "InvalidStructure", field: "duplicate" })
      paths.set(key, components)
      if (entry.kind === "hardLink") {
        const target = fixturePath(entry.target)
        if (Result.isFailure(target)) return yield* new ImageError({ code: "InvalidStructure", field: "target" })
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
          data: Image.base64(entry.bytes)
        })
      } else {
        if (typeof entry.target === "string" && !wellFormed(entry.target)) {
          return yield* new ImageError({
            code: "InvalidEncoding",
            field: "target"
          })
        }
        const target = typeof entry.target === "string"
          ? new TextEncoder().encode(entry.target)
          : getBytePathBytes(entry.target)
        if (target === undefined || target.includes(0)) {
          return yield* new ImageError({
            code: "InvalidStructure",
            field: "target"
          })
        }
        declarations.set(key, {
          id: String(paths.size),
          kind: "symlink",
          metadata: metadata("symlink", entry.metadata),
          target: Image.base64(target)
        })
      }
    }
    for (const [key] of aliases) {
      let target = key
      const seen = new Set<string>()
      while (!declarations.has(target)) {
        if (seen.has(target)) return yield* new ImageError({ code: "InvalidStructure", field: "hardLink" })
        seen.add(target)
        const next = aliases.get(target)
        if (next === undefined) return yield* new ImageError({ code: "InvalidStructure", field: "hardLink" })
        target = next
      }
      const node = declarations.get(target)
      if (node === undefined || node.kind === "directory") {
        return yield* new ImageError({
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
        return yield* new ImageError({ code: "InvalidStructure", field: "parent" })
      }
      const entries = children.get(parent.id) ?? []
      entries.push({ name: Image.base64(nameBytes(name)), target: child.id })
      children.set(parent.id, entries)
    }
    const records = [...new Set(declarations.values())].map((record): Image.Record =>
      record.kind === "directory" ? { ...record, entries: children.get(record.id) ?? [] } : record
    )
    const snapshot = yield* Image.capture({ format: "effect-vfs", version: 1, root: "root", records })
    const image = yield* Image.inspect(snapshot)
    const result = yield* makeVolume({ _tag: "Snapshot", image }, config.success)
    if (result._tag === "Overlay") return yield* new ImageError({ code: "InvalidStructure" })
    return result.volume
  }
)
