/**
 * Streams directory trees between callers, snapshots, and new volumes.
 *
 * Sources emit `Entry` values in sorted pre-order, rooted at the transfer root:
 * the root itself is `/`, and hard links name an earlier entry. Sinks write those
 * entries under a destination and return a `TransferReport`. Compose them with
 * Effect's own `Stream` operators, for example `Stream.filter` to exclude paths
 * or `Stream.concat` to merge several sources.
 *
 * @since 0.6.0
 */
import type * as Vfs from "@effect-vfs/core/VirtualFileSystem"
import type * as Crypto from "effect/Crypto"
import * as Data from "effect/Data"
import type * as Effect from "effect/Effect"
import type * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import type * as Sink from "effect/Sink"
import type * as Stream from "effect/Stream"
import * as internal from "./internal/treeTransfer.js"
import * as model from "./internal/treeTransferModel.js"

/**
 * One transferred tree entry: a core fixture entry whose path is rooted at the
 * transfer root.
 *
 * **Details**
 *
 * Paths are strings while every component is UTF-8, and `BytePath` values
 * otherwise. Entries carry the source's full metadata; sinks decide what to apply.
 *
 * @example
 * ```ts
 * import type { TreeTransfer } from "@effect-vfs/memory"
 *
 * const entry: TreeTransfer.Entry = { kind: "file", path: "/README.md", bytes: new Uint8Array() }
 *
 * console.log(entry.path)
 * // /README.md
 * ```
 *
 * @category models
 * @since 0.6.0
 */
export type Entry = Vfs.Fixture["entries"][number]

/**
 * A transfer failure that is not a filesystem error.
 *
 * **Details**
 *
 * `LimitExceeded` names the exceeded `field` of the source limits.
 * `InvalidEntry` reports an entry a sink cannot place, such as a missing root,
 * a child before its parent, or a hard link to an unwritten target.
 * `InvalidArgument` reports an incomplete or malformed limits policy.
 *
 * @example
 * ```ts
 * import { TreeTransfer } from "@effect-vfs/memory"
 *
 * const error = new TreeTransfer.TransferError({ code: "LimitExceeded", field: "maxEntries" })
 *
 * console.log(error.code, error.field)
 * // LimitExceeded maxEntries
 * ```
 *
 * @category errors
 * @since 0.6.0
 */
export class TransferError extends Data.TaggedError("TransferError")<{
  readonly code: "LimitExceeded" | "InvalidEntry" | "InvalidArgument"
  readonly field?: string
  readonly path?: Vfs.PathInput
}> {}

/**
 * A complete source work policy.
 *
 * **Details**
 *
 * `maxEntries` counts every emitted entry including the root. `maxBytes` counts
 * file contents and symbolic-link targets. `maxDepth` counts components below the
 * root, and `maxPathBytes` measures the rooted entry path. A supplied policy must
 * set every field.
 *
 * @example
 * ```ts
 * import { TreeTransfer } from "@effect-vfs/memory"
 * import { ByteSize } from "effect"
 *
 * const limits: TreeTransfer.TreeTransferLimits = {
 *   maxEntries: 500,
 *   maxBytes: ByteSize.mebibytes(4),
 *   maxFileBytes: ByteSize.mebibytes(1),
 *   maxDepth: 8,
 *   maxPathBytes: ByteSize.bytes(512)
 * }
 *
 * console.log(limits.maxDepth)
 * // 8
 * ```
 *
 * @category models
 * @since 0.6.0
 */
export type TreeTransferLimits = typeof TreeTransferLimits.Type

/**
 * Schema for a complete source work policy, with frozen presets.
 *
 * **Details**
 *
 * Sources use `default` when no limits are passed. `constrained` suits
 * memory-sensitive hosts. Spread a preset to change individual fields.
 *
 * @example
 * ```ts
 * import { TreeTransfer } from "@effect-vfs/memory"
 *
 * const shallow = { ...TreeTransfer.TreeTransferLimits.constrained, maxDepth: 4 }
 *
 * console.log(shallow.maxDepth, TreeTransfer.TreeTransferLimits.default.maxEntries)
 * // 4 100000
 * ```
 *
 * @category schemas
 * @since 0.6.0
 */
export const TreeTransferLimits = Object.assign(model.TreeTransferLimitsSchema, {
  default: model.defaultLimits,
  constrained: model.constrainedLimits
})

/**
 * Options for a source.
 *
 * @example
 * ```ts
 * import { TreeTransfer } from "@effect-vfs/memory"
 *
 * const options: TreeTransfer.ReadOptions = { limits: TreeTransfer.TreeTransferLimits.constrained }
 *
 * console.log(options.limits?.maxEntries)
 * // 10000
 * ```
 *
 * @category models
 * @since 0.6.0
 */
export interface ReadOptions {
  /** Source work policy. Omission uses `TreeTransferLimits.default`. */
  readonly limits?: TreeTransferLimits | undefined
}

/**
 * Options for a sink that writes into an existing volume.
 *
 * **Details**
 *
 * `existing: "reject"` (the default) claims the destination with an exclusive
 * create and removes it if the transfer fails or is interrupted.
 * `existing: "overwrite"` merges into existing directories, replaces files and
 * symbolic links, and never removes anything on failure. A file and directory
 * clash always fails. Deleted source entries are never propagated.
 *
 * `times` defaults to `"mtime"`. Permission bits are always applied; setuid,
 * setgid, and sticky bits only with `specialBits: true`. Directory modes and
 * times are applied after their children are written.
 *
 * @example
 * ```ts
 * import { TreeTransfer } from "@effect-vfs/memory"
 *
 * const refresh: TreeTransfer.WriteOptions = { existing: "overwrite", times: "all" }
 *
 * console.log(refresh.existing)
 * // overwrite
 * ```
 *
 * @category models
 * @since 0.6.0
 */
export interface WriteOptions {
  /** How an existing destination is treated. Defaults to `"reject"`. */
  readonly existing?: "reject" | "overwrite" | undefined
  /** Which source timestamps are applied. Defaults to `"mtime"`. */
  readonly times?: "none" | "mtime" | "all" | undefined
  /** Applies setuid, setgid, and sticky bits. Defaults to `false`. */
  readonly specialBits?: boolean | undefined
}

/**
 * Counts of what a sink wrote.
 *
 * @example
 * ```ts
 * import type { TreeTransfer } from "@effect-vfs/memory"
 * import { ByteSize } from "effect"
 *
 * const report: TreeTransfer.TransferReport = { entries: 2, files: 1, bytes: ByteSize.bytes(5) }
 *
 * console.log(report.entries)
 * // 2
 * ```
 *
 * @category models
 * @since 0.6.0
 */
export type TransferReport = typeof TransferReport.Type

/**
 * Schema for the counts a sink returns.
 *
 * @example
 * ```ts
 * import { TreeTransfer } from "@effect-vfs/memory"
 * import { ByteSize, Schema } from "effect"
 *
 * const report = Schema.decodeUnknownSync(TreeTransfer.TransferReport)({
 *   entries: 3,
 *   files: 2,
 *   bytes: ByteSize.bytes(10)
 * })
 *
 * console.log(report.files)
 * // 2
 * ```
 *
 * @category schemas
 * @since 0.6.0
 */
export const TransferReport = Schema.Struct({
  entries: Schema.Natural,
  files: Schema.Natural,
  bytes: Schema.ByteSize
})

/**
 * Streams the tree at `root` through a live caller.
 *
 * **Details**
 *
 * Reads use the caller's permissions. Each entry's metadata is read before its
 * contents, so entries carry the source's original access time, but the reads
 * themselves update source access times and commit on durable volumes. Use
 * {@link fromSnapshot} for a point-in-time read that never changes the source.
 * Hard links within the tree become `hardLink` entries naming the first alias.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import { TreeTransfer } from "@effect-vfs/memory"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const volume = yield* Vfs.fromFixture({
 *     entries: [
 *       { kind: "directory", path: "/project" },
 *       { kind: "file", path: "/project/a.txt", bytes: new TextEncoder().encode("a") }
 *     ]
 *   })
 *   const entries = yield* Stream.runCollect(TreeTransfer.fromCaller(yield* volume.caller(), "/project"))
 *
 *   return entries.map((entry) => entry.path)
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // [ '/', '/a.txt' ]
 * ```
 *
 * @category sources
 * @since 0.6.0
 */
export const fromCaller: (
  caller: Vfs.Caller,
  root: Vfs.PathInput,
  options?: ReadOptions
) => Stream.Stream<Entry, TransferError | Vfs.FsError> = (caller, root, options) =>
  internal.fromCaller(caller, root, options)

/**
 * Streams the tree at `root` from an immutable snapshot.
 *
 * **Details**
 *
 * Restores the snapshot into a private volume and walks it with a privileged
 * caller, so the original volume is never read or changed.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import { TreeTransfer } from "@effect-vfs/memory"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const volume = yield* Vfs.fromFixture({ entries: [{ kind: "directory", path: "/dist" }] })
 *   const entries = yield* Stream.runCollect(TreeTransfer.fromSnapshot(yield* volume.snapshot, "/dist"))
 *
 *   return entries.length
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // 1
 * ```
 *
 * @category sources
 * @since 0.6.0
 */
export const fromSnapshot: (
  snapshot: Vfs.Snapshot,
  root: Vfs.PathInput,
  options?: ReadOptions
) => Stream.Stream<
  Entry,
  TransferError | Vfs.FsError | Vfs.ConfigurationError | Vfs.ImageError | PlatformError.PlatformError,
  Crypto.Crypto
> = (snapshot, root, options) => internal.fromSnapshot(snapshot, root, options)

/**
 * Writes streamed entries under `destination` through a live caller.
 *
 * **Details**
 *
 * Writes use the caller's permissions and apply the {@link WriteOptions} policy.
 * Each file write is atomic; the transfer as a whole is not. See `WriteOptions`
 * for cleanup on failure.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import { TreeTransfer } from "@effect-vfs/memory"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const source = yield* Vfs.fromFixture({
 *     entries: [
 *       { kind: "directory", path: "/project" },
 *       { kind: "file", path: "/project/a.txt", bytes: new TextEncoder().encode("a") }
 *     ]
 *   })
 *   const workspace = yield* (yield* Vfs.make()).caller()
 *
 *   const report = yield* Stream.run(
 *     TreeTransfer.fromCaller(yield* source.caller(), "/project"),
 *     TreeTransfer.toCaller(workspace, "/copy")
 *   )
 *
 *   return [report.files, yield* workspace.readDirectory("/copy")]
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // [ 1, [ 'a.txt' ] ]
 * ```
 *
 * @category sinks
 * @since 0.6.0
 */
export const toCaller: (
  caller: Vfs.Caller,
  destination: Vfs.PathInput,
  options?: WriteOptions
) => Sink.Sink<TransferReport, Entry, never, TransferError | Vfs.FsError> = (caller, destination, options) =>
  internal.toCaller(caller, destination, options)

/**
 * Builds a new volume from streamed entries in one step.
 *
 * **Details**
 *
 * Nothing is visible unless every entry is accepted. The first entry must be the
 * `/` directory. Entry metadata is kept exactly, including change and birth times,
 * because the result is a fresh isolated volume. Every entry is held in memory
 * until the volume is built.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import { TreeTransfer } from "@effect-vfs/memory"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const source = yield* Vfs.fromFixture({
 *     entries: [
 *       { kind: "directory", path: "/dist" },
 *       { kind: "file", path: "/dist/app.js", bytes: new TextEncoder().encode("run()") }
 *     ]
 *   })
 *   const volume = yield* TreeTransfer.toVolume(TreeTransfer.fromCaller(yield* source.caller(), "/dist"))
 *
 *   return yield* (yield* volume.caller()).readDirectory("/")
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // [ 'app.js' ]
 * ```
 *
 * @category sinks
 * @since 0.6.0
 */
export const toVolume: <E, R>(
  entries: Stream.Stream<Entry, E, R>,
  options?: Vfs.VolumeOptions
) => Effect.Effect<
  Vfs.Volume,
  E | TransferError | Vfs.FsError | Vfs.ConfigurationError | Vfs.ImageError | PlatformError.PlatformError,
  R | Crypto.Crypto
> = (entries, options) => internal.toVolume(entries, options)
