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
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import { at, info, openOptions, sizeInput, textOf, textPath, validateMode } from "./adapterSupport.js"
import { makeCopyOperations } from "./copyOperations.js"
import { makeOpen } from "./fileHandle.js"
import { makeGlob } from "./glob.js"
import { argumentError, toPlatformError } from "./platformError.js"
import { makeTreeOperations } from "./treeOperations.js"

/** @internal */
export const isWatchOverflow = (error: PlatformError): boolean =>
  Predicate.isTagged("Unknown")(error.reason) &&
  error.reason.module === "FileSystem" &&
  error.reason.method === "watch" &&
  error.reason.description === "WatchOverflow"

const MAX_TEMPORARY_CLEANUP_ATTEMPTS = 3

const childPath = (parent: string, name: string) => parent === "/" ? `/${name}` : `${parent}/${name}`

/** @internal */
export const bind = Effect.fnUntraced(function*(volume: Vfs.Volume, options?: Vfs.RootCallerOptions) {
  const caller = yield* volume.caller({ ...options, umask: options?.umask ?? 0 })

  return yield* bindCaller(caller)
})

/** @internal */
export const bindCaller = (caller: Vfs.Caller): Effect.Effect<FileSystem.FileSystem> =>
  Effect.sync(() => {
    let nextTemporary = 1

    const makeDirectory = Effect.fnUntraced(
      function*(path: string, options?: { recursive?: boolean | undefined; mode?: number | undefined }) {
        yield* validateMode(options?.mode, "makeDirectory")
        const mode = (options?.mode ?? 0o755) & 0o7777

        // A recursive mkdir creates the path's missing directories in one change, each with the mode, as Node gives
        // each the mode; the final directory is never searched, so a mode without owner search does not fail it.
        yield* caller.mkdir(path, { mode, recursive: options?.recursive === true }).pipe(
          Effect.mapError((error) => toPlatformError(error, "makeDirectory", path))
        )
      }
    )

    const open = makeOpen(caller)

    const { remove, readDirectory } = makeTreeOperations(caller)
    const { copy, copyFile } = makeCopyOperations(caller, caller.limits)

    const temp = Effect.fnUntraced(
      function*(
        method: string,
        kind: "directory" | "file",
        options?: { directory?: string | undefined; prefix?: string | undefined; suffix?: string | undefined }
      ) {
        for (const value of [options?.prefix ?? "", options?.suffix ?? ""]) {
          if (value.includes("/") || value.includes("\0")) {
            return yield* argumentError(method, "temporary fragments cannot contain separators")
          }
        }

        const parent = yield* caller.realPath(options?.directory ?? "/tmp").pipe(
          Effect.flatMap((path) => textPath(path, method)),
          Effect.mapError((error) => toPlatformError(error, method, options?.directory ?? "/tmp"))
        )

        while (true) {
          const directory = childPath(
            parent,
            `${options?.prefix ?? ""}${(nextTemporary++).toString(36).padStart(8, "0")}`
          )

          const result = yield* Effect.result(caller.mkdir(directory))

          if (Result.isFailure(result)) {
            if (result.failure.code === "AlreadyExists") continue

            return yield* toPlatformError(result.failure, method, directory)
          }

          const reference = result.success.reference

          if (kind === "directory") return { path: directory, reference }

          const path = childPath(
            directory,
            `${(nextTemporary++).toString(36).padStart(8, "0")}${options?.suffix ?? ""}`
          )

          yield* caller.writeFile(path, new Uint8Array(0), { access: "write", create: "exclusive", mode: 0o644 }).pipe(
            Effect.mapError((error) => toPlatformError(error, method, path)),
            Effect.onError(() => cleanupTemporary({ reference, path: directory }))
          )

          return { path, reference }
        }
      }
    )

    // Resolve identity again on each attempt: a trusted rename can race cleanup.
    const cleanupTemporary = Effect.fnUntraced(function*(temporary: { reference: Vfs.ObjectReference; path: string }) {
      for (let attempt = 0; attempt < MAX_TEMPORARY_CLEANUP_ATTEMPTS; attempt++) {
        const result = yield* Effect.result(Effect.gen(function*() {
          const path = yield* caller.realPath(temporary.reference)
          yield* caller.remove(path, { recursive: true, expected: temporary.reference })
        }))

        if (Result.isSuccess(result)) return
        const error = result.failure

        if (error.code === "VolumeBusy" || error.code === "NotFound") continue

        if (
          ["AccessDenied", "ClosedCaller", "InvalidHandle", "StaleReference", "NotPermitted"].includes(
            error.code
          )
        ) return

        return yield* Effect.die(toPlatformError(error, "remove", temporary.path))
      }
    })

    return FileSystem.make({
      access: (path) =>
        caller.stat(path).pipe(
          Effect.asVoid,
          Effect.mapError((error) => toPlatformError(error, "access", path))
        ),
      stat: (path) =>
        caller.stat(path).pipe(
          Effect.mapError((error) => toPlatformError(error, "stat", path)),
          Effect.flatMap((value) => info(value, path))
        ),
      chmod: Effect.fnUntraced(function*(path, mode) {
        yield* validateMode(mode, "chmod")
        yield* caller.chmod(path, mode & 0o7777).pipe(Effect.mapError((error) => toPlatformError(error, "chmod", path)))
      }),
      chown: Effect.fnUntraced(function*(path, uid, gid) {
        if (![uid, gid].every((id) => Number.isInteger(id) && id >= 0 && id <= 0xffffffff)) {
          return yield* argumentError("chown", "owner IDs must be unsigned 32-bit integers")
        }

        yield* caller.chown(path, { uid, gid }).pipe(Effect.mapError((error) => toPlatformError(error, "chown", path)))
      }),
      utimes: Effect.fnUntraced(function*(path, atime, mtime) {
        const access = Predicate.isNumber(atime) ? atime * 1000 : atime.getTime()
        const modification = Predicate.isNumber(mtime) ? mtime * 1000 : mtime.getTime()

        if (![access, modification].every((value) => Number.isFinite(value) && Math.abs(value) <= 8.64e15)) {
          return yield* argumentError("utimes", "timestamps must be valid dates")
        }

        yield* caller.utimes(path, {
          access: { kind: "value", nanoseconds: BigInt(Math.trunc(access)) * 1_000_000n },
          modification: { kind: "value", nanoseconds: BigInt(Math.trunc(modification)) * 1_000_000n }
        }).pipe(Effect.mapError((error) => toPlatformError(error, "utimes", path)))
      }),
      open,
      makeDirectory,
      readDirectory,
      remove,
      copy,
      copyFile,
      readFile: (path) =>
        caller.readFile(path).pipe(Effect.mapError((error) => toPlatformError(error, "readFile", path))),
      writeFile: Effect.fnUntraced(function*(path, data, options) {
        const bytes = new Uint8Array(data)
        const chosen = yield* openOptions(options?.flag ?? "w", options?.mode, "writeFile")
        yield* caller.writeFile(path, bytes, chosen).pipe(
          Effect.mapError((error) => toPlatformError(error, "writeFile", path))
        )
      }),
      readLink: (path) =>
        caller.readLink(path).pipe(
          Effect.flatMap((bytes) => textOf(bytes, "readLink")),
          Effect.mapError((error) => toPlatformError(error, "readLink", path))
        ),
      realPath: (path) =>
        caller.realPath(path).pipe(
          Effect.flatMap((resolved) => textPath(resolved, "realPath")),
          Effect.mapError((error) => toPlatformError(error, "realPath", path))
        ),
      rename: Effect.fnUntraced(
        function*(source, destination) {
          const sourceInfo = yield* caller.stat(at(source, { followFinalSymlink: false }))

          const target = sourceInfo.kind === "directory" && destination.endsWith("/")
            ? destination.replace(/\/+$/, "") || "/"
            : destination

          yield* caller.rename(source, target)
        },
        (effect, source) => effect.pipe(Effect.mapError((error) => toPlatformError(error, "rename", source)))
      ),
      link: (source, destination) =>
        caller.link(source, destination).pipe(
          Effect.mapError((error) => toPlatformError(error, "link", source))
        ),
      symlink: (target, path) =>
        caller.symlink(target, path).pipe(
          Effect.mapError((error) => toPlatformError(error, "symlink", path))
        ),
      truncate: Effect.fnUntraced(function*(path, length) {
        yield* caller.truncate(path, yield* sizeInput(length, "truncate", 0)).pipe(
          Effect.mapError((error) => toPlatformError(error, "truncate", path))
        )
      }),
      makeTempDirectory: (options) =>
        temp("makeTempDirectory", "directory", options).pipe(Effect.map((value) => value.path)),
      makeTempFile: (options) => temp("makeTempFile", "file", options).pipe(Effect.map((value) => value.path)),
      makeTempDirectoryScoped: (options) =>
        Effect.acquireRelease(temp("makeTempDirectoryScoped", "directory", options), cleanupTemporary).pipe(
          Effect.map((value) => value.path)
        ),
      makeTempFileScoped: (options) =>
        Effect.acquireRelease(temp("makeTempFileScoped", "file", options), cleanupTemporary).pipe(
          Effect.map((value) => value.path)
        ),
      watch: (path, options) =>
        Stream.unwrap(
          caller.watch(path, { recursive: options?.recursive === true, alias: "resolved" }).pipe(
            Effect.mapError((error) => toPlatformError(error, "watch", path)),
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
        ),
      glob: makeGlob(caller)
    })
  })

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
