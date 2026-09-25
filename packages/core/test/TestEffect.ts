import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { it as baseIt } from "@effect/vitest"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type { TestContext, TestOptions } from "vitest"
import type { BytePath } from "../src/BytePath.js"
import * as InternalBytePath from "../src/internal/bytePath.js"
import type { DirectoryEntry, ObjectObservation } from "../src/VirtualFileSystem.js"

const effect = <A, E>(
  name: string,
  body: (context: TestContext) => Effect.Effect<A, E, Scope.Scope | Crypto.Crypto>,
  options?: number | TestOptions
): void => baseIt.effect(name, (context) => body(context).pipe(Effect.provide(BunCrypto.layer)), options)

export const it = { effect }

const decoder = new TextDecoder()

/** The bytes of a listing, readLink or realPath result as text. */
export const text = (bytes: Uint8Array): string => decoder.decode(bytes)

/** A byte path as text. */
export const pathText = (path: BytePath): string => decoder.decode(InternalBytePath.getBytes(path))

/** The names in a directory listing, as text, in listing order. */
export const entryNames = (listing: ObjectObservation<ReadonlyArray<DirectoryEntry>>): Array<string> =>
  listing.value.map((entry) => text(entry.name))

/** The names in a directory listing, as bytes, in listing order. */
export const rawEntryNames = (listing: ObjectObservation<ReadonlyArray<DirectoryEntry>>): Array<Uint8Array> =>
  listing.value.map((entry) => entry.name)
