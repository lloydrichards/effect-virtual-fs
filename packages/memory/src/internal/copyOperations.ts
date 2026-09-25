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
import * as Stream from "effect/Stream"
import { toPlatformError } from "./platformError.js"
import { fromCaller, toCaller, volumeLimits } from "./treeTransfer.js"

/** @internal */
export const makeCopyOperations = (caller: Vfs.Caller, limits: Vfs.VolumeLimits) => {
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
      return yield* Effect.gen(function*() {
        const sourceNode = yield* caller.lstat(source)
        const existing = yield* Effect.result(caller.lstat(destination))

        if (Result.isFailure(existing) && existing.failure.code !== "NotFound") return yield* existing.failure

        if (Result.isSuccess(existing) && existing.success.ino === sourceNode.ino) {
          return yield* new Vfs.VfsError({ code: "InvalidArgument", operation: "copy" })
        }

        if (Result.isSuccess(existing) && !options?.overwrite) {
          return yield* new Vfs.VfsError({ code: "AlreadyExists", operation: "copy" })
        }

        if (sourceNode.kind === "directory") {
          const canonicalSource = yield* caller.realPath(source)
          const trimmed = destination.replace(/\/+$/, "") || "/"
          const slash = trimmed.lastIndexOf("/")
          const parentPath = slash <= 0 ? "/" : trimmed.slice(0, slash)
          const parent = yield* caller.realPath(parentPath)

          if (canonicalSource === "/" || parent === canonicalSource || parent.startsWith(`${canonicalSource}/`)) {
            return yield* new Vfs.VfsError({ code: "InvalidArgument", operation: "copy" })
          }
        }

        yield* Stream.run(
          fromCaller(caller, source, { limits: volumeLimits(limits) }),
          toCaller(caller, destination, {
            existing: options?.overwrite ? "overwrite" : "reject",
            times: options?.preserveTimestamps ? "all" : "none",
            specialBits: true
          })
        ).pipe(Effect.catchTag("TransferError", (error) =>
          Effect.fail(
            new Vfs.VfsError({
              code: error.code === "LimitExceeded" ? "NoSpace" : "InvalidArgument",
              operation: "copy"
            })
          )))
      }).pipe(Effect.mapError((error) => toPlatformError(error, "copy", source)))
    }
  )

  const copyFile: FileSystem.FileSystem["copyFile"] = Effect.fn("MemoryFileSystem.copyFile")(
    function*(source, destination) {
      return yield* Effect.gen(function*() {
        const metadata = yield* caller.stat(source)

        if (metadata.kind !== "file") return yield* new Vfs.VfsError({ code: "IsDirectory", operation: "copyFile" })
        const target = yield* Effect.result(caller.stat(destination))

        if (Result.isSuccess(target) && target.success.ino === metadata.ino) return
        yield* writeCopiedFile(destination, yield* caller.readFile(source), metadata.mode, { create: "ifMissing" })
      }).pipe(Effect.mapError((error) => toPlatformError(error, "copyFile", source)))
    }
  )

  return { copy, copyFile }
}
