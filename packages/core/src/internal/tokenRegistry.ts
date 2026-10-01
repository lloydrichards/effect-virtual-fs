import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Predicate from "effect/Predicate"
import * as Scope from "effect/Scope"
import { ObjectReferenceId } from "../Caller.js"
import type { FsFailure } from "../VfsError.js"
import type { DirectoryHandle, FileHandle, ObjectReference } from "../VirtualFileSystem.js"
import type { OpContext } from "./errors.js"
import type { Ino, Node } from "./volumeState.js"

/** @internal */
export type HandleLifecycle =
  | { readonly kind: "acquiring" }
  | { readonly kind: "open"; readonly ino: Ino }
  // Cleanup ran before acquisition published. A late publication still needs a release.
  | { readonly kind: "releasedPendingCommit"; readonly ino: Ino | undefined }
  | { readonly kind: "closed" }

/** @internal */
export interface HandleReference {
  readonly volume: symbol
  lifecycle: HandleLifecycle
  scope: Scope.Closeable | undefined
}

/** @internal */
export interface FileReference extends HandleReference {
  offset: bigint
  readonly access: "read" | "write" | "readWrite"
  readonly append: boolean
}

/** @internal */
export type DirectoryReference = HandleReference

/** @internal */
export type Token = ObjectReference | FileHandle | DirectoryHandle

interface ReferenceState {
  readonly volume: symbol
  readonly ino: Ino
}

// Shared across volumes so a genuine token from another registry is distinguishable from a forgery.
const references = new WeakMap<object, ReferenceState>()

const files = new WeakMap<object, FileReference>()

const directories = new WeakMap<object, DirectoryReference>()

/** @internal */
export type Resolution =
  | { readonly kind: "unknown" }
  | { readonly kind: "foreign" }
  | { readonly kind: "stale" }
  | { readonly kind: "live"; readonly node: Node }

/** @internal */
export const inode = (reference: HandleReference): Ino | undefined =>
  reference.lifecycle.kind === "open" || reference.lifecycle.kind === "releasedPendingCommit"
    ? reference.lifecycle.ino
    : undefined

/** @internal */
export const isOpen = (reference: HandleReference): boolean => reference.lifecycle.kind === "open"

/** @internal */
export const publish = (reference: HandleReference, ino: Ino): void => {
  reference.lifecycle = reference.lifecycle.kind === "releasedPendingCommit" || reference.lifecycle.kind === "closed"
    ? { kind: "releasedPendingCommit", ino }
    : { kind: "open", ino }
}

/** @internal */
export const released = (reference: HandleReference): void => {
  reference.lifecycle = reference.lifecycle.kind === "acquiring" ||
      (reference.lifecycle.kind === "releasedPendingCommit" && reference.lifecycle.ino === undefined)
    ? { kind: "releasedPendingCommit", ino: undefined }
    : { kind: "closed" }
}

// A release callback changes the engine's draft; publication may be immediate cleanup or after installation.
/** @internal */
export const release = Effect.fnUntraced(function*<E, R>(
  reference: HandleReference,
  releaseInode: (ino: Ino) => Effect.Effect<void, E, R>,
  afterRelease: (action: () => void) => Effect.Effect<void, never, R>
) {
  const ino = inode(reference)

  yield* afterRelease(() => released(reference))

  if (ino !== undefined) yield* releaseInode(ino)
})

/** @internal */
export const closeReleasedScope = (reference: HandleReference) =>
  Effect.suspend(() =>
    isOpen(reference) || reference.scope === undefined ? Effect.void : Scope.close(reference.scope, Exit.void)
  )

// The inode, rather than the open tag, decides whether a rerun must release a late publication.
/** @internal */
export const finalize = (
  reference: HandleReference,
  close: Effect.Effect<unknown, FsFailure>,
  fallback: Effect.Effect<void>
) =>
  Effect.uninterruptible(Effect.suspend(() =>
    inode(reference) === undefined
      ? Effect.sync(() => released(reference))
      : Effect.ignore(close).pipe(
        Effect.andThen(Effect.suspend(() => inode(reference) === undefined ? Effect.void : fallback))
      )
  ))

// Register before waiting: a closed scope runs its finalizer immediately, and engine permits are not reentrant.
/** @internal */
export const acquire = Effect.fnUntraced(function*<A, E, R, ReleaseR, CoordinateR>(
  reference: HandleReference,
  coordinate: (acquire: Effect.Effect<A, E, R | ReleaseR>) => Effect.Effect<A, E | FsFailure, CoordinateR>,
  acquisition: Effect.Effect<A, E, R>,
  releaseAcquired: () => Effect.Effect<void, never, ReleaseR>,
  finalizer: Effect.Effect<void>
) {
  const scope = yield* Scope.fork(yield* Effect.scope)
  reference.scope = scope
  yield* Scope.addFinalizer(scope, finalizer)
  const closed = () => Predicate.isTagged(scope.state, "Closed")

  return yield* coordinate(
    Effect.suspend(() => closed() ? Effect.interrupt : acquisition).pipe(
      Effect.tap(() =>
        Effect.suspend(() => closed() ? Effect.andThen(releaseAcquired(), Effect.interrupt) : Effect.void)
      )
    )
  ).pipe(
    Effect.tap(() => Effect.suspend(() => closed() ? Effect.interrupt : Effect.void)),
    Effect.onError(() => Effect.andThen(finalizer, Scope.close(scope, Exit.void))),
    Effect.onError(() =>
      Effect.sync(() => {
        if (reference.lifecycle.kind === "releasedPendingCommit" && reference.lifecycle.ino === undefined) {
          reference.lifecycle = { kind: "closed" }
        }
      })
    )
  )
})

/** @internal */
export const nodeOrFail = (result: Resolution, addressing: "reference" | "handle", op: OpContext) => {
  switch (result.kind) {
    case "live":
      return Effect.succeed(result.node)
    case "unknown":
      return Effect.fail(op.fail(addressing === "reference" ? "InvalidReference" : "InvalidHandle"))
    case "foreign":
      return Effect.fail(op.fail(addressing === "reference" ? "ForeignReference" : "ForeignHandle"))
    case "stale":
      return Effect.fail(op.fail(addressing === "reference" ? "StaleReference" : "InvalidHandle"))
  }
}

/** @internal */
export const make = (volume: symbol, get: (ino: Ino) => Effect.Effect<Node | undefined>) => {
  const tokens = new Map<Ino, ObjectReference>()

  const resolveInode = (ino: Ino): Effect.Effect<Resolution> =>
    Effect.map(
      get(ino),
      (node): Resolution =>
        node === undefined || (node.kind === "directory" && node.metadata.nlink === 0)
          ? { kind: "stale" }
          : { kind: "live", node }
    )

  const resolveReference = (token: Token): Effect.Effect<Resolution> =>
    Effect.suspend(() => {
      const known = Predicate.isObject(token) ? references.get(token) : undefined

      if (known === undefined) return Effect.succeed({ kind: "unknown" } as const)

      if (known.volume !== volume) return Effect.succeed({ kind: "foreign" } as const)

      return resolveInode(known.ino)
    })

  const resolveHandle = (token: Token, directoryOnly = false): Effect.Effect<Resolution> =>
    Effect.suspend(() => {
      const known = Predicate.isObject(token)
        ? directories.get(token) ?? (directoryOnly ? undefined : files.get(token))
        : undefined

      if (known === undefined) return Effect.succeed({ kind: "unknown" } as const)

      if (known.volume !== volume) return Effect.succeed({ kind: "foreign" } as const)

      if (!isOpen(known)) return Effect.succeed({ kind: "stale" } as const)
      const ino = inode(known)

      return ino === undefined
        ? Effect.succeed({ kind: "stale" } as const)
        : Effect.map(get(ino), (node): Resolution => node === undefined ? { kind: "stale" } : { kind: "live", node })
    })

  return {
    resolve: (token: Token, addressing: "reference" | "handle" | "directory") =>
      addressing === "reference" ? resolveReference(token) : resolveHandle(token, addressing === "directory"),
    resolveInode,
    referenceFor: (ino: Ino): ObjectReference => {
      const existing = tokens.get(ino)

      if (existing !== undefined) return existing
      const reference = Object.freeze({ [ObjectReferenceId]: true as const })
      references.set(reference, { volume, ino })
      tokens.set(ino, reference)

      return reference
    },
    forget: (ino: Ino) => tokens.delete(ino),
    file: (access: FileReference["access"], append: boolean): FileReference => ({
      volume,
      lifecycle: { kind: "acquiring" },
      scope: undefined,
      offset: 0n,
      access,
      append
    }),
    directory: (ino?: Ino): DirectoryReference => ({
      volume,
      lifecycle: ino === undefined ? { kind: "acquiring" } : { kind: "open", ino },
      scope: undefined
    }),
    registerFile: (handle: FileHandle, reference: FileReference) => files.set(handle, reference),
    registerDirectory: (handle: DirectoryHandle, reference: DirectoryReference) => directories.set(handle, reference)
  }
}

/** @internal */
export type TokenRegistry = ReturnType<typeof make>
