/**
 * Implements the Effect `FileSystem` adapter over `@effect-vfs/core`.
 *
 * This module binds a core volume to Effect's service. Separate internal modules
 * own error conversion, file cursors, traversal, and copy behavior.
 *
 * @internal
 * @since 0.1.0
 */
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import { type PlatformError, systemError } from "effect/PlatformError"
import * as Predicate from "effect/Predicate"
import * as Stream from "effect/Stream"
import { toPlatformError } from "./platformError.js"

import { textPath } from "./adapterSupport.js"
import { bindOperations } from "./fileSystemAdapter.js"

/** @internal */
export const isWatchOverflow = (error: PlatformError): boolean =>
  Predicate.isTagged("Unknown")(error.reason) &&
  error.reason.module === "FileSystem" &&
  error.reason.method === "watch" &&
  error.reason.description === "WatchOverflow"

/** @internal */
export const bind = Effect.fnUntraced(function*(volume: Vfs.Volume, options?: Vfs.RootCallerOptions) {
  const caller = yield* volume.caller({ ...options, umask: options?.umask ?? 0 })

  return yield* bindCaller(caller)
})

/** @internal */
export const bindCaller = (caller: Vfs.Caller): Effect.Effect<FileSystem.FileSystem> =>
  bindOperations(caller, (path, options) =>
    Stream.unwrap(
      caller.watch(path, { recursive: options?.recursive === true, alias: "resolved" }).pipe(
        Effect.mapError((error) => toPlatformError(error, "watch", path)),
        Effect.tap(() => Effect.sync(() => options?.onReady?.())),
        Effect.map((events) =>
          events.pipe(
            Stream.mapError((error) => toPlatformError(error, "watch", path)),
            Stream.mapEffect((event) => {
              if (Predicate.isTagged("Rescan")(event)) {
                return Effect.fail(systemError({
                  module: "FileSystem",
                  method: "watch",
                  pathOrDescriptor: path,
                  _tag: "Unknown",
                  description: "WatchOverflow"
                }))
              }

              return textPath(event.path, "watch").pipe(
                Effect.mapError((error) => toPlatformError(error, "watch", path)),
                Effect.map((name) => ({ _tag: event._tag, path: name }))
              )
            })
          )
        )
      )
    ))

/** @internal */
export const layerFromFixture = (
  fixture: Vfs.Fixture,
  volumeOptions?: Vfs.VolumeOptions,
  callerOptions?: Vfs.RootCallerOptions
): Layer.Layer<FileSystem.FileSystem, Vfs.VfsError, Crypto.Crypto> =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function*() {
      const volume = yield* Vfs.fromFixture(fixture, volumeOptions)

      return yield* bind(volume, callerOptions)
    })
  )

/** @internal */
export const make: Effect.Effect<FileSystem.FileSystem, never, Crypto.Crypto> = Effect.gen(function*() {
  const volume = yield* Vfs.fromFixture({ entries: [{ kind: "directory", path: "/tmp" }] })

  return yield* bind(volume)
}).pipe(Effect.orDie)

/** @internal */
export const layer: Layer.Layer<FileSystem.FileSystem, never, Crypto.Crypto> = Layer.effect(FileSystem.FileSystem, make)
