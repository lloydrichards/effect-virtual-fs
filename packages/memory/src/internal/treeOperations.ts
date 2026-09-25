/**
 * Traverses and removes directory trees for the Effect FileSystem adapter over the core walk and remove.
 *
 * @internal
 * @since 0.1.0
 */
import type { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Stream from "effect/Stream"
import { listingNames, textPath } from "./adapterSupport.js"
import { resourceError, toPlatformError } from "./platformError.js"

/** @internal */
export const makeTreeOperations = (caller: Vfs.Caller) => {
  // The entries below a directory, depth first, with their paths relative to it as text. The core walk reads one
  // directory at a time and holds no handle.
  const walk = (path: string) =>
    Stream.runCollect(
      Stream.mapEffect(
        caller.walk(path),
        (entry) => Effect.map(textPath(entry.path, "readDirectory"), (relative) => ({ relative, kind: entry.kind }))
      )
    )

  // Like Node, it removes a directory's entries only when removing the directory finds some, and `force` forgives
  // only the target itself going missing.
  const remove: FileSystem.FileSystem["remove"] = Effect.fn("MemoryFileSystem.remove")(function*(path, options) {
    const name = path.split("/").findLast((part) => part.length > 0)

    if (name === undefined || name === "." || name === "..") {
      return yield* resourceError("remove", path, "Cannot remove root or dot entries")
    }

    yield* caller.remove(path, { recursive: options?.recursive === true, force: options?.force === true }).pipe(
      Effect.mapError((error) => toPlatformError(error, "remove", path))
    )
  })

  const readDirectory: FileSystem.FileSystem["readDirectory"] = Effect.fn("MemoryFileSystem.readDirectory")(
    function*(path, options) {
      const result = options?.recursive
        ? walk(path).pipe(Effect.map((entries) => entries.map((entry) => entry.relative).sort()))
        : caller.readDirectory(path).pipe(
          Effect.flatMap((listing) => listingNames(listing, "readDirectory")),
          Effect.map((names) => names.sort())
        )

      return yield* result.pipe(Effect.mapError((error) => toPlatformError(error, "readDirectory", path)))
    }
  )

  return { walk, remove, readDirectory }
}
