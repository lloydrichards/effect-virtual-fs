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
import * as internal from "./internal/memoryFileSystem.js"

/**
 * Creates a `FileSystem.FileSystem` service backed by a fresh in-memory volume.
 *
 * **When to use**
 *
 * Use when you need the service value directly. The volume
 * starts with an empty `/tmp` directory and uses `/` as its working directory.
 *
 * @see {@link layer} for providing the service as a Layer.
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
 * Reusing this layer value in one layer graph shares the volume through layer
 * memoization. Wrap it with `Layer.fresh` when each use needs separate state.
 *
 * @see {@link make} for constructing the service directly.
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
 * caller options fail with `VirtualFileSystem.ConfigurationError`. Filesystem
 * operations translate core failures to Effect `PlatformError` values.
 *
 * @see {@link make} for a service backed by a fresh volume with `/tmp`.
 * @category constructors
 * @since 0.1.0
 */
export const bind: (
  volume: Vfs.Volume,
  options?: Vfs.RootCallerOptions
) => Effect.Effect<FileSystem.FileSystem, Vfs.ConfigurationError> = internal.bind
