/**
 * Compile-only sketch for issue #96.
 *
 * This file models the proposed public API. It deliberately contains no
 * implementation so the contract can be reviewed before core changes begin.
 */
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Schema } from "effect"
import type { Effect, Scope } from "effect"

/**
 * Core validates and owns each component before waiting for the volume gate.
 * Adapters may reject additional protocol-specific names before calling core.
 */
type Name = Uint8Array

/**
 * The revision transition for one directory observed inside one operation.
 * Equal revisions represent a successful operation that did not change its namespace.
 */
export const DirectoryChange = Schema.Struct({
  before: Schema.BigInt,
  after: Schema.BigInt
})

export type DirectoryChange = typeof DirectoryChange.Type

/** A namespace operation that leaves one named object at its destination. */
export interface ReferenceEntryResult {
  readonly reference: Vfs.ObjectReference
  readonly directory: DirectoryChange
}

/** Rename changes one unique directory or two distinct directories. */
export const RenameReferenceResult = Schema.TaggedUnion({
  SameDirectory: { directory: DirectoryChange },
  DifferentDirectories: {
    sourceDirectory: DirectoryChange,
    destinationDirectory: DirectoryChange
  }
})

export type RenameReferenceResult = typeof RenameReferenceResult.Type

/** Creation metadata for a new directory. */
export const MkdirReferenceSettings = Schema.Struct({
  mode: Vfs.OpenSettings.fields.mode,
  times: Schema.optionalKey(Vfs.Times)
})

export type MkdirReferenceSettings = typeof MkdirReferenceSettings.Type

/** A symbolic link has fixed creation permissions but may receive initial times. */
export const SymlinkReferenceSettings = Schema.Struct({
  times: Schema.optionalKey(Vfs.Times)
})

export type SymlinkReferenceSettings = typeof SymlinkReferenceSettings.Type

/**
 * Opening an existing reference cannot create, choose a creation mode, or
 * follow a final symbolic link: the reference already identifies the object.
 */
export const OpenReferenceSettings = Schema.Struct({
  access: Schema.Literals(["read", "write", "readWrite"]),
  append: Schema.optionalKey(Schema.Boolean),
  truncate: Schema.optionalKey(Schema.Boolean)
})

export type OpenReferenceSettings = typeof OpenReferenceSettings.Type

/** Child open retains the existing path-open vocabulary and adds creation times. */
export const OpenChildReferenceSettings = Schema.Struct({
  ...Vfs.OpenSettings.fields,
  times: Schema.optionalKey(Vfs.Times)
})

export type OpenChildReferenceSettings = typeof OpenChildReferenceSettings.Type

export interface OpenChildReferenceResult {
  readonly handle: Vfs.FileHandle
  readonly reference: Vfs.ObjectReference
  readonly created: boolean
  readonly directory: DirectoryChange
}

/** Proposed additions to `VirtualFileSystem.Caller`. */
export interface ReferenceMutationApi {
  readonly mkdirReference: (
    directory: Vfs.ObjectReference,
    name: Name,
    settings?: MkdirReferenceSettings
  ) => Effect.Effect<ReferenceEntryResult, Vfs.VfsError>

  readonly symlinkReference: (
    target: Vfs.PathInput,
    directory: Vfs.ObjectReference,
    name: Name,
    settings?: SymlinkReferenceSettings
  ) => Effect.Effect<ReferenceEntryResult, Vfs.VfsError>

  /** Creates another name for the exact source object; symbolic links are not followed. */
  readonly linkReference: (
    source: Vfs.ObjectReference,
    destinationDirectory: Vfs.ObjectReference,
    destinationName: Name
  ) => Effect.Effect<ReferenceEntryResult, Vfs.VfsError>

  readonly unlinkReference: (
    directory: Vfs.ObjectReference,
    name: Name
  ) => Effect.Effect<DirectoryChange, Vfs.VfsError>

  readonly rmdirReference: (
    directory: Vfs.ObjectReference,
    name: Name
  ) => Effect.Effect<DirectoryChange, Vfs.VfsError>

  readonly renameReference: (
    sourceDirectory: Vfs.ObjectReference,
    sourceName: Name,
    destinationDirectory: Vfs.ObjectReference,
    destinationName: Name
  ) => Effect.Effect<RenameReferenceResult, Vfs.VfsError>

  readonly chmodReference: (
    reference: Vfs.ObjectReference,
    mode: number
  ) => Effect.Effect<void, Vfs.VfsError>

  readonly chownReference: (
    reference: Vfs.ObjectReference,
    owner: Vfs.OwnerUpdate
  ) => Effect.Effect<void, Vfs.VfsError>

  readonly utimesReference: (
    reference: Vfs.ObjectReference,
    times: Vfs.Times
  ) => Effect.Effect<void, Vfs.VfsError>

  readonly truncateReference: (
    reference: Vfs.ObjectReference,
    length: bigint
  ) => Effect.Effect<void, Vfs.VfsError>

  readonly openReference: (
    reference: Vfs.ObjectReference,
    settings?: OpenReferenceSettings
  ) => Effect.Effect<Vfs.FileHandle, Vfs.VfsError, Scope.Scope>

  readonly openChildReference: (
    directory: Vfs.ObjectReference,
    name: Name,
    settings: OpenChildReferenceSettings
  ) => Effect.Effect<OpenChildReferenceResult, Vfs.VfsError, Scope.Scope>
}

declare const caller: ReferenceMutationApi

declare const sourceDirectory: Vfs.ObjectReference

declare const destinationDirectory: Vfs.ObjectReference

const utf8 = new TextEncoder()

/** The exact directory and returned identity come from the same transition. */
export const createAndOpen = caller.openChildReference(
  destinationDirectory,
  utf8.encode("report.txt"),
  {
    access: "readWrite",
    create: "exclusive",
    mode: 0o640,
    times: {
      access: { kind: "value", nanoseconds: 1_000n },
      modification: { kind: "value", nanoseconds: 2_000n }
    }
  }
)

/** The result shape makes the one-directory and two-directory cases explicit. */
export const move = caller.renameReference(
  sourceDirectory,
  utf8.encode("draft.txt"),
  destinationDirectory,
  utf8.encode("final.txt")
)
