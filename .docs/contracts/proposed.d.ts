// Broader future API declarations. Use implemented-consumers.ts for the actual directory-only core.
import type * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"

declare const BytePathId: unique symbol
declare const VolumeId: unique symbol
declare const CallerId: unique symbol
declare const FileHandleId: unique symbol
declare const DirectoryHandleId: unique symbol
declare const SnapshotId: unique symbol
declare const CallerServiceId: unique symbol

export interface BytePath {
  readonly [BytePathId]: typeof BytePathId
}

export type PathInput = string | BytePath

import type {
  ConfigurationError,
  DecodeLimits,
  Fixture as FixtureModel,
  FixtureEntry as FixtureEntryModel,
  FsError,
  ImageError,
  Metadata,
  OwnerUpdate,
  RootCallerOptions,
  SeekMode,
  Times,
  VolumeOptions
} from "./models.js"
export {
  ConfigurationError,
  DecodeLimits,
  FixtureMetadata,
  FsCode,
  FsError,
  Identity,
  ImageError,
  Metadata,
  OwnerUpdate,
  RootCallerOptions,
  SeekMode,
  Times,
  TimeUpdate,
  VolumeOptions
} from "./models.js"
export type Fixture = FixtureModel<PathInput>
export type FixtureEntry = FixtureEntryModel<PathInput>

export interface RelativeOptions {
  readonly relativeTo?: DirectoryHandle
}

export interface TwoPathOptions {
  readonly sourceRelativeTo?: DirectoryHandle
  readonly destinationRelativeTo?: DirectoryHandle
}

type CreationOptions =
  | { readonly create?: "never"; readonly mode?: never }
  | { readonly create: "ifMissing" | "exclusive"; readonly mode?: number }

type AccessOptions =
  | { readonly access: "read"; readonly append?: false; readonly truncate?: false }
  | { readonly access: "write" | "readWrite"; readonly append?: boolean; readonly truncate?: boolean }

export type OpenOptions = RelativeOptions & CreationOptions & AccessOptions & {
  readonly followFinalSymlink?: boolean
}

export interface FileHandle {
  readonly [FileHandleId]: typeof FileHandleId
  readonly read: (maximumBytes: number) => Effect.Effect<Uint8Array, FsError>
  readonly write: (bytes: Uint8Array) => Effect.Effect<number, FsError>
  readonly pread: (maximumBytes: number, offset: bigint) => Effect.Effect<Uint8Array, FsError>
  readonly pwrite: (bytes: Uint8Array, offset: bigint) => Effect.Effect<number, FsError>
  readonly seek: (offset: bigint, mode: SeekMode) => Effect.Effect<bigint, FsError>
  readonly truncate: (length: bigint) => Effect.Effect<void, FsError>
  readonly stat: () => Effect.Effect<Metadata, FsError>
  readonly sync: () => Effect.Effect<void, FsError>
  readonly close: () => Effect.Effect<void, FsError>
}

export interface DirectoryHandle {
  readonly [DirectoryHandleId]: typeof DirectoryHandleId
  readonly stat: () => Effect.Effect<Metadata, FsError>
  readonly close: () => Effect.Effect<void, FsError>
}

export interface Caller {
  readonly [CallerId]: typeof CallerId
  readonly withDirectory: (path: PathInput, options?: RelativeOptions) => Effect.Effect<Caller, FsError, Scope.Scope>
  readonly open: (path: PathInput, options: OpenOptions) => Effect.Effect<FileHandle, FsError, Scope.Scope>
  readonly openDirectory: (
    path: PathInput,
    options?: RelativeOptions
  ) => Effect.Effect<DirectoryHandle, FsError, Scope.Scope>
  readonly stat: (path: PathInput, options?: RelativeOptions) => Effect.Effect<Metadata, FsError>
  readonly lstat: (path: PathInput, options?: RelativeOptions) => Effect.Effect<Metadata, FsError>
  readonly realPath: (path: PathInput, options?: RelativeOptions) => Effect.Effect<string, FsError>
  readonly realPathBytes: (path: PathInput, options?: RelativeOptions) => Effect.Effect<BytePath, FsError>
  readonly readDirectory: (path: PathInput, options?: RelativeOptions) => Effect.Effect<ReadonlyArray<string>, FsError>
  readonly readDirectoryBytes: (
    path: PathInput,
    options?: RelativeOptions
  ) => Effect.Effect<ReadonlyArray<Uint8Array>, FsError>
  readonly readLink: (path: PathInput, options?: RelativeOptions) => Effect.Effect<string, FsError>
  readonly readLinkBytes: (path: PathInput, options?: RelativeOptions) => Effect.Effect<Uint8Array, FsError>
  readonly mkdir: (
    path: PathInput,
    options?: RelativeOptions & { readonly mode?: number }
  ) => Effect.Effect<void, FsError>
  readonly rmdir: (path: PathInput, options?: RelativeOptions) => Effect.Effect<void, FsError>
  readonly unlink: (path: PathInput, options?: RelativeOptions) => Effect.Effect<void, FsError>
  readonly rename: (source: PathInput, destination: PathInput, options?: TwoPathOptions) => Effect.Effect<void, FsError>
  readonly link: (
    source: PathInput,
    destination: PathInput,
    options?: TwoPathOptions & { readonly followSourceSymlink?: boolean }
  ) => Effect.Effect<void, FsError>
  readonly symlink: (target: PathInput, path: PathInput, options?: RelativeOptions) => Effect.Effect<void, FsError>
  readonly truncate: (path: PathInput, length: bigint, options?: RelativeOptions) => Effect.Effect<void, FsError>
  readonly chmod: (path: PathInput, mode: number, options?: RelativeOptions) => Effect.Effect<void, FsError>
  readonly chown: (path: PathInput, owner: OwnerUpdate, options?: RelativeOptions) => Effect.Effect<void, FsError>
  readonly utimes: (path: PathInput, times: Times, options?: RelativeOptions) => Effect.Effect<void, FsError>
  readonly chmodHandle: (handle: FileHandle | DirectoryHandle, mode: number) => Effect.Effect<void, FsError>
  readonly chownHandle: (handle: FileHandle | DirectoryHandle, owner: OwnerUpdate) => Effect.Effect<void, FsError>
  readonly utimesHandle: (handle: FileHandle | DirectoryHandle, times: Times) => Effect.Effect<void, FsError>
}

export interface Snapshot {
  readonly [SnapshotId]: typeof SnapshotId
}

export interface Volume {
  readonly [VolumeId]: typeof VolumeId
  readonly caller: (options?: RootCallerOptions) => Effect.Effect<Caller, ConfigurationError>
  readonly snapshot: () => Effect.Effect<Snapshot, ImageError>
}

export declare const VirtualFileSystem: {
  readonly make: (options?: VolumeOptions) => Effect.Effect<Volume, ConfigurationError>
  readonly pathFromBytes: (bytes: Uint8Array) => Effect.Effect<BytePath, FsError>
  readonly pathToBytes: (path: BytePath) => Effect.Effect<Uint8Array>
  readonly fromFixture: (
    fixture: Fixture,
    options?: VolumeOptions
  ) => Effect.Effect<Volume, ImageError | ConfigurationError>
  readonly encodeSnapshot: (snapshot: Snapshot) => Effect.Effect<Uint8Array, ImageError>
  readonly decodeSnapshot: (
    bytes: Uint8Array,
    limits: DecodeLimits
  ) => Effect.Effect<Snapshot, ImageError | ConfigurationError>
  readonly fromSnapshot: (
    snapshot: Snapshot,
    options?: VolumeOptions
  ) => Effect.Effect<Volume, ImageError | ConfigurationError>
}

export interface CurrentFileSystem {
  readonly [CallerServiceId]: typeof CallerServiceId
}

export declare const CurrentFileSystem: Context.Service<CurrentFileSystem, Caller>
