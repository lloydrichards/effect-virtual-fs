/**
 * Provides an in-memory implementation of Effect's `FileSystem` service.
 *
 * The service uses `@effect-vfs/core` for filesystem state and exposes that
 * state through Effect's path-based `FileSystem` interface. It is intended for
 * tests, build tools, and programs that need filesystem behavior without host
 * filesystem I/O.
 *
 * @since 0.1.0
 */
import type * as Vfs from "@effect-vfs/core/VirtualFileSystem"
import type * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Layer from "effect/Layer"
import type * as PlatformError from "effect/PlatformError"
import * as internal from "./internal/memoryFileSystem.js"

/**
 * Identifies a watch stream failure caused by lost events. Open a new watch before
 * rescanning its path, and repeat if the new watch also overflows.
 *
 * @example
 * ```ts
 * import { MemoryFileSystem } from "@effect-vfs/memory"
 * import * as PlatformError from "effect/PlatformError"
 *
 * const error = PlatformError.systemError({
 *   _tag: "Unknown",
 *   module: "FileSystem",
 *   method: "watch",
 *   description: "WatchOverflow"
 * })
 *
 * console.log(MemoryFileSystem.isWatchOverflow(error))
 * // true
 * ```
 *
 * @category guards
 * @since 0.4.0
 */
export const isWatchOverflow: (error: PlatformError.PlatformError) => boolean = internal.isWatchOverflow

/**
 * Creates a `FileSystem.FileSystem` service backed by a fresh in-memory volume.
 *
 * **When to use**
 *
 * Use when you need the service value directly. The volume
 * starts with an empty `/tmp` directory and uses `/` as its working directory.
 *
 * @example
 * ```ts
 * import { MemoryFileSystem } from "@effect-vfs/memory"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const fs = yield* MemoryFileSystem.make
 *
 *   yield* fs.writeFileString("/tmp/greeting.txt", "hello")
 *
 *   return yield* fs.readFileString("/tmp/greeting.txt")
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // hello
 * ```
 *
 * @see {@link layer} for a Layer, {@link bind} for an existing volume.
 * @category constructors
 * @since 0.1.0
 */
export const make: Effect.Effect<FileSystem.FileSystem> = internal.make

/**
 * Provides a `FileSystem.FileSystem` backed by a fresh in-memory volume.
 *
 * **When to use**
 *
 * Use when you need to replace the host filesystem in an Effect program.
 *
 * **Gotchas**
 *
 * Reusing this layer value within a single layer graph shares one volume through
 * layer memoization. Wrap it with `Layer.fresh` when each use needs separate
 * state. Separate graphs, such as one per test, already get separate volumes.
 *
 * @example
 * ```ts
 * import { MemoryFileSystem } from "@effect-vfs/memory"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect, FileSystem, Layer } from "effect"
 *
 * const writeManifest = Effect.gen(function*() {
 *   const fs = yield* FileSystem.FileSystem
 *
 *   yield* fs.makeDirectory("/dist", { recursive: true })
 *   yield* fs.writeFileString("/dist/manifest.json", `{"version":"1.2.3"}`)
 *
 *   return yield* fs.readFileString("/dist/manifest.json")
 * })
 *
 * const memoryLayer = MemoryFileSystem.layer.pipe(Layer.provide(NodeCrypto.layer))
 *
 * Effect.runPromise(writeManifest.pipe(Effect.provide(memoryLayer)))
 *   .then(console.log)
 * // {"version":"1.2.3"}
 * ```
 *
 * @example
 * ```ts
 * import { MemoryFileSystem } from "@effect-vfs/memory"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect, FileSystem, Layer } from "effect"
 *
 * const write = Effect.gen(function*() {
 *   const fs = yield* FileSystem.FileSystem
 *
 *   yield* fs.writeFileString("/shared.txt", "written")
 * })
 *
 * const exists = Effect.gen(function*() {
 *   const fs = yield* FileSystem.FileSystem
 *
 *   return yield* fs.exists("/shared.txt")
 * })
 *
 * const program = Effect.gen(function*() {
 *   // One layer value in one graph is memoized, so both effects share a volume.
 *   const shared = yield* Effect.andThen(write, exists).pipe(
 *     Effect.provide(MemoryFileSystem.layer)
 *   )
 *
 *   // `Layer.fresh` builds the layer again, giving each use its own volume.
 *   const isolated = yield* Effect.andThen(
 *     write.pipe(Effect.provide(Layer.fresh(MemoryFileSystem.layer))),
 *     exists.pipe(Effect.provide(Layer.fresh(MemoryFileSystem.layer)))
 *   )
 *
 *   return [shared, isolated]
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // [ true, false ]
 * ```
 *
 * @see {@link make} for the service directly, {@link bind} for an existing volume.
 * @see The testing guide at `/guides/testing-with-an-isolated-filesystem`.
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<FileSystem.FileSystem> = internal.layer

/**
 * Creates a `FileSystem.FileSystem` service backed by an existing core volume.
 *
 * **Details**
 *
 * The binding creates its own root caller and file-descriptor table. It does not
 * add `/tmp` or otherwise modify the volume. Use this when an adapter and direct
 * core callers must share filesystem state. Bindings share namespace and content
 * changes, but keep independent caller state, descriptors, and file cursors.
 *
 * The caller defaults to a privileged uid and gid of `0` with umask `0`. Invalid
 * caller options fail with a `VfsError` whose code is `InvalidArgument` and whose `field` names the option.
 * Filesystem operations translate core failures to Effect `PlatformError` values.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import { MemoryFileSystem } from "@effect-vfs/memory"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect, FileSystem, Layer } from "effect"
 *
 * const encoder = new TextEncoder()
 *
 * // A volume seeded with a fixture, exposed through Effect's `FileSystem`.
 * const seeded = Layer.effect(
 *   FileSystem.FileSystem,
 *   Effect.gen(function*() {
 *     const volume = yield* Vfs.fromFixture({
 *       entries: [
 *         { kind: "directory", path: "/project" },
 *         {
 *           kind: "file",
 *           path: "/project/package.json",
 *           bytes: encoder.encode(`{"version":"1.2.3"}`)
 *         }
 *       ]
 *     })
 *
 *     return yield* MemoryFileSystem.bind(volume)
 *   })
 * )
 *
 * const program = Effect.gen(function*() {
 *   const fs = yield* FileSystem.FileSystem
 *
 *   return yield* fs.readFileString("/project/package.json")
 * })
 *
 * Effect.runPromise(
 *   program.pipe(
 *     Effect.provide(seeded),
 *     Effect.provide(NodeCrypto.layer)
 *   )
 * ).then(console.log)
 * // {"version":"1.2.3"}
 * ```
 *
 * @see {@link make} for a service backed by a fresh volume with `/tmp`.
 * @category constructors
 * @since 0.1.0
 */
export const bind: (
  volume: Vfs.Volume,
  options?: Vfs.RootCallerOptions
) => Effect.Effect<FileSystem.FileSystem, Vfs.VfsError> = internal.bind
