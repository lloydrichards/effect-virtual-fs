/**
 * Implements file and directory copying for the Effect FileSystem adapter.
 *
 * @internal
 * @since 0.1.0
 */
import { VfsError } from "@effect-vfs/core/VfsError"
import type * as Vfs from "@effect-vfs/core/VirtualFileSystem"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Result from "effect/Result"
import { at, type FileSystemOperations, textPath } from "./adapterSupport.js"
import { copyTree } from "./copyTree.js"
import { toPlatformError } from "./platformError.js"

/** @internal */
export const makeCopyOperations = (caller: FileSystemOperations, limits: Vfs.VolumeLimits) => {
  const writeCopiedFile = (
    destination: Vfs.PathInput,
    bytes: Uint8Array,
    mode: number,
    options: Pick<Vfs.WriteFileOptions, "create" | "replaceFinalSymlink">
  ) =>
    caller.writeFile(destination, bytes, {
      ...options,
      access: "write",
      truncate: true,
      mode,
      finalMode: mode
    })

  const copy: FileSystem.FileSystem["copy"] = Effect.fnUntraced(
    function*(source, destination, options) {
      return yield* Effect.gen(function*() {
        const sourceNode = yield* caller.stat(at(source, { followFinalSymlink: false }))
        const existing = yield* Effect.result(caller.stat(at(destination, { followFinalSymlink: false })))

        if (Result.isFailure(existing) && existing.failure.code !== "NotFound") return yield* existing.failure

        if (Result.isSuccess(existing) && existing.success.ino === sourceNode.ino) {
          return yield* new VfsError({ code: "InvalidArgument", operation: "copy" })
        }

        if (Result.isSuccess(existing) && !options?.overwrite) {
          return yield* new VfsError({ code: "AlreadyExists", operation: "copy" })
        }

        if (sourceNode.kind === "directory") {
          const canonicalSource = yield* textPath(yield* caller.realPath(source), "copy")
          const trimmed = destination.replace(/\/+$/, "") || "/"
          const slash = trimmed.lastIndexOf("/")
          const parentPath = slash <= 0 ? "/" : trimmed.slice(0, slash)
          const parent = yield* textPath(yield* caller.realPath(parentPath), "copy")

          if (canonicalSource === "/" || parent === canonicalSource || parent.startsWith(`${canonicalSource}/`)) {
            return yield* new VfsError({ code: "InvalidArgument", operation: "copy" })
          }
        }

        yield* copyTree(caller, source, destination, limits, options)
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.failCause(Cause.map(cause, (error) => toPlatformError(error, "copy", source)))
        )
      )
    }
  )

  const copyFile: FileSystem.FileSystem["copyFile"] = Effect.fnUntraced(
    function*(source, destination) {
      return yield* Effect.gen(function*() {
        const metadata = yield* caller.stat(source)

        if (metadata.kind !== "file") return yield* new VfsError({ code: "IsDirectory", operation: "copyFile" })
        const target = yield* Effect.result(caller.stat(destination))

        if (Result.isSuccess(target) && target.success.ino === metadata.ino) return
        yield* writeCopiedFile(destination, yield* caller.readFile(source), metadata.mode, { create: "ifMissing" })
      }).pipe(Effect.mapError((error) => toPlatformError(error, "copyFile", source)))
    }
  )

  return { copy, copyFile }
}
