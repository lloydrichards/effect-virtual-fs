/**
 * Traverses and mutates directory trees for the Effect FileSystem adapter.
 *
 * @internal
 * @since 0.1.0
 */
import type { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
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
      const names = yield* caller.readDirectory(".", { relativeTo: next.base })

      for (const name of names) {
        const relative = next.prefix === "" ? name : `${next.prefix}/${name}`
        const metadata = yield* caller.lstat(name, { relativeTo: next.base })
        output.push({ relative, base: next.base, name, metadata })

        if (metadata.kind === "directory") {
          pending.push({ base: yield* caller.openDirectory(name, { relativeTo: next.base }), prefix: relative })
        }
      }
    }

    return output
  })

  const remove: FileSystem.FileSystem["remove"] = Effect.fn("MemoryFileSystem.remove")(function*(path, options) {
    const name = path.split("/").findLast((part) => part.length > 0)

    if (name === undefined || name === "." || name === "..") {
      return yield* resourceError("remove", path, "Cannot remove root or dot entries")
    }

    const action = Effect.scoped(Effect.gen(function*() {
      const node = yield* caller.lstat(path)

      if (node.kind !== "directory") return yield* caller.unlink(path)

      if (options?.recursive) {
        const entries = yield* walk(path)

        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i]

          if (entry === undefined) continue
          const relative = { relativeTo: entry.base }
          yield* entry.metadata.kind === "directory"
            ? caller.rmdir(entry.name, relative)
            : caller.unlink(entry.name, relative)
        }
      }

      yield* caller.rmdir(path)
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
        : caller.readDirectory(path).pipe(Effect.map((names) => [...names].sort()))

      return yield* result.pipe(Effect.mapError((error) => toPlatformError(error, "readDirectory", path)))
    }
  )

  return { walk, remove, readDirectory }
}
