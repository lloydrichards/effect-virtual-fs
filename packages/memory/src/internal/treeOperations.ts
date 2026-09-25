/**
 * Traverses and mutates directory trees for the Effect FileSystem adapter.
 *
 * @internal
 * @since 0.1.0
 */
import type { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import { at, listingNames } from "./adapterSupport.js"
import { resourceError, toPlatformError } from "./platformError.js"

/** @internal */
export const makeTreeOperations = (caller: Vfs.Caller) => {
  const walk = Effect.fnUntraced(function*(path: string) {
    const root = yield* caller.openDirectory(path)
    const pending: Array<{ base: Vfs.DirectoryHandle; prefix: string }> = [{ base: root, prefix: "" }]
    const output: Array<{ relative: string; base: Vfs.DirectoryHandle; name: string; metadata: Vfs.Metadata }> = []

    while (pending.length > 0) {
      const next = pending.pop()

      if (next === undefined) break
      const names = yield* listingNames(yield* caller.readDirectory(next.base), "readDirectory")

      for (const name of names) {
        const relative = next.prefix === "" ? name : `${next.prefix}/${name}`
        const metadata = yield* caller.stat(at(name, next.base, false))
        output.push({ relative, base: next.base, name, metadata })

        if (metadata.kind === "directory") {
          pending.push({ base: yield* caller.openDirectory(at(name, next.base)), prefix: relative })
        }
      }
    }

    return output
  })

  // Removes a directory and everything under it. Like Node, it opens a directory only when removing it finds
  // children, since removing an empty directory needs no permission on the directory itself.
  const removeTree = (target: Vfs.PathInput | Vfs.PathTarget): Effect.Effect<void, Vfs.VfsError> =>
    caller.rmdir(target).pipe(
      Effect.catchIf((error) => error.code === "NotEmpty", () =>
        Effect.scoped(Effect.gen(function*() {
          const directory = yield* caller.openDirectory(target)
          const names = yield* listingNames(yield* caller.readDirectory(directory), "readDirectory")

          for (const name of names) {
            const child = yield* caller.stat(at(name, directory, false))

            yield* child.kind === "directory" ? removeTree(at(name, directory)) : caller.unlink(at(name, directory))
          }

          yield* caller.rmdir(target)
        })))
    )

  const remove: FileSystem.FileSystem["remove"] = Effect.fn("MemoryFileSystem.remove")(function*(path, options) {
    const name = path.split("/").findLast((part) => part.length > 0)

    if (name === undefined || name === "." || name === "..") {
      return yield* resourceError("remove", path, "Cannot remove root or dot entries")
    }

    const action = Effect.scoped(Effect.gen(function*() {
      const node = yield* caller.stat(at(path, undefined, false))

      if (node.kind !== "directory") return yield* caller.unlink(path)

      yield* options?.recursive ? removeTree(path) : caller.rmdir(path)
    }))

    const result = options?.force
      ? action.pipe(Effect.catchIf((error) => error.code === "NotFound", () => Effect.void))
      : action

    return yield* result.pipe(Effect.mapError((error) => toPlatformError(error, "remove", path)))
  })

  const readDirectory: FileSystem.FileSystem["readDirectory"] = Effect.fn("MemoryFileSystem.readDirectory")(
    function*(path, options) {
      const result = options?.recursive
        ? Effect.scoped(walk(path)).pipe(Effect.map((entries) => entries.map((entry) => entry.relative).sort()))
        : caller.readDirectory(path).pipe(
          Effect.flatMap((listing) => listingNames(listing, "readDirectory")),
          Effect.map((names) => names.sort())
        )

      return yield* result.pipe(Effect.mapError((error) => toPlatformError(error, "readDirectory", path)))
    }
  )

  return { walk, remove, readDirectory }
}
