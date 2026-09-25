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
import type * as ByteSize from "effect/ByteSize"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as Order from "effect/Order"
import type * as PlatformError from "effect/PlatformError"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as SchemaAST from "effect/SchemaAST"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaTransformation from "effect/SchemaTransformation"
import type * as Scope from "effect/Scope"
import type * as Stream from "effect/Stream"
import type { BytePath } from "./BytePath.js"
import type { CallerId, ObjectReferenceId } from "./Caller.js"
import * as CallerModule from "./Caller.js"
import type { DirectoryHandleId, FileHandleId } from "./FileHandle.js"
import * as FileHandleModule from "./FileHandle.js"
import * as FixtureModule from "./Fixture.js"
import * as MetadataModule from "./Metadata.js"
import type { Entry, EntryInput, Target, TargetInput } from "./Target.js"
import type { ArgumentFailure, FsFailure, ImageFailure, VfsError } from "./VfsError.js"
import * as VfsErrorModule from "./VfsError.js"
import type { VolumeId } from "./Volume.js"
import * as VolumeModule from "./Volume.js"
import * as WatchModule from "./Watch.js"

export {
  Entry,
  type EntryInput,
  isEntry,
  isTarget,
  Name,
  type NameInput,
  type PathTarget,
  Target,
  type TargetInput
} from "./Target.js"

export { BytePath } from "./BytePath.js"

import type { DecodeLimits, Snapshot } from "./Snapshot.js"

export { DecodeLimits, type Snapshot, SnapshotTypeId } from "./Snapshot.js"

import { decodeConfiguration, retargetFailure } from "./internal/errors.js"
import * as FixtureInternal from "./internal/fixture.js"
import * as Image from "./internal/image.js"
import * as Path from "./internal/path.js"
import * as SnapshotDeltaInternal from "./internal/snapshotDelta.js"
import * as VfsModel from "./internal/virtualFileSystem.js"
import * as SnapshotDeltaModel from "./SnapshotDelta.js"

export {
  SnapshotChange,
  SnapshotChangesOptions,
  type SnapshotDelta,
  SnapshotDeltaLimits,
  SnapshotDeltaTypeId,
  SnapshotDifference,
  SnapshotNodeKind
} from "./SnapshotDelta.js"

/**
 * A UTF-8 string path or an opaque byte-preserving path.
 *
 * **Details**
 *
 * Every operation accepts both. Pass a string unless a name is not valid UTF-8;
 * strings are the normal case and byte paths are the escape hatch.
 *
 * @see {@link BytePath} for the byte-preserving form.
 * @category models
 * @since 0.1.0
 */
export type PathInput = string | BytePath

/**
 * Schema for portable virtual filesystem error codes.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import { Effect, Schema } from "effect"
 *
 * const asCode = Schema.decodeUnknownEffect(Vfs.FsCode)
 *
 * // Useful when a code has crossed a process boundary and arrives back as data.
 * const program = Effect.gen(function*() {
 *   const payload = JSON.parse(`{"code":"NotFound","other":"Nonsense"}`)
 *
 *   const known = yield* asCode(payload.code)
 *
 *   const unknown = yield* asCode(payload.other).pipe(
 *     Effect.orElseSucceed(() => "not a code")
 *   )
 *
 *   return [known, unknown]
 * })
 *
 * Effect.runPromise(program).then(console.log)
 * // [ 'NotFound', 'not a code' ]
 * ```
 *
 * @category schemas
 * @since 0.1.0
 */
export const FsCode: typeof VfsErrorModule.FsCode = VfsErrorModule.FsCode

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
 * Durable providers distinguish `StorageRejected` (the operation definitely did not commit),
 * `OutcomeUnknown` (it may have committed), and `VolumeUnavailable` (the provider cannot safely
 * serve further operations until recovery). Built-in memory volumes never emit these codes.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const caller = yield* (yield* Vfs.make()).caller()
 *
 *   // Every filesystem operation fails with this one tagged error; `code`
 *   // distinguishes the cases, so match on it rather than on the tag alone.
 *   return yield* caller.readFile("/missing").pipe(
 *     Effect.catchTag("VfsError", (error) =>
 *       error.code === "NotFound"
 *         ? Effect.succeed(new Uint8Array())
 *         : Effect.fail(error))
 *   )
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // Uint8Array(0) []
 * ```
 *
 * @category errors
 * @since 0.1.0
 */

/**
 * Describes an invalid volume or caller option and names the rejected field.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * // `field` names the rejected option, so the caller learns which key was wrong.
 * const program = Effect.gen(function*() {
 *   // Options that arrived from a config file or CLI flag, not a literal.
 *   const options = JSON.parse(`{"maxEntries":-1}`) as Vfs.VolumeOptions
 *
 *   return yield* Vfs.make(options).pipe(
 *     Effect.as("ok"),
 *     Effect.catchTag("VfsError", (error) => Effect.succeed(`rejected ${error.field}`))
 *   )
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // rejected maxEntries
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export {
  type ArgumentFailure,
  DeltaCode,
  type FsFailure,
  ImageCode,
  type ImageFailure,
  StoreCode,
  type StoreFailure,
  VfsCode,
  VfsError
} from "./VfsError.js"

/**
 * Schema for a caller's numeric identity, supplementary groups, and explicit privilege.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Identity: typeof CallerModule.Identity = CallerModule.Identity

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
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const volume = yield* Vfs.make()
 *
 *   // Omitting `identity` yields a privileged root caller.
 *   const root = yield* volume.caller({ umask: 0 })
 *   const user = yield* volume.caller({
 *     identity: { uid: 1000, gid: 1000, groups: [], privileged: false },
 *     umask: 0o022
 *   })
 *
 *   yield* root.mkdir("/home", { mode: 0o777 })
 *
 *   // The umask clears its bits from the requested mode.
 *   yield* user.mkdir("/home/user", { mode: 0o777 })
 *
 *   return ((yield* user.stat("/home/user")).mode & 0o777).toString(8)
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // 755
 * ```
 *
 * @category schemas
 * @since 0.1.0
 */
export const RootCallerOptions: typeof CallerModule.RootCallerOptions = CallerModule.RootCallerOptions

/**
 * Options for creating a root caller on a volume.
 *
 * @category models
 * @since 0.1.0
 */
export type RootCallerOptions = typeof RootCallerOptions.Type

/**
 * Schema for the failure boundary survived by an acknowledged volume write.
 *
 * @category schemas
 * @since 0.1.0
 */
export const VolumeDurability: typeof VolumeModule.VolumeDurability = VolumeModule.VolumeDurability

/**
 * The failure boundary survived by an acknowledged volume write.
 *
 * @category models
 * @since 0.1.0
 */
export type VolumeDurability = typeof VolumeDurability.Type

/**
 * Weakest-to-strongest ordering for volume durability guarantees.
 *
 * @category ordering
 * @since 0.1.0
 */
export const VolumeDurabilityOrder: Order.Order<VolumeDurability> = VolumeModule.VolumeDurabilityOrder

/**
 * Returns whether `actual` survives at least the failure boundary required by `required`.
 *
 * @category predicates
 * @since 0.1.0
 */
export const isVolumeDurabilityAtLeast: (
  actual: VolumeDurability,
  required: VolumeDurability
) => boolean = VolumeModule.isVolumeDurabilityAtLeast

/**
 * Schema for the stable logical identity of a volume.
 *
 * @category schemas
 * @since 0.1.0
 */
export const VolumeIdentity: typeof VolumeModule.VolumeIdentity = VolumeModule.VolumeIdentity

/**
 * Stable logical identity of a volume as a branded 128-bit lowercase hexadecimal string.
 *
 * @category models
 * @since 0.1.0
 */
export type VolumeIdentity = typeof VolumeIdentity.Type

/**
 * Schema for one uninterrupted storage lifetime of a volume.
 *
 * @category schemas
 * @since 0.1.0
 */
export const VolumeIncarnation: typeof VolumeModule.VolumeIncarnation = VolumeModule.VolumeIncarnation

/**
 * One uninterrupted storage lifetime as a branded 128-bit lowercase hexadecimal string.
 *
 * @category models
 * @since 0.1.0
 */
export type VolumeIncarnation = typeof VolumeIncarnation.Type

/**
 * Schema for optional volume capacity and path limits.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { ByteSize, Effect } from "effect"
 *
 * // Every limit is optional, and each one is enforced once set.
 * const program = Effect.gen(function*() {
 *   const volume = yield* Vfs.make({ maxFileBytes: ByteSize.bytes(4) })
 *   const caller = yield* volume.caller()
 *
 *   return yield* caller.writeFile("/big.bin", new Uint8Array(16), {
 *     access: "write",
 *     create: "exclusive"
 *   }).pipe(
 *     Effect.as("written"),
 *     Effect.catchTag("VfsError", (error) => Effect.succeed(error.code))
 *   )
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // FileTooLarge
 * ```
 *
 * @category schemas
 * @since 0.1.0
 */
export const VolumeOptions: typeof VolumeModule.VolumeOptions = VolumeModule.VolumeOptions

/**
 * Capacity, admission, watch retention, and path limits for a volume.
 * `maxPendingOperations` defaults to 64 and `maxWatchEvents` defaults to 256.
 *
 * @category models
 * @since 0.1.0
 */
export type VolumeOptions = typeof VolumeOptions.Type

/**
 * Effective capacity and path limits of a live volume. An absent limit is unlimited.
 * `maxFileBytes` always includes the engine's maximum representable file size.
 *
 * @category models
 * @since 0.1.0
 */
export interface VolumeLimits {
  readonly maxBytes: ByteSize.ByteSize | undefined
  readonly maxFileBytes: ByteSize.ByteSize
  readonly maxEntries: number | undefined
  readonly maxPathBytes: ByteSize.ByteSize | undefined
  /** Waiting budget; at most this many plus one callers are admitted at once. */
  readonly maxPendingOperations: number
  /** Maximum retained events per watch subscriber, including the rescan marker. */
  readonly maxWatchEvents: number
}

/**
 * Live logical content and directory-entry usage of a volume.
 * Open unlinked files remain in `usedBytes` until their last handle closes.
 *
 * @category models
 * @since 0.1.0
 */
export interface VolumeUsage {
  readonly usedBytes: bigint
  readonly entries: number
}

/**
 * Schema for filesystem node metadata with bigint inode, size, and nanosecond fields.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * // Sizes and inode numbers are bigint; times are nanosecond timestamps.
 * const program = Effect.gen(function*() {
 *   const caller = yield* (yield* Vfs.make()).caller()
 *
 *   yield* caller.writeFile("/f", new Uint8Array([1, 2, 3]), {
 *     access: "write",
 *     create: "exclusive"
 *   })
 *
 *   const metadata = yield* caller.stat("/f")
 *
 *   return [metadata.kind, metadata.size, metadata.nlink]
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // [ 'file', 3n, 1 ]
 * ```
 *
 * @category schemas
 * @since 0.1.0
 */
export const Metadata: typeof MetadataModule.Metadata = MetadataModule.Metadata

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
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * // References survive renames, and each observation carries the revision it
 * // matched, so a caller can tell whether what it read is still current.
 * const program = Effect.gen(function*() {
 *   const caller = yield* (yield* Vfs.make()).caller()
 *
 *   yield* caller.mkdir("/work")
 *
 *   const root = yield* caller.root
 *   const work = yield* caller.lookup(Vfs.Entry(root, "work"))
 *
 *   const before = yield* caller.stat(work)
 *
 *   yield* caller.rename("/work", "/moved")
 *
 *   const after = yield* caller.stat(work)
 *
 *   return [before.kind, after.kind, after.revision > before.revision]
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // [ 'directory', 'directory', true ]
 * ```
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
 * A directory revision transition captured inside one coordinated operation.
 *
 * @category schemas
 * @since 0.4.0
 */
export const DirectoryChange: typeof CallerModule.DirectoryChange = CallerModule.DirectoryChange

/**
 * A directory revision transition captured inside one coordinated operation.
 *
 * @category models
 * @since 0.4.0
 */
export type DirectoryChange = typeof DirectoryChange.Type

/**
 * The identity and parent-directory transition produced by a named entry mutation.
 *
 * @category models
 * @since 0.4.0
 */
export interface ReferenceEntryResult {
  readonly reference: ObjectReference
  readonly directory: DirectoryChange
}

/**
 * The directory transitions produced by a same-directory or cross-directory rename.
 *
 * @category schemas
 * @since 0.4.0
 */
export const RenameReferenceResult: typeof CallerModule.RenameReferenceResult = CallerModule.RenameReferenceResult

/**
 * The directory transitions produced by a same-directory or cross-directory rename.
 *
 * @category models
 * @since 0.4.0
 */
export type RenameReferenceResult = typeof RenameReferenceResult.Type

/**
 * Schema for an owner update. Omitted fields retain their existing values.
 *
 * @category schemas
 * @since 0.1.0
 */
export const OwnerUpdate: typeof MetadataModule.OwnerUpdate = MetadataModule.OwnerUpdate

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
export const TimeUpdate: typeof MetadataModule.TimeUpdate = MetadataModule.TimeUpdate

/**
 * Schema for independent access and modification time updates.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const caller = yield* (yield* Vfs.make()).caller()
 *
 *   yield* caller.writeFile("/f", new Uint8Array([1]), {
 *     access: "write",
 *     create: "exclusive"
 *   })
 *
 *   // Each field is set to a value, to the current clock, or left alone.
 *   yield* caller.utimes("/f", {
 *     access: { kind: "value", nanoseconds: 1_000n },
 *     modification: { kind: "omit" }
 *   })
 *
 *   const metadata = yield* caller.stat("/f")
 *
 *   return [metadata.atimeNs, metadata.mtimeNs === 1_000n]
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // [ 1000n, false ]
 * ```
 *
 * @category schemas
 * @since 0.1.0
 */
export const Times: typeof MetadataModule.Times = MetadataModule.Times

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
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * // The handle anchors relative paths to the directory itself, so a rename in
 * // between does not send the write somewhere else.
 * const program = Effect.gen(function*() {
 *   const caller = yield* (yield* Vfs.make()).caller()
 *
 *   yield* caller.mkdir("/project")
 *
 *   const directory = yield* caller.openDirectory("/project")
 *
 *   yield* caller.rename("/project", "/renamed")
 *   yield* caller.writeFile(Vfs.Target.Path({ path: "notes.txt", relativeTo: directory }), new TextEncoder().encode("kept"), {
 *     access: "write",
 *     create: "exclusive"
 *   })
 *
 *   return (yield* caller.readDirectory("/renamed")).value.map((entry) => new TextDecoder().decode(entry.name))
 * }).pipe(Effect.scoped)
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // [ 'notes.txt' ]
 * ```
 *
 * @category models
 * @since 0.1.0
 */
export interface DirectoryHandle {
  readonly [DirectoryHandleId]: true
  readonly stat: Effect.Effect<Metadata, FsFailure>
  readonly close: Effect.Effect<void, FsFailure>
}

/**
 * Schema for file seek origins, including dense-file data and hole queries.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SeekMode: typeof FileHandleModule.SeekMode = FileHandleModule.SeekMode

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
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * // `access` is required; `create` decides whether a missing file is an error.
 * const program = Effect.gen(function*() {
 *   const caller = yield* (yield* Vfs.make()).caller()
 *
 *   const handle = yield* caller.open("/log.txt", {
 *     access: "readWrite",
 *     create: "ifMissing",
 *     append: true
 *   })
 *
 *   yield* handle.write(new Uint8Array([1, 2]))
 *
 *   return (yield* handle.stat).size
 * }).pipe(Effect.scoped)
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // 2n
 * ```
 *
 * @category schemas
 * @since 0.1.0
 */
export const OpenOptions: typeof CallerModule.OpenOptions = CallerModule.OpenOptions

/**
 * Options of `open` on a target.
 *
 * @category models
 * @since 0.1.0
 */
export type OpenOptions = typeof OpenOptions.Type

/**
 * Settings for creating a directory through a parent object reference.
 * `exactMode` skips the caller's umask for an explicit creation mode; permission policy still applies.
 *
 * @category schemas
 * @since 0.4.0
 */
export const MkdirOptions: typeof CallerModule.MkdirOptions = CallerModule.MkdirOptions

/**
 * Settings for creating a directory through a parent object reference.
 * `exactMode` skips the caller's umask for an explicit creation mode; permission policy still applies.
 *
 * @category models
 * @since 0.4.0
 */
export type MkdirOptions = typeof MkdirOptions.Type

/**
 * Settings for creating a symbolic link through a parent object reference.
 *
 * @category schemas
 * @since 0.4.0
 */
export const SymlinkOptions: typeof CallerModule.SymlinkOptions = CallerModule.SymlinkOptions

/**
 * Settings for creating a symbolic link through a parent object reference.
 *
 * @category models
 * @since 0.4.0
 */
export type SymlinkOptions = typeof SymlinkOptions.Type

/**
 * Settings for atomically looking up or creating and opening one referenced child.
 * `exactMode` skips the caller's umask for an explicit creation mode; permission policy still applies.
 *
 * @category schemas
 * @since 0.4.0
 */
export const OpenEntryOptions: typeof CallerModule.OpenEntryOptions = CallerModule.OpenEntryOptions

/**
 * Settings for atomically looking up or creating and opening one referenced child.
 * `exactMode` skips the caller's umask for an explicit creation mode; permission policy still applies.
 * Initial mode, times, `initialSize`, and owner apply only to a newly created file.
 * `expectedChild: null` requires an absent direct child. An observation requires
 * the same direct object, revision, and timestamps; a mismatch fails with
 * `StaleReference` before changing the file. Omission skips this observation check.
 * This condition checks the named entry before any final symbolic-link traversal.
 *
 * @category models
 * @since 0.4.0
 */
export type OpenEntryOptions = typeof OpenEntryOptions.Type

/**
 * A scoped child-open result captured inside one coordinated operation.
 *
 * @category models
 * @since 0.4.0
 */
export interface OpenEntryResult {
  readonly handle: FileHandle
  readonly reference: ObjectReference
  readonly created: boolean
  readonly directory: DirectoryChange
}

/**
 * Options for an atomic whole-file write, including replacement and final mode controls.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const caller = yield* (yield* Vfs.make()).caller()
 *   const bytes = new TextEncoder().encode("v2")
 *
 *   // `access` is required. `create: "exclusive"` refuses to replace an entry,
 *   // while `truncate` overwrites one that already exists.
 *   yield* caller.writeFile("/app.conf", new TextEncoder().encode("v1"), {
 *     access: "write",
 *     create: "exclusive",
 *     mode: 0o640
 *   })
 *
 *   const refused = yield* caller.writeFile("/app.conf", bytes, {
 *     access: "write",
 *     create: "exclusive"
 *   }).pipe(
 *     Effect.as("replaced"),
 *     Effect.catchTag("VfsError", (error) => Effect.succeed(error.code))
 *   )
 *
 *   yield* caller.writeFile("/app.conf", bytes, { access: "write", truncate: true })
 *
 *   return [refused, new TextDecoder().decode(yield* caller.readFile("/app.conf"))]
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // [ 'AlreadyExists', 'v2' ]
 * ```
 *
 * @category models
 * @since 0.1.0
 */
export const WriteFileOptions: typeof CallerModule.WriteFileOptions = CallerModule.WriteFileOptions

/**
 * Options of `writeFile`.
 *
 * @category models
 * @since 0.1.0
 */
export type WriteFileOptions = typeof WriteFileOptions.Type

/**
 * The bytes a positional read returned and whether they reach the end of the file.
 *
 * @category models
 * @since 0.6.0
 */
export interface ReadResult {
  readonly bytes: Uint8Array
  readonly eof: boolean
}

/**
 * A scoped regular-file capability with an independent bigint cursor.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const caller = yield* (yield* Vfs.make()).caller()
 *
 *   const handle = yield* caller.open("/data.bin", {
 *     access: "readWrite",
 *     create: "exclusive"
 *   })
 *
 *   yield* handle.write(new Uint8Array([1, 2, 3, 4]))
 *
 *   // `pread` reads at an offset and leaves the cursor where writing left it.
 *   const slice = yield* handle.pread(2, 1n)
 *
 *   return [slice.bytes, slice.eof, yield* handle.seek(0n, "current")]
 * }).pipe(Effect.scoped)
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // [ Uint8Array(2) [ 2, 3 ], false, 4n ]
 * ```
 *
 * @category models
 * @since 0.1.0
 */
export interface FileHandle {
  readonly [FileHandleId]: true
  /** Reads up to `maximumBytes` from the cursor and advances it by the returned length. */
  readonly read: (maximumBytes: number) => Effect.Effect<Uint8Array, FsFailure>
  /** Reads at `offset` without changing the cursor. */
  readonly pread: (maximumBytes: number, offset: bigint) => Effect.Effect<ReadResult, FsFailure>
  /** Writes at the cursor and advances it, or writes at end of file when opened for append. */
  readonly write: (bytes: Uint8Array) => Effect.Effect<number, FsFailure>
  /** Writes at `offset` without changing the cursor. Append mode does not affect positional writes. */
  readonly pwrite: (bytes: Uint8Array, offset: bigint) => Effect.Effect<number, FsFailure>
  /** Moves the cursor and returns its new offset. `data` finds content and `hole` finds end of file. */
  readonly seek: (offset: bigint, mode: SeekMode) => Effect.Effect<bigint, FsFailure>
  /** Sets the file length without changing the cursor. */
  readonly truncate: (length: bigint) => Effect.Effect<void, FsFailure>
  /** Reads metadata for the open file. */
  readonly stat: Effect.Effect<Metadata, FsFailure>
  /** Checks handle and provider health. Durable mutations have already committed; memory volumes have nothing to flush. */
  readonly sync: Effect.Effect<void, FsFailure>
  /** Closes the handle. A repeated explicit close fails; scope cleanup remains safe. */
  readonly close: Effect.Effect<void, FsFailure>
}

/**
 * A filesystem caller with its own identity, creation mask, and current directory.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * // Whole-file reads and writes need no scope. `writeFile` always takes an
 * // options bag; `access` is required and `create` decides what a missing file means.
 * const program = Effect.gen(function*() {
 *   const volume = yield* Vfs.make()
 *   const caller = yield* volume.caller()
 *
 *   yield* caller.mkdir("/work")
 *   yield* caller.writeFile("/work/notes.txt", new TextEncoder().encode("hello"), {
 *     access: "write",
 *     create: "exclusive"
 *   })
 *
 *   return (yield* caller.readDirectory("/work")).value.map((entry) => new TextDecoder().decode(entry.name))
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // [ 'notes.txt' ]
 * ```
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * // Reach for a handle when a whole-file write will not do. A handle carries a
 * // cursor and lives until its scope closes.
 * const program = Effect.gen(function*() {
 *   const caller = yield* (yield* Vfs.make()).caller()
 *
 *   const handle = yield* caller.open("/log.txt", {
 *     access: "readWrite",
 *     create: "exclusive"
 *   })
 *
 *   yield* handle.write(new TextEncoder().encode("first "))
 *   yield* handle.write(new TextEncoder().encode("second"))
 *   yield* handle.seek(0n, "start")
 *
 *   return new TextDecoder().decode(yield* handle.read(64))
 * }).pipe(Effect.scoped)
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // first second
 * ```
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * // A derived caller holds the directory's identity, not its path, so renaming
 * // the directory does not redirect later relative writes.
 * const program = Effect.gen(function*() {
 *   const caller = yield* (yield* Vfs.make()).caller()
 *
 *   yield* caller.mkdir("/build")
 *
 *   const work = yield* caller.withDirectory("/build")
 *
 *   yield* caller.rename("/build", "/dist")
 *   yield* work.writeFile("out.txt", new TextEncoder().encode("done"), {
 *     access: "write",
 *     create: "exclusive"
 *   })
 *
 *   return (yield* caller.readDirectory("/dist")).value.map((entry) => new TextDecoder().decode(entry.name))
 * }).pipe(Effect.scoped)
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // [ 'out.txt' ]
 * ```
 *
 * @see The filesystem model at `/concepts/filesystem-model`.
 * @category models
 * @since 0.1.0
 */
export interface Caller {
  readonly [CallerId]: true
  /** The reference of the volume's root directory. */
  readonly root: Effect.Effect<ObjectReference, FsFailure>
  /** The reference of a child of a directory, without following it. */
  readonly lookup: (entry: EntryInput) => Effect.Effect<ObjectReference, FsFailure>
  /** The reference of a directory's parent; the root is its own parent. */
  readonly parent: (directory: TargetInput) => Effect.Effect<ObjectReference, FsFailure>
  /** Metadata and revision of a target. A path follows a final symbolic link unless its target says otherwise. */
  readonly stat: (target: TargetInput) => Effect.Effect<Metadata, FsFailure>
  /** The entries of a directory with their references, and the directory's revision. */
  readonly readDirectory: (
    directory: TargetInput
  ) => Effect.Effect<ObjectObservation<ReadonlyArray<DirectoryEntry>>, FsFailure>
  /** The bytes a symbolic link points at. A path never follows the final link. */
  readonly readLink: (target: TargetInput) => Effect.Effect<Uint8Array, FsFailure>
  /** The canonical absolute path of a target. */
  readonly realPath: (target: TargetInput) => Effect.Effect<BytePath, FsFailure>
  /** The bits of `bits` the caller may exercise on the target: READ, WRITE, EXECUTE as 4, 2, 1. */
  readonly access: (target: TargetInput, bits?: number) => Effect.Effect<number, FsFailure>
  /** The whole content of a regular file. */
  readonly readFile: (target: TargetInput) => Effect.Effect<Uint8Array, FsFailure>
  /** Writes a whole file in one operation, creating or replacing it as the options say. */
  readonly writeFile: (
    entry: EntryInput,
    bytes: Uint8Array,
    options: WriteFileOptions
  ) => Effect.Effect<void, FsFailure>
  /**
   * Opens a file. On a target, the file must exist and `create` is rejected. On an entry, the name is looked up
   * and created in one gate hold, and the result reports whether it was created.
   */
  readonly open: {
    (target: Target | PathInput | ObjectReference | FileHandle, options: OpenOptions): Effect.Effect<
      FileHandle,
      FsFailure,
      Scope.Scope
    >
    (entry: Entry, options: OpenEntryOptions): Effect.Effect<OpenEntryResult, FsFailure, Scope.Scope>
  }
  /** Creates a directory. */
  readonly mkdir: (entry: EntryInput, options?: MkdirOptions) => Effect.Effect<ReferenceEntryResult, FsFailure>
  /** Creates a symbolic link to `target`, stored as given. */
  readonly symlink: (
    target: PathInput,
    entry: EntryInput,
    options?: SymlinkOptions
  ) => Effect.Effect<ReferenceEntryResult, FsFailure>
  /** Adds a name for an existing file or symbolic link. A path source follows a final symbolic link only when its target says so. */
  readonly link: (source: TargetInput, entry: EntryInput) => Effect.Effect<ReferenceEntryResult, FsFailure>
  /** Removes a file or symbolic link. */
  readonly unlink: (entry: EntryInput) => Effect.Effect<DirectoryChange, FsFailure>
  /** Removes an empty directory. */
  readonly rmdir: (entry: EntryInput) => Effect.Effect<DirectoryChange, FsFailure>
  /** Removes a file, a symbolic link, or an empty directory. */
  readonly remove: (entry: EntryInput) => Effect.Effect<DirectoryChange, FsFailure>
  /** Moves an entry, replacing a compatible destination. */
  readonly rename: (from: EntryInput, to: EntryInput) => Effect.Effect<RenameReferenceResult, FsFailure>
  /** Sets the permission bits of a target. */
  readonly chmod: (target: TargetInput, mode: number) => Effect.Effect<void, FsFailure>
  /** Changes the owner or group of a target. */
  readonly chown: (target: TargetInput, owner: OwnerUpdate) => Effect.Effect<void, FsFailure>
  /** Sets the access and modification times of a target. */
  readonly utimes: (target: TargetInput, times: Times) => Effect.Effect<void, FsFailure>
  /** Sets the size of a regular file. */
  readonly truncate: (target: TargetInput, length: bigint) => Effect.Effect<void, FsFailure>
  /** A caller whose working directory is the target, released with the scope. */
  readonly withDirectory: (directory: TargetInput) => Effect.Effect<Caller, FsFailure, Scope.Scope>
  /** A handle on a directory, released with the scope. */
  readonly openDirectory: (directory: TargetInput) => Effect.Effect<DirectoryHandle, FsFailure, Scope.Scope>
}

/**
 * A committed namespace or content change emitted by a volume watch stream.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect, Fiber, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const volume = yield* Vfs.make()
 *   const caller = yield* volume.caller()
 *
 *   const watcher = yield* volume.watch.pipe(
 *     Effect.flatMap((stream) => Stream.runCollect(Stream.take(stream, 2))),
 *     Effect.forkChild({ startImmediately: true })
 *   )
 *
 *   yield* caller.mkdir("/logs")
 *   yield* caller.rmdir("/logs")
 *
 *   // Each event pairs the kind of change with the absolute path it happened to.
 *   const events = yield* Fiber.join(watcher)
 *
 *   return yield* Effect.forEach(events, (change) =>
 *     Effect.map(
 *       Vfs.pathToBytes(change.path),
 *       (bytes) => `${change._tag} ${new TextDecoder().decode(bytes)}`
 *     ))
 * }).pipe(Effect.scoped)
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // [ 'Create /logs', 'Remove /logs' ]
 * ```
 *
 * @category schemas
 * @since 0.1.0
 */
export const Change: typeof WatchModule.Change = WatchModule.Change

/**
 * One committed change observed through a watch subscription. `Rescan` at `/`
 * means the subscriber lost events.
 *
 * @category models
 * @since 0.1.0
 */
export type Change = typeof Change.Type

/**
 * Schema for the filesystem entry kinds reported by overlay summaries.
 *
 * @category schemas
 * @since 0.1.0
 */
export const OverlayNodeKind: typeof VolumeModule.OverlayNodeKind = VolumeModule.OverlayNodeKind

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
export const OverlayDifference: typeof VolumeModule.OverlayDifference = VolumeModule.OverlayDifference

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
export const OverlayChange: typeof VolumeModule.OverlayChange = VolumeModule.OverlayChange

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
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const base = yield* Vfs.make()
 *   const workspace = yield* Vfs.makeOverlay(yield* base.snapshot)
 *
 *   yield* (yield* workspace.caller()).mkdir("/out")
 *
 *   // Timestamps are excluded by default, since they change on every write.
 *   const plain = yield* workspace.changes()
 *   const timed = yield* workspace.changes({ includeTimestamps: true })
 *
 *   return [plain.length, timed.length]
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // [ 1, 2 ]
 * ```
 *
 * @category schemas
 * @since 0.1.0
 */
export const OverlayChangesOptions: typeof VolumeModule.OverlayChangesOptions = VolumeModule.OverlayChangesOptions

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
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const base = yield* Vfs.make()
 *   const workspace = yield* Vfs.makeOverlay(yield* base.snapshot)
 *
 *   yield* (yield* workspace.caller()).writeFile("/out.txt", new TextEncoder().encode("built"), {
 *     access: "write",
 *     create: "exclusive"
 *   })
 *
 *   // One committed state: the summary describes exactly the snapshot beside it,
 *   // so restoring from it cannot disagree with the change list.
 *   const captured = yield* workspace.capture()
 *   const restored = yield* Vfs.fromSnapshot(captured.snapshot)
 *   const reader = yield* restored.caller()
 *
 *   return [
 *     captured.changes.map((change) => change._tag),
 *     new TextDecoder().decode(yield* reader.readFile("/out.txt"))
 *   ]
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // [ [ 'Added' ], 'built' ]
 * ```
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
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect, Fiber, Option, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const volume = yield* Vfs.make()
 *   const caller = yield* volume.caller()
 *
 *   // `watch` reports future changes only; nothing is replayed.
 *   const watcher = yield* volume.watch.pipe(
 *     Effect.flatMap(Stream.runHead),
 *     Effect.forkChild({ startImmediately: true })
 *   )
 *
 *   yield* caller.mkdir("/logs")
 *
 *   const change = yield* Fiber.join(watcher)
 *
 *   return Option.getOrElse(Option.map(change, (event) => event._tag), () => "none")
 * }).pipe(Effect.scoped)
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // Create
 * ```
 *
 * @category models
 * @since 0.1.0
 */
export interface Volume {
  /** The strongest failure boundary survived by acknowledged writes. */
  readonly durability: VolumeDurability
  /** Stable logical identity, preserved across reconstruction only when supplied explicitly. */
  readonly identity: VolumeIdentity
  /** Fresh identity for this uninterrupted storage lifetime. */
  readonly incarnation: VolumeIncarnation
  /** Effective static limits, where `undefined` means unlimited. */
  readonly limits: VolumeLimits
  /** Samples content bytes and directory entries together from the current committed state. */
  readonly usage: Effect.Effect<VolumeUsage, FsFailure>
  /** Opens a scoped stream of future changes. `Rescan` at `/` requires a full rescan; events are not replayed. */
  readonly watch: Effect.Effect<Stream.Stream<Change>, FsFailure, Scope.Scope>
  /** Captures an isolated snapshot of the reachable namespace and metadata. */
  readonly snapshot: Effect.Effect<Snapshot, VfsError>
  readonly [VolumeId]: true
  /** Creates a caller rooted at `/` with independent credentials, umask, and current directory. */
  readonly caller: (options?: RootCallerOptions) => Effect.Effect<Caller, VfsError>
}

/**
 * An ordinary volume with final-state inspection relative to one immutable snapshot base.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const base = yield* Vfs.make()
 *   const workspace = yield* Vfs.makeOverlay(yield* base.snapshot)
 *
 *   yield* (yield* workspace.caller()).writeFile("/added.txt", new Uint8Array([1]), {
 *     access: "write",
 *     create: "exclusive"
 *   })
 *
 *   // `capture` pairs one committed snapshot with the summary describing it.
 *   const captured = yield* workspace.capture()
 *
 *   return captured.changes.map((change) => change._tag)
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // [ 'Added' ]
 * ```
 *
 * @category models
 * @since 0.1.0
 */
export interface OverlayVolume extends Volume {
  /** Computes final differences from the immutable base when this reusable effect executes. */
  readonly changes: (
    options?: OverlayChangesOptions
  ) => Effect.Effect<ReadonlyArray<OverlayChange>, VfsError>
  /** Captures one committed state when this reusable effect executes. */
  readonly capture: (
    options?: OverlayChangesOptions
  ) => Effect.Effect<OverlayCapture, VfsError>
}

/**
 * Optional Effect service for providing an existing filesystem caller.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * // Code depending on the service does not choose the volume it runs against.
 * const readVersion = Effect.gen(function*() {
 *   const caller = yield* Vfs.CurrentFileSystem
 *
 *   return yield* caller.readFile("/version")
 * })
 *
 * const program = Effect.gen(function*() {
 *   const volume = yield* Vfs.make()
 *   const caller = yield* volume.caller()
 *
 *   yield* caller.writeFile("/version", new Uint8Array([49]), {
 *     access: "write",
 *     create: "exclusive"
 *   })
 *
 *   return yield* readVersion.pipe(Effect.provideService(Vfs.CurrentFileSystem, caller))
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // Uint8Array(1) [ 49 ]
 * ```
 *
 * @see The testing guide at `/guides/testing-with-an-isolated-filesystem`.
 * @category services
 * @since 0.1.0
 */
export const CurrentFileSystem: Context.Service<CurrentFileSystem, Caller> = Context.Service<CurrentFileSystem, Caller>(
  "@effect-vfs/core/CurrentFileSystem"
)

/**
 * The caller supplied by the optional filesystem service.
 *
 * @category services
 * @since 0.1.0
 */
export interface CurrentFileSystem extends Caller {}

/**
 * Encodes a snapshot as owned UTF-8 JSON bytes using the version 1 snapshot format.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * // Bytes are portable: store or transmit them, then decode under explicit limits.
 * const program = Effect.gen(function*() {
 *   const volume = yield* Vfs.make()
 *   const caller = yield* volume.caller()
 *
 *   yield* caller.writeFile("/f", new Uint8Array([1, 2, 3]), {
 *     access: "write",
 *     create: "exclusive"
 *   })
 *
 *   const bytes = yield* Vfs.encodeSnapshot(yield* volume.snapshot)
 *
 *   // The bytes are UTF-8 JSON carrying the version 1 snapshot format.
 *   return JSON.parse(new TextDecoder().decode(bytes)).version
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // 1
 * ```
 *
 * @see {@link decodeSnapshot} for reading the bytes back under limits.
 * @category serialization
 * @since 0.1.0
 */
export const encodeSnapshot: (snapshot: Snapshot) => Effect.Effect<Uint8Array, ImageFailure> = (snapshot) =>
  Effect.mapError(Image.encodeSnapshot(snapshot), (error) => retargetFailure("encodeSnapshot", error))

/**
 * Decodes version 1 snapshot bytes while enforcing explicit input and payload limits.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { ByteSize, Effect } from "effect"
 *
 * // Limits are mandatory: decoding is the boundary where untrusted input arrives.
 * const program = Effect.gen(function*() {
 *   const volume = yield* Vfs.make()
 *   const bytes = yield* Vfs.encodeSnapshot(yield* volume.snapshot)
 *
 *   return yield* Vfs.decodeSnapshot(bytes, {
 *     maxEncodedBytes: ByteSize.bytes(1),
 *     maxRecords: 10_000,
 *     maxEntries: 10_000,
 *     maxDecodedBytes: ByteSize.megabytes(16)
 *   }).pipe(
 *     Effect.as("accepted"),
 *     Effect.catchTag("VfsError", (error) => Effect.succeed([error.code, error.field]))
 *   )
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // [ 'LimitExceeded', 'encodedBytes' ]
 * ```
 *
 * @see {@link DecodeLimits} for what each bound protects.
 * @category serialization
 * @since 0.1.0
 */
export const decodeSnapshot: (
  input: Uint8Array,
  limits: DecodeLimits
) => Effect.Effect<Snapshot, ImageFailure | ArgumentFailure> = (input, limits) =>
  Effect.mapError(Image.decodeSnapshot(input, limits), (error) => retargetFailure("decodeSnapshot", error))

const deltaLimits = (operation: string, limits?: SnapshotDeltaModel.SnapshotDeltaLimits) =>
  Effect.fromResult(decodeConfiguration(
    SnapshotDeltaModel.SnapshotDeltaLimits,
    limits ?? SnapshotDeltaModel.SnapshotDeltaLimits.default,
    operation
  ))

/**
 * Computes an exact portable delta between two immutable snapshots.
 * Requires the platform-neutral `Crypto.Crypto` service for base identity. Provide
 * `NodeCrypto.layer`, `BunCrypto.layer`, or your own via `Crypto.make`.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * // Two snapshots in, one opaque delta out. `inspectSnapshotDelta` reads it.
 * const program = Effect.gen(function*() {
 *   const volume = yield* Vfs.make()
 *   const caller = yield* volume.caller()
 *   const base = yield* volume.snapshot
 *
 *   yield* caller.writeFile("/added.txt", new Uint8Array([1]), {
 *     access: "write",
 *     create: "exclusive"
 *   })
 *
 *   const delta = yield* Vfs.diffSnapshots(base, yield* volume.snapshot)
 *
 *   const changes = yield* Vfs.inspectSnapshotDelta(base, delta)
 *
 *   return new TextDecoder().decode(yield* Vfs.pathToBytes(changes[0]!.path))
 * }).pipe(Effect.provide(NodeCrypto.layer))
 *
 * Effect.runPromise(program).then(console.log)
 * // /added.txt
 * ```
 *
 * @see {@link inspectSnapshotDelta} to read a delta, {@link applySnapshotDelta} to apply one.
 * @category snapshots
 * @since 0.1.0
 */
export const diffSnapshots: (
  base: Snapshot,
  target: Snapshot,
  limits?: SnapshotDeltaModel.SnapshotDeltaLimits
) => Effect.Effect<
  SnapshotDeltaModel.SnapshotDelta,
  VfsError | PlatformError.PlatformError,
  Crypto.Crypto
> = Effect.fn("VirtualFileSystem.diffSnapshots")(function*(
  base: Snapshot,
  target: Snapshot,
  limits?: SnapshotDeltaModel.SnapshotDeltaLimits
) {
  // The delta codec fails under its own name; the public entry point names itself.
  return yield* SnapshotDeltaInternal.diffSnapshots(base, target, yield* deltaLimits("diffSnapshots", limits)).pipe(
    Effect.mapError((error) => retargetFailure("diffSnapshots", error))
  )
})

/**
 * Verifies an exact snapshot delta against its base and derives an owned path-oriented summary.
 * Requires the platform-neutral `Crypto.Crypto` service for base identity. Provide
 * `NodeCrypto.layer`, `BunCrypto.layer`, or your own via `Crypto.make`.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * // Inspection verifies the delta against its base before describing it.
 * const program = Effect.gen(function*() {
 *   const volume = yield* Vfs.make()
 *   const caller = yield* volume.caller()
 *   const base = yield* volume.snapshot
 *
 *   yield* caller.mkdir("/logs")
 *
 *   const delta = yield* Vfs.diffSnapshots(base, yield* volume.snapshot)
 *   const changes = yield* Vfs.inspectSnapshotDelta(base, delta)
 *
 *   return changes.map((change) =>
 *     change._tag === "Updated" ? change.afterKind : change.kind)
 * }).pipe(Effect.provide(NodeCrypto.layer))
 *
 * Effect.runPromise(program).then(console.log)
 * // [ 'directory' ]
 * ```
 *
 * @see {@link SnapshotChangesOptions} for including timestamp differences.
 * @category snapshots
 * @since 0.1.0
 */
export const inspectSnapshotDelta: (
  base: Snapshot,
  delta: SnapshotDeltaModel.SnapshotDelta,
  options?: SnapshotDeltaModel.SnapshotChangesOptions,
  limits?: SnapshotDeltaModel.SnapshotDeltaLimits
) => Effect.Effect<
  ReadonlyArray<SnapshotDeltaModel.SnapshotChange>,
  VfsError | PlatformError.PlatformError,
  Crypto.Crypto
> = Effect.fn("VirtualFileSystem.inspectSnapshotDelta")(function*(
  base: Snapshot,
  delta: SnapshotDeltaModel.SnapshotDelta,
  options?: SnapshotDeltaModel.SnapshotChangesOptions,
  limits?: SnapshotDeltaModel.SnapshotDeltaLimits
) {
  const decoded = yield* Effect.fromResult(
    decodeConfiguration(SnapshotDeltaModel.SnapshotChangesOptions, options ?? {}, "inspectSnapshotDelta")
  )

  return yield* SnapshotDeltaInternal.inspectSnapshotDelta(
    base,
    delta,
    decoded,
    yield* deltaLimits("inspectSnapshotDelta", limits)
  ).pipe(Effect.mapError((error) => retargetFailure("inspectSnapshotDelta", error)))
})

/**
 * Applies an exact delta to its semantically matching base and returns a new snapshot.
 * Requires the platform-neutral `Crypto.Crypto` service for base identity. Provide
 * `NodeCrypto.layer`, `BunCrypto.layer`, or your own via `Crypto.make`.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const volume = yield* Vfs.make()
 *   const caller = yield* volume.caller()
 *   const base = yield* volume.snapshot
 *
 *   yield* caller.writeFile("/f", new Uint8Array([7]), {
 *     access: "write",
 *     create: "exclusive"
 *   })
 *
 *   const delta = yield* Vfs.diffSnapshots(base, yield* volume.snapshot)
 *
 *   // Applying the delta to the same base reproduces the target snapshot.
 *   const applied = yield* Vfs.applySnapshotDelta(base, delta)
 *   const restored = yield* Vfs.fromSnapshot(applied)
 *   const reader = yield* restored.caller()
 *
 *   return yield* reader.readFile("/f")
 * }).pipe(Effect.provide(NodeCrypto.layer))
 *
 * Effect.runPromise(program).then(console.log)
 * // Uint8Array(1) [ 7 ]
 * ```
 *
 * @see {@link SnapshotDeltaFromBytes} for moving a delta across a boundary.
 * @category snapshots
 * @since 0.1.0
 */
export const applySnapshotDelta: (
  base: Snapshot,
  delta: SnapshotDeltaModel.SnapshotDelta,
  limits?: SnapshotDeltaModel.SnapshotDeltaLimits
) => Effect.Effect<
  Snapshot,
  VfsError | PlatformError.PlatformError,
  Crypto.Crypto
> = Effect.fn("VirtualFileSystem.applySnapshotDelta")(function*(
  base: Snapshot,
  delta: SnapshotDeltaModel.SnapshotDelta,
  limits?: SnapshotDeltaModel.SnapshotDeltaLimits
) {
  return yield* SnapshotDeltaInternal.applySnapshotDelta(
    base,
    delta,
    yield* deltaLimits("applySnapshotDelta", limits)
  ).pipe(Effect.mapError((error) => retargetFailure("applySnapshotDelta", error)))
})

const deltaSchemaIssue = (cause: VfsError, input: typeof Schema.Unknown.Type, options: SchemaAST.ParseOptions) =>
  new SchemaIssue.InvalidValue(
    { message: `Snapshot delta ${cause.code}${cause.field === undefined ? "" : ` at ${cause.field}`}` },
    input,
    options
  )

/**
 * Creates an Effect Schema codec between owned bytes and opaque snapshot deltas.
 * Omission uses `SnapshotDeltaLimits.default`.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect, Schema } from "effect"
 *
 * // Omitting limits uses `SnapshotDeltaLimits.default`.
 * const codec = Vfs.SnapshotDeltaFromBytes()
 *
 * const program = Effect.gen(function*() {
 *   const volume = yield* Vfs.make()
 *   const base = yield* volume.snapshot
 *
 *   yield* (yield* volume.caller()).mkdir("/out")
 *
 *   const delta = yield* Vfs.diffSnapshots(base, yield* volume.snapshot)
 *   const bytes = yield* Schema.encodeEffect(codec)(delta)
 *
 *   // The delta survives the trip through bytes and still applies to its base.
 *   const decoded = yield* Schema.decodeEffect(codec)(bytes)
 *
 *   return (yield* Vfs.inspectSnapshotDelta(base, decoded)).map((change) => change._tag)
 * }).pipe(Effect.provide(NodeCrypto.layer))
 *
 * Effect.runPromise(program).then(console.log)
 * // [ 'Added' ]
 * ```
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
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import { Effect } from "effect"
 *
 * // Any byte except NUL is accepted. Empty, NUL-bearing, detached, and shared-memory
 * // input all fail with `InvalidArgument`.
 * const program = Effect.gen(function*() {
 *   const path = yield* Vfs.pathFromBytes(new Uint8Array([47, 116, 109, 112]))
 *
 *   const rejected = yield* Vfs.pathFromBytes(new Uint8Array([47, 0])).pipe(
 *     Effect.as("accepted"),
 *     Effect.catchTag("VfsError", (error) => Effect.succeed(error.code))
 *   )
 *
 *   return [yield* Vfs.pathToBytes(path), rejected]
 * })
 *
 * Effect.runPromise(program).then(console.log)
 * // [ Uint8Array(4) [ 47, 116, 109, 112 ], 'InvalidArgument' ]
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const pathFromBytes: (bytes: Uint8Array) => Effect.Effect<BytePath, FsFailure> = Path.pathFromBytes

/**
 * Copies the bytes held by an opaque byte path.
 *
 * @category getters
 * @since 0.1.0
 */
export const pathToBytes: (path: BytePath) => Effect.Effect<Uint8Array, FsFailure> = Path.pathToBytes

/**
 * Schema for a complete fixture namespace with optional metadata and forward hard links.
 *
 * **Details**
 *
 * Fixture paths must be absolute, unique, and explicitly include their parent directories.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect, Schema } from "effect"
 *
 * // Fixtures must list every parent directory before its children.
 * const program = Schema.decodeUnknownEffect(Vfs.Fixture)({
 *   entries: [
 *     { kind: "file", path: "/etc/hosts", bytes: new TextEncoder().encode("127.0.0.1") }
 *   ]
 * }).pipe(
 *   Effect.flatMap(Vfs.fromFixture),
 *   Effect.as("built"),
 *   Effect.catchTag("VfsError", (error) => Effect.succeed(`rejected: ${error.code}`))
 * )
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // rejected: InvalidStructure
 * ```
 *
 * @category schemas
 * @since 0.1.0
 */
export const Fixture: typeof FixtureModule.Fixture = FixtureModule.Fixture

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
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const volume = yield* Vfs.make()
 *   const caller = yield* volume.caller()
 *
 *   yield* caller.mkdir("/work")
 *   yield* caller.writeFile("/work/notes.txt", new Uint8Array([104, 105]), { access: "write", create: "exclusive" })
 *
 *   return yield* caller.readFile("/work/notes.txt")
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // Uint8Array(2) [ 104, 105 ]
 * ```
 *
 * @see The testing guide at `/guides/testing-with-an-isolated-filesystem`.
 * @category constructors
 * @since 0.1.0
 */
export const make: (
  options?: VolumeOptions
) => Effect.Effect<Volume, VfsError> = VfsModel.make

/**
 * Restores a fresh volume from an opaque snapshot under the supplied destination limits.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const original = yield* Vfs.make()
 *   const source = yield* original.caller()
 *
 *   yield* source.writeFile("/seed.txt", new TextEncoder().encode("one"), {
 *     access: "write",
 *     create: "exclusive"
 *   })
 *
 *   const restored = yield* Vfs.fromSnapshot(yield* original.snapshot)
 *   const copy = yield* restored.caller()
 *
 *   // Writing to the restore leaves the original untouched: the two are independent.
 *   yield* copy.writeFile("/seed.txt", new TextEncoder().encode("two"), {
 *     access: "write",
 *     truncate: true
 *   })
 *
 *   return [
 *     new TextDecoder().decode(yield* source.readFile("/seed.txt")),
 *     new TextDecoder().decode(yield* copy.readFile("/seed.txt"))
 *   ]
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // [ 'one', 'two' ]
 * ```
 *
 * @see {@link makeOverlay} for a copy-on-write workspace over the same base.
 * @category constructors
 * @since 0.1.0
 */
export const fromSnapshot: (
  snapshot: Snapshot,
  options?: VolumeOptions
) => Effect.Effect<
  Volume,
  VfsError
> = VfsModel.fromSnapshot

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
 * Invalid base snapshots and invalid volume limits fail with `VfsError`. Each
 * execution creates a fresh workspace.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const base = yield* Vfs.make()
 *   const origin = yield* base.caller()
 *
 *   yield* origin.writeFile("/config.json", new TextEncoder().encode("{}"), {
 *     access: "write",
 *     create: "exclusive"
 *   })
 *
 *   const workspace = yield* Vfs.makeOverlay(yield* base.snapshot)
 *
 *   yield* (yield* workspace.caller()).writeFile("/config.json", new TextEncoder().encode("[]"), {
 *     access: "write",
 *     truncate: true
 *   })
 *
 *   // The write landed in the workspace only; the base still reads its own value.
 *   return [
 *     new TextDecoder().decode(yield* origin.readFile("/config.json")),
 *     (yield* workspace.changes()).map((change) => change._tag)
 *   ]
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // [ '{}', [ 'Updated' ] ]
 * ```
 *
 * @see The overlay guide at `/guides/overlay-filesystems`.
 * @category constructors
 * @since 0.1.0
 */
export const makeOverlay: (
  base: Snapshot,
  options?: VolumeOptions
) => Effect.Effect<
  OverlayVolume,
  VfsError
> = VfsModel.makeOverlay

/**
 * Builds a fresh volume from a validated final-state fixture.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * const encoder = new TextEncoder()
 *
 * const program = Effect.gen(function*() {
 *   // Parent directories must be listed explicitly, before their children.
 *   const volume = yield* Vfs.fromFixture({
 *     entries: [
 *       { kind: "directory", path: "/project" },
 *       {
 *         kind: "file",
 *         path: "/project/package.json",
 *         bytes: encoder.encode(`{"version":"1.2.3"}`)
 *       },
 *       { kind: "symlink", path: "/project/latest", target: "/project/package.json" }
 *     ]
 *   })
 *
 *   const listing = yield* (yield* volume.caller()).readDirectory("/project")
 *
 *   return listing.value.map((entry) => new TextDecoder().decode(entry.name))
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // [ 'package.json', 'latest' ]
 * ```
 *
 * @see The fixtures guide at `/guides/fixtures-and-snapshots`.
 * @category constructors
 * @since 0.1.0
 */
export const fromFixture: (
  fixture: Fixture,
  options?: VolumeOptions
) => Effect.Effect<
  Volume,
  VfsError
> = FixtureInternal.fromFixture
