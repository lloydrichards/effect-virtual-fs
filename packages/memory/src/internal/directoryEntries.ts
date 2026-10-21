/**
 * Reads bare entry names and their own kinds without following symbolic links.
 * @internal
 * @since 0.9.0
 */
import * as Effect from "effect/Effect"
import { FILE_INFO_TYPE, type FileSystemOperations, textOf } from "./adapterSupport.js"
import { toPlatformError } from "./platformError.js"

// TODO: (#304) Expose this primitive through FileSystem.make when readDirectoryEntries is released.
/** @internal */
export const makeDirectoryEntries = (caller: FileSystemOperations) => (path: string) =>
  caller.readDirectory(path).pipe(
    Effect.flatMap((listing) =>
      Effect.forEach(listing.value, (entry) =>
        Effect.gen(function*() {
          const name = yield* textOf(entry.name, "readDirectoryEntries")
          const metadata = yield* caller.stat(entry.reference)

          return { name, type: FILE_INFO_TYPE[metadata.kind] }
        }))
    ),
    Effect.mapError((error) => toPlatformError(error, "readDirectoryEntries", path))
  )
