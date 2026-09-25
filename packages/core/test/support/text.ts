import * as Effect from "effect/Effect"
import { BytePath } from "../../src/index.js"
import type { DirectoryEntry, ObjectObservation } from "../../src/VirtualFileSystem.js"

const decoder = new TextDecoder()

/** The bytes of a listing, readLink or realPath result as text. */
export const text = (bytes: Uint8Array): string => decoder.decode(bytes)

/**
 * A byte path as text, with invalid UTF-8 decoded as U+FFFD. An absent path, such as the path of an error
 * that names none, stays absent.
 */
export const pathText = (path: BytePath.BytePath | undefined): Effect.Effect<string | undefined> =>
  path === undefined ? Effect.undefined : Effect.map(Effect.orDie(BytePath.toBytes(path)), text)

/** The names in a directory listing, as text, in listing order. */
export const entryNames = (listing: ObjectObservation<ReadonlyArray<DirectoryEntry>>): Array<string> =>
  listing.value.map((entry) => text(entry.name))

/** The names in a directory listing, as bytes, in listing order. */
export const rawEntryNames = (listing: ObjectObservation<ReadonlyArray<DirectoryEntry>>): Array<Uint8Array> =>
  listing.value.map((entry) => entry.name)
