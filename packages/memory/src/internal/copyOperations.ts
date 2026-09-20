/**
 * Implements file and directory copying for the Effect FileSystem adapter.
 *
 * @internal
 * @since 0.1.0
 */
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Result from "effect/Result"
import { toPlatformError } from "./platformError.js"
import type { makeTreeOperations } from "./treeOperations.js"

/** @internal */
export const makeCopyOperations = (caller: Vfs.Caller, walk: ReturnType<typeof makeTreeOperations>["walk"]) => {
  const writeCopiedFile = (
    destination: Vfs.PathInput,
    bytes: Uint8Array,
    mode: number,
    options: Pick<Vfs.WriteFileOptions, "relativeTo" | "create" | "replaceFinalSymlink">
  ) =>
    caller.writeFile(destination, bytes, {
      ...options,
      access: "write",
      truncate: true,
      mode,
      finalMode: mode
    })

  const copy: FileSystem.FileSystem["copy"] = Effect.fn("MemoryFileSystem.copy")(
    function*(source, destination, options) {
      return yield* Effect.scoped(Effect.gen(function*() {
        const sourceNode = yield* caller.lstat(source)
        const existing = yield* Effect.result(caller.lstat(destination))

        if (Result.isFailure(existing) && existing.failure.code !== "NotFound") return yield* existing.failure

        if (Result.isSuccess(existing) && existing.success.ino === sourceNode.ino) {
          return yield* new Vfs.FsError({ code: "InvalidArgument", operation: "copy" })
        }

        if (Result.isSuccess(existing) && !options?.overwrite) {
          return yield* new Vfs.FsError({ code: "AlreadyExists", operation: "copy" })
        }

        if (sourceNode.kind === "file") {
          const bytes = yield* caller.readFile(source)
          yield* writeCopiedFile(destination, bytes, sourceNode.mode, {
            create: options?.overwrite ? "ifMissing" : "exclusive",
            replaceFinalSymlink: true
          })
        } else if (sourceNode.kind === "symlink") {
          if (Result.isSuccess(existing)) {
            yield* caller.unlink(destination)
          }

          yield* caller.symlink(yield* caller.readLink(source), destination)
        } else {
          const canonicalSource = yield* caller.realPath(source)
          const trimmed = destination.replace(/\/+$/, "") || "/"
          const slash = trimmed.lastIndexOf("/")
          const parentPath = slash <= 0 ? "/" : trimmed.slice(0, slash)
          const parent = yield* caller.realPath(parentPath)

          if (canonicalSource === "/" || parent === canonicalSource || parent.startsWith(`${canonicalSource}/`)) {
            return yield* new Vfs.FsError({ code: "InvalidArgument", operation: "copy" })
          }

          const entries = yield* walk(source)

          if (Result.isFailure(existing)) {
            yield* caller.mkdir(destination, { mode: sourceNode.mode })
          } else if (existing.success.kind !== "directory") {
            return yield* new Vfs.FsError({ code: "NotDirectory", operation: "copy" })
          }

          const copiedNodes = new Map<bigint, { base: Vfs.DirectoryHandle; name: string }>()
          const directoryTimes: Array<{ base: Vfs.DirectoryHandle; name: string; metadata: Vfs.Metadata }> = []
          const bases = new Map<string, Vfs.DirectoryHandle>([["", yield* caller.openDirectory(destination)]])

          for (const entry of entries) {
            const split = entry.relative.lastIndexOf("/")
            const parent = bases.get(split < 0 ? "" : entry.relative.slice(0, split))

            if (parent === undefined) {
              return yield* new Vfs.FsError({ code: "NotFound", operation: "copy" })
            }

            const relative = { relativeTo: parent }

            if (entry.metadata.kind === "directory") {
              const made = yield* Effect.result(caller.mkdir(entry.name, { ...relative, mode: entry.metadata.mode }))

              if (Result.isFailure(made) && (!options?.overwrite || made.failure.code !== "AlreadyExists")) {
                return yield* made.failure
              }

              if (Result.isFailure(made) && (yield* caller.lstat(entry.name, relative)).kind !== "directory") {
                return yield* new Vfs.FsError({ code: "NotDirectory", operation: "copy" })
              }

              bases.set(entry.relative, yield* caller.openDirectory(entry.name, relative))
            } else if (entry.metadata.kind === "file") {
              const previous = copiedNodes.get(entry.metadata.ino)
              const existing = yield* Effect.result(caller.lstat(entry.name, relative))

              if (previous !== undefined && Result.isFailure(existing) && existing.failure.code === "NotFound") {
                yield* caller.link(previous.name, entry.name, {
                  sourceRelativeTo: previous.base,
                  destinationRelativeTo: parent
                })
              } else {
                yield* writeCopiedFile(
                  entry.name,
                  yield* caller.readFile(entry.name, { relativeTo: entry.base }),
                  entry.metadata.mode,
                  {
                    ...relative,
                    create: options?.overwrite ? "ifMissing" : "exclusive",
                    replaceFinalSymlink: true
                  }
                )
                copiedNodes.set(entry.metadata.ino, { base: parent, name: entry.name })
              }
            } else {
              const previous = copiedNodes.get(entry.metadata.ino)
              const existing = yield* Effect.result(caller.lstat(entry.name, relative))

              if (Result.isSuccess(existing)) {
                if (!options?.overwrite) {
                  return yield* new Vfs.FsError({ code: "AlreadyExists", operation: "copy" })
                }

                yield* caller.unlink(entry.name, relative)
              } else if (existing.failure.code !== "NotFound") return yield* existing.failure

              if (previous !== undefined) {
                yield* caller.link(previous.name, entry.name, {
                  sourceRelativeTo: previous.base,
                  destinationRelativeTo: parent
                })
              } else {
                yield* caller.symlink(
                  yield* caller.readLink(entry.name, { relativeTo: entry.base }),
                  entry.name,
                  relative
                )
                copiedNodes.set(entry.metadata.ino, { base: parent, name: entry.name })
              }
            }

            if (options?.preserveTimestamps && entry.metadata.kind === "directory") {
              directoryTimes.push({ base: parent, name: entry.name, metadata: entry.metadata })
            }

            if (options?.preserveTimestamps && entry.metadata.kind !== "directory") {
              yield* caller.utimes(entry.name, {
                access: { kind: "value", nanoseconds: entry.metadata.atimeNs },
                modification: { kind: "value", nanoseconds: entry.metadata.mtimeNs }
              }, { ...relative, followFinalSymlink: false })
            }
          }

          for (const directory of directoryTimes.reverse()) {
            yield* caller.utimes(directory.name, {
              access: { kind: "value", nanoseconds: directory.metadata.atimeNs },
              modification: { kind: "value", nanoseconds: directory.metadata.mtimeNs }
            }, { relativeTo: directory.base })
          }
        }

        if (options?.preserveTimestamps) {
          yield* caller.utimes(destination, {
            access: { kind: "value", nanoseconds: sourceNode.atimeNs },
            modification: { kind: "value", nanoseconds: sourceNode.mtimeNs }
          }, { followFinalSymlink: false })
        }
      })).pipe(Effect.mapError((error) => toPlatformError(error, "copy", source)))
    }
  )

  const copyFile: FileSystem.FileSystem["copyFile"] = Effect.fn("MemoryFileSystem.copyFile")(
    function*(source, destination) {
      return yield* Effect.gen(function*() {
        const metadata = yield* caller.stat(source)

        if (metadata.kind !== "file") return yield* new Vfs.FsError({ code: "IsDirectory", operation: "copyFile" })
        const target = yield* Effect.result(caller.stat(destination))

        if (Result.isSuccess(target) && target.success.ino === metadata.ino) return
        yield* writeCopiedFile(destination, yield* caller.readFile(source), metadata.mode, { create: "ifMissing" })
      }).pipe(Effect.mapError((error) => toPlatformError(error, "copyFile", source)))
    }
  )

  return { copy, copyFile }
}
