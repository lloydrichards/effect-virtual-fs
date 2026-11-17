import * as Search from "@effect-vfs/core/Search"
import type { Snapshot } from "@effect-vfs/core/Snapshot"
import type * as Vfs from "@effect-vfs/core/VirtualFileSystem"

// @ts-expect-error Engine implementation modules are not published package entrypoints.
import type * as _PrivateCoreModel from "@effect-vfs/core/internal/model"
import type * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type { Equals as Equal } from "effect/Types"

type Assert<A extends true> = A

declare const caller: Vfs.Caller

declare const snapshot: Snapshot

declare const query: Search.GlobQuery

const stat = caller.stat("/")

const opened = caller.open("/file", { access: "read" })

const dataFirst = Search.glob(snapshot, query)

const dataLast = Search.glob(query)(snapshot)

export type StatSuccess = Assert<Equal<Effect.Success<typeof stat>, Vfs.Metadata>>

export type StatFailure = Assert<Equal<Effect.Error<typeof stat>, Vfs.FsFailure>>

export type StatServices = Assert<Equal<Effect.Services<typeof stat>, never>>

export type HandleSuccess = Assert<Equal<Effect.Success<typeof opened>, Vfs.FileHandle>>

export type HandleFailure = Assert<Equal<Effect.Error<typeof opened>, Vfs.FsFailure>>

export type HandleScope = Assert<Equal<Effect.Services<typeof opened>, Scope.Scope>>

export type SearchResult = Assert<Equal<Effect.Success<typeof dataFirst>, Search.GlobReport>>

export type SearchFailure = Assert<Equal<Effect.Error<typeof dataFirst>, Search.GlobFailure>>

export type SearchServices = Assert<Equal<Effect.Services<typeof dataFirst>, never>>

export type SearchOverloads = Assert<Equal<typeof dataFirst, typeof dataLast>>

// @ts-expect-error An arbitrary object is not a caller-owned path, reference or handle.
const _invalidTarget = caller.stat({})

// @ts-expect-error Open access modes must be members of the public access vocabulary.
const _invalidAccess = caller.open("/file", { access: "execute" })

// @ts-expect-error A query requires an explicit root and include list.
const _invalidQuery = Search.glob(snapshot, {})
