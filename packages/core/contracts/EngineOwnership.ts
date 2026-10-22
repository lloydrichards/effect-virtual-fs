import type { ByteSize, Effect, Scope, Stream } from "effect"
import type { CallerId, ObjectReferenceId } from "../src/Caller.js"
import type { DirectoryHandleId, FileHandleId } from "../src/FileHandle.js"
import type * as Engine from "../src/internal/engine.js"
import type * as Vfs from "../src/VirtualFileSystem.js"
import type * as WatchModule from "../src/Watch.js"

type BytePath = Vfs.BytePath

type FsFailure = Vfs.FsFailure

type VfsError = Vfs.VfsError

type Metadata = Vfs.Metadata

type DirectoryChange = Vfs.DirectoryChange

type SeekMode = Vfs.SeekMode

type TargetInput = Vfs.TargetInput

type EntryInput = Vfs.EntryInput

type Target = Vfs.Target

type Entry = Vfs.Entry

type WalkOptions = Vfs.WalkOptions

type WriteFileOptions = Vfs.WriteFileOptions

type OpenOptions = Vfs.OpenOptions

type OpenEntryOptions = Vfs.OpenEntryOptions

type MkdirOptions = Vfs.MkdirOptions

type SymlinkOptions = Vfs.SymlinkOptions

type RemoveOptions = Vfs.RemoveOptions

type RenameReferenceResult = Vfs.RenameReferenceResult

type OwnerUpdate = Vfs.OwnerUpdate

type Times = Vfs.Times

type SetattrOptions = Vfs.SetattrOptions

type Change = Vfs.Change

// These declarations preserve the public capability shapes before engine ownership was inverted.
namespace Before {
  export type PathInput = string | BytePath
  export interface VolumeUsage {
    readonly usedBytes: bigint
    readonly entries: number
  }
  export interface ObjectReference {
    readonly [ObjectReferenceId]: true
  }
  export interface ObjectObservation<A> {
    readonly value: A
    readonly revision: bigint
  }
  export interface DirectoryEntry {
    readonly name: Uint8Array
    readonly reference: ObjectReference
  }
  export interface WalkEntry {
    readonly path: BytePath
    readonly name: Uint8Array
    readonly reference: ObjectReference
    readonly directory: ObjectReference
    readonly kind: Metadata["kind"]
    readonly depth: number
  }
  export interface ReferenceEntryResult {
    readonly reference: ObjectReference
    readonly directory: DirectoryChange
  }
  export interface DirectoryHandle {
    readonly [DirectoryHandleId]: true
    readonly stat: Effect.Effect<Metadata, FsFailure>
    readonly close: Effect.Effect<void, FsFailure>
  }
  export interface OpenEntryResult {
    readonly handle: FileHandle
    readonly reference: ObjectReference
    readonly created: boolean
    readonly directory: DirectoryChange
  }
  export interface ReadResult {
    readonly bytes: Uint8Array
    readonly eof: boolean
  }
  export interface FileHandle {
    readonly [FileHandleId]: true
    readonly read: (maximumBytes: number) => Effect.Effect<Uint8Array, FsFailure>
    readonly pread: (maximumBytes: number, offset: bigint) => Effect.Effect<ReadResult, FsFailure>
    readonly write: (bytes: Uint8Array) => Effect.Effect<number, FsFailure>
    readonly pwrite: {
      (offset: bigint): (bytes: Uint8Array) => Effect.Effect<number, FsFailure>
      (bytes: Uint8Array, offset: bigint): Effect.Effect<number, FsFailure>
    }
    readonly seek: {
      (mode: SeekMode): (offset: bigint) => Effect.Effect<bigint, FsFailure>
      (offset: bigint, mode: SeekMode): Effect.Effect<bigint, FsFailure>
    }
    readonly truncate: (length: bigint) => Effect.Effect<void, FsFailure>
    readonly stat: Effect.Effect<Metadata, FsFailure>
    readonly sync: Effect.Effect<void, FsFailure>
    readonly close: Effect.Effect<void, FsFailure>
  }
  export type WalkFailure = FsFailure | (VfsError & { readonly code: "LimitExceeded" })
  export interface VolumeLimits {
    readonly maxBytes: ByteSize.ByteSize | undefined
    readonly maxFileBytes: ByteSize.ByteSize
    readonly maxEntries: number | undefined
    readonly maxPathBytes: ByteSize.ByteSize | undefined
    readonly maxPendingOperations: number
    readonly maxWatchEvents: number
  }
  export interface Caller {
    readonly [CallerId]: true
    readonly limits: VolumeLimits
    readonly watch: (
      target: TargetInput,
      options?: WatchModule.CallerWatchOptions
    ) => Effect.Effect<Stream.Stream<Change, FsFailure>, FsFailure, Scope.Scope>
    readonly withRoot: (directory: TargetInput) => Effect.Effect<Caller, FsFailure, Scope.Scope>
    readonly root: Effect.Effect<ObjectReference, FsFailure>
    readonly lookup: (entry: EntryInput) => Effect.Effect<ObjectReference, FsFailure>
    readonly parent: (directory: TargetInput) => Effect.Effect<ObjectReference, FsFailure>
    readonly stat: (target: TargetInput) => Effect.Effect<Metadata, FsFailure>
    readonly readDirectory: (
      directory: TargetInput
    ) => Effect.Effect<ObjectObservation<ReadonlyArray<DirectoryEntry>>, FsFailure>
    readonly walk: (directory: TargetInput, options?: WalkOptions) => Stream.Stream<WalkEntry, WalkFailure>
    readonly readLink: (target: TargetInput) => Effect.Effect<Uint8Array, FsFailure>
    readonly realPath: (target: TargetInput) => Effect.Effect<BytePath, FsFailure>
    readonly access: (target: TargetInput, bits?: number) => Effect.Effect<number, FsFailure>
    readonly readFile: (target: TargetInput) => Effect.Effect<Uint8Array, FsFailure>
    readonly writeFile: {
      (bytes: Uint8Array, options: WriteFileOptions): (entry: EntryInput) => Effect.Effect<ObjectReference, FsFailure>
      (entry: EntryInput, bytes: Uint8Array, options: WriteFileOptions): Effect.Effect<ObjectReference, FsFailure>
    }
    readonly open: {
      (target: Target | PathInput | ObjectReference | FileHandle, options: OpenOptions): Effect.Effect<
        FileHandle,
        FsFailure,
        Scope.Scope
      >
      (entry: Entry, options: OpenEntryOptions): Effect.Effect<OpenEntryResult, FsFailure, Scope.Scope>
    }
    readonly mkdir: (entry: EntryInput, options?: MkdirOptions) => Effect.Effect<ReferenceEntryResult, FsFailure>
    readonly symlink: (
      target: PathInput,
      entry: EntryInput,
      options?: SymlinkOptions
    ) => Effect.Effect<ReferenceEntryResult, FsFailure>
    readonly link: {
      (entry: EntryInput): (source: TargetInput) => Effect.Effect<ReferenceEntryResult, FsFailure>
      (source: TargetInput, entry: EntryInput): Effect.Effect<ReferenceEntryResult, FsFailure>
    }
    readonly unlink: (entry: EntryInput) => Effect.Effect<DirectoryChange, FsFailure>
    readonly rmdir: (entry: EntryInput) => Effect.Effect<DirectoryChange, FsFailure>
    readonly remove: {
      (
        entry: EntryInput,
        options?: RemoveOptions & { readonly force?: false }
      ): Effect.Effect<DirectoryChange, FsFailure>
      (entry: EntryInput, options: RemoveOptions): Effect.Effect<DirectoryChange | undefined, FsFailure>
    }
    readonly rename: {
      (to: EntryInput): (from: EntryInput) => Effect.Effect<RenameReferenceResult, FsFailure>
      (from: EntryInput, to: EntryInput): Effect.Effect<RenameReferenceResult, FsFailure>
    }
    readonly chmod: {
      (mode: number): (target: TargetInput) => Effect.Effect<void, FsFailure>
      (target: TargetInput, mode: number): Effect.Effect<void, FsFailure>
    }
    readonly chown: {
      (owner: OwnerUpdate): (target: TargetInput) => Effect.Effect<void, FsFailure>
      (target: TargetInput, owner: OwnerUpdate): Effect.Effect<void, FsFailure>
    }
    readonly utimes: {
      (times: Times): (target: TargetInput) => Effect.Effect<void, FsFailure>
      (target: TargetInput, times: Times): Effect.Effect<void, FsFailure>
    }
    readonly truncate: {
      (length: bigint): (target: TargetInput) => Effect.Effect<void, FsFailure>
      (target: TargetInput, length: bigint): Effect.Effect<void, FsFailure>
    }
    readonly setattr: {
      (attributes: SetattrOptions): (target: TargetInput) => Effect.Effect<void, FsFailure>
      (target: TargetInput, attributes: SetattrOptions): Effect.Effect<void, FsFailure>
    }
    readonly withDirectory: (directory: TargetInput) => Effect.Effect<Caller, FsFailure, Scope.Scope>
    readonly openDirectory: (directory: TargetInput) => Effect.Effect<DirectoryHandle, FsFailure, Scope.Scope>
  }
}

type Assert<A extends true> = A

type Compatible<A, B> = [A, keyof A] extends [B, keyof B] ? [B, keyof B] extends [A, keyof A] ? true : false : false

export type PathInputCompatibility = Assert<Compatible<Vfs.PathInput, Before.PathInput>>

export type VolumeUsageCompatibility = Assert<Compatible<Vfs.VolumeUsage, Before.VolumeUsage>>

export type ObjectReferenceCompatibility = Assert<Compatible<Vfs.ObjectReference, Before.ObjectReference>>

export type ObjectObservationCompatibility = Assert<
  Compatible<Vfs.ObjectObservation<unknown>, Before.ObjectObservation<unknown>>
>

export type DirectoryEntryCompatibility = Assert<Compatible<Vfs.DirectoryEntry, Before.DirectoryEntry>>

export type WalkEntryCompatibility = Assert<Compatible<Vfs.WalkEntry, Before.WalkEntry>>

export type ReferenceEntryResultCompatibility = Assert<
  Compatible<Vfs.ReferenceEntryResult, Before.ReferenceEntryResult>
>

export type DirectoryHandleCompatibility = Assert<Compatible<Vfs.DirectoryHandle, Before.DirectoryHandle>>

export type OpenEntryResultCompatibility = Assert<Compatible<Vfs.OpenEntryResult, Before.OpenEntryResult>>

export type ReadResultCompatibility = Assert<Compatible<Vfs.ReadResult, Before.ReadResult>>

export type FileHandleCompatibility = Assert<Compatible<Vfs.FileHandle, Before.FileHandle>>

export type WalkFailureCompatibility = Assert<Compatible<Vfs.WalkFailure, Before.WalkFailure>>

export type VolumeLimitsCompatibility = Assert<Compatible<Vfs.VolumeLimits, Before.VolumeLimits>>

export type CallerCompatibility = Assert<Compatible<Vfs.Caller, Before.Caller>>

export type EngineOperationsCompatibility = Assert<
  Compatible<
    Engine.EngineOperations,
    Omit<Before.Caller, symbol | "watch" | "withRoot" | "withDirectory" | "limits"> & {
      readonly limits: Omit<Before.VolumeLimits, "maxWatchEvents">
    }
  >
>
