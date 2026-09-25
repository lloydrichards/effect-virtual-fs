/**
 * Implements the Effect `FileSystem` adapter over `@effect-vfs/core`.
 *
 * This module binds a core volume to Effect's service. Separate internal modules
 * own error conversion, file cursors, traversal, and copy behavior.
 *
 * @internal
 * @since 0.1.0
 */
import { BytePath, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import { type PlatformError, systemError } from "effect/PlatformError"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { at, info, openOptions, sizeInput, textOf, textPath, validateMode } from "./adapterSupport.js"
import { makeCopyOperations } from "./copyOperations.js"
import { makeOpen } from "./fileHandle.js"
import { compileGlobPatterns, matchesGlob } from "./glob.js"
import { argumentError, toPlatformError } from "./platformError.js"
import { makeTreeOperations } from "./treeOperations.js"

/** @internal */
export const isWatchOverflow = (error: PlatformError): boolean =>
  Predicate.isTagged("Unknown")(error.reason) &&
  error.reason.module === "FileSystem" &&
  error.reason.method === "watch" &&
  error.reason.description === "WatchOverflow"

// Registrations a watch makes before giving up on a path that keeps changing as it opens.
const MAX_WATCH_ATTEMPTS = 3

const childPath = (parent: string, name: string) => parent === "/" ? `/${name}` : `${parent}/${name}`

/** @internal */
export const bind = Effect.fn("MemoryFileSystem.bind")(function*(volume: Vfs.Volume, options?: Vfs.RootCallerOptions) {
  const caller = yield* volume.caller({ ...options, umask: options?.umask ?? 0 })
  let nextTemporary = 1

  const makeDirectory = Effect.fn("MemoryFileSystem.makeDirectory")(
    function*(path: string, options?: { recursive?: boolean | undefined; mode?: number | undefined }) {
      yield* validateMode(options?.mode, "makeDirectory")
      const mode = (options?.mode ?? 0o755) & 0o7777

      if (!options?.recursive) {
        return yield* caller.mkdir(path, { mode }).pipe(
          Effect.mapError((error) => toPlatformError(error, "makeDirectory", path))
        )
      }

      return yield* Effect.scoped(Effect.gen(function*() {
        if (path === "") return yield* new Vfs.VfsError({ code: "NotFound", operation: "makeDirectory" })
        let base = yield* caller.openDirectory("/")
        const components = path.split("/").filter((part) => part.length > 0)

        for (const [index, name] of components.entries()) {
          const result = yield* Effect.result(caller.mkdir(at(name, base), { mode }))

          if (Result.isFailure(result) && result.failure.code !== "AlreadyExists") return yield* result.failure

          // The new leaf is never opened, so a mode without owner search does not fail the call, as in Node; an
          // existing leaf must be a directory.
          if (index === components.length - 1) {
            if (Result.isFailure(result) && (yield* caller.stat(at(name, base))).kind !== "directory") {
              return yield* new Vfs.VfsError({ code: "AlreadyExists", operation: "makeDirectory" })
            }

            break
          }

          const next = yield* caller.openDirectory(at(name, base))
          yield* base.close
          base = next
        }
      })).pipe(Effect.mapError((error) => toPlatformError(error, "makeDirectory", path)))
    }
  )

  const open = makeOpen(caller)

  const { walk, remove, readDirectory } = makeTreeOperations(caller)
  const { copy, copyFile } = makeCopyOperations(caller, volume.limits)

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

        if (kind === "directory") return directory
        const path = childPath(directory, `${(nextTemporary++).toString(36).padStart(8, "0")}${options?.suffix ?? ""}`)
        yield* caller.writeFile(path, new Uint8Array(0), { access: "write", create: "exclusive", mode: 0o644 }).pipe(
          Effect.mapError((error) => toPlatformError(error, method, path)),
          Effect.onError(() => remove(directory, { recursive: true, force: true }).pipe(Effect.orDie))
        )

        return path
      }
    }
  )

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
        const sourceInfo = yield* caller.stat(at(source, undefined, false))

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
    makeTempDirectory: (options) => temp("makeTempDirectory", "directory", options),
    makeTempFile: (options) => temp("makeTempFile", "file", options),
    makeTempDirectoryScoped: (options) =>
      Effect.acquireRelease(
        temp("makeTempDirectoryScoped", "directory", options),
        (path) => remove(path, { recursive: true, force: true }).pipe(Effect.orDie)
      ),
    makeTempFileScoped: (options) =>
      Effect.acquireRelease(
        temp("makeTempFileScoped", "file", options),
        (path) => remove(path.slice(0, path.lastIndexOf("/")), { recursive: true, force: true }).pipe(Effect.orDie)
      ),
    // The watch is scoped to the object the path resolves to, so it follows renames of the path and its ancestors.
    // A change can land between resolving the path and registering the watch, so a registration is kept only when
    // the path still names its object once the watch is active; otherwise it is closed and the path resolved again.
    // A watched file reports only the changes made under the watched name, carried across those renames, not the
    // changes made under its other hard links.
    watch: (path, options) =>
      Stream.unwrap(
        Effect.gen(function*() {
          const parent = yield* Effect.scope

          // lookup resolves a child entry, so the root is reached through caller.root.
          const namesObject = (name: string, object: Vfs.ObjectReference) =>
            Effect.flatMap(
              caller.realPath(name),
              (resolved) => BytePath.isRoot(resolved) ? caller.root : caller.lookup(resolved)
            ).pipe(Effect.map((current) => current === object), Effect.orElseSucceed(() => false))

          for (let attempt = 1;; attempt++) {
            const resolved = yield* caller.realPath(path)
            const scope = BytePath.isRoot(resolved) ? yield* caller.root : yield* caller.lookup(resolved)
            const file = (yield* caller.stat(scope)).kind !== "directory"
            let watchedName = yield* textPath(resolved, "watch")
            const registration = yield* Scope.fork(parent)

            const opened = yield* volume.watch({ scope, recursive: options?.recursive === true }).pipe(
              Scope.provide(registration),
              Effect.result
            )

            if (Result.isSuccess(opened)) {
              if (yield* namesObject(path, scope)) {
                return opened.success.pipe(
                  Stream.mapEffect((event) => {
                    if (Predicate.isTagged("Rescan")(event)) {
                      return Effect.fail(
                        systemError({
                          module: "FileSystem",
                          method: "watch",
                          pathOrDescriptor: path,
                          _tag: "Unknown",
                          description: "WatchOverflow"
                        })
                      )
                    }

                    const tag = event._tag

                    return textPath(event.path, "watch").pipe(
                      Effect.mapError((error) => toPlatformError(error, "watch", path)),
                      Effect.map((name) => ({ _tag: tag, path: name }))
                    )
                  }),
                  Stream.filterEffect((change) => {
                    if (!file || change.path === watchedName) return Effect.succeed(true)

                    // Core reports the object at its current name, so a change under another name follows a rename
                    // of the file or an ancestor unless the watched name still names the object: then it came
                    // through another hard link. A file with one link has no other name to confuse it with.
                    return Effect.gen(function*() {
                      if (yield* namesObject(watchedName, scope)) return false

                      const links = yield* caller.stat(scope).pipe(
                        Effect.map((metadata) => metadata.nlink),
                        Effect.orElseSucceed(() => 0)
                      )

                      if (links > 1 && !(yield* namesObject(change.path, scope))) return false
                      watchedName = change.path

                      return true
                    })
                  })
                )
              }
            } else if (opened.failure.code !== "StaleReference") {
              return yield* opened.failure
            }

            yield* Scope.close(registration, Exit.void)

            if (attempt === MAX_WATCH_ATTEMPTS) {
              return yield* new Vfs.VfsError({ code: "VolumeBusy", operation: "watch" })
            }
          }
        }).pipe(Effect.mapError((error) => toPlatformError(error, "watch", path)))
      ),
    glob: Effect.fnUntraced(function*(pattern, options) {
      const include = yield* compileGlobPatterns("glob", pattern)

      const exclude = (yield* Effect.forEach(options?.exclude ?? [], (pattern) => compileGlobPatterns("glob", pattern)))
        .flat()

      return yield* Effect.scoped(Effect.gen(function*() {
        const entries = yield* walk(options?.root ?? "/")

        if (exclude.some((pattern) => matchesGlob(pattern, [], true))) return []
        const output = include.some((pattern) => matchesGlob(pattern, [], true)) ? ["."] : []
        const excludedDirectories: Array<string> = []

        for (const entry of entries) {
          const parts = entry.relative.split("/")
          const directory = entry.metadata.kind === "directory"

          const excluded = excludedDirectories.some((prefix) => entry.relative.startsWith(`${prefix}/`)) ||
            exclude.some((pattern) => matchesGlob(pattern, parts, directory))

          if (excluded) {
            if (directory) excludedDirectories.push(entry.relative)
            continue
          }

          if (include.some((pattern) => matchesGlob(pattern, parts, directory))) output.push(entry.relative)
        }

        return output.sort()
      })).pipe(Effect.mapError((error) => toPlatformError(error, "glob", options?.root ?? "/")))
    })
  })
})

/** @internal */
export const make: Effect.Effect<FileSystem.FileSystem> = Effect.gen(function*() {
  const volume = yield* Vfs.fromFixture({ entries: [{ kind: "directory", path: "/tmp" }] })

  return yield* bind(volume)
}).pipe(Effect.orDie)

/** @internal */
export const layer: Layer.Layer<FileSystem.FileSystem> = Layer.effect(FileSystem.FileSystem, make)
