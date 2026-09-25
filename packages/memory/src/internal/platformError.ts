/**
 * @internal
 * @since 0.1.0
 */
import type { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { badArgument, type PlatformError, systemError, type SystemErrorTag } from "effect/PlatformError"

const systemTags = {
  NotFound: "NotFound",
  AlreadyExists: "AlreadyExists",
  NotEmpty: "Unknown",
  NotDirectory: "BadResource",
  AccessDenied: "PermissionDenied",
  InvalidHandle: "BadResource",
  ForeignHandle: "BadResource",
  InvalidReference: "BadResource",
  ForeignReference: "BadResource",
  StaleReference: "BadResource",
  ClosedCaller: "BadResource",
  InvalidPathEncoding: "InvalidData",
  PathTooLong: "InvalidData",
  NoSpace: "Unknown",
  IsDirectory: "BadResource",
  FileTooLarge: "Unknown",
  NoData: "Unknown",
  SymlinkLoop: "BadResource",
  UnrepresentableName: "InvalidData",
  StorageRejected: "Unknown",
  OutcomeUnknown: "Unknown",
  VolumeUnavailable: "Unknown",
  VolumeBusy: "Busy",
  InvalidEncoding: "InvalidData",
  UnsupportedVersion: "InvalidData",
  InvalidStructure: "InvalidData",
  LimitExceeded: "Unknown",
  BaseMismatch: "InvalidData",
  Storage: "Unknown",
  Ownership: "Unknown",
  IncompatibleStore: "Unknown",
  CorruptStore: "Unknown"
} satisfies Record<Exclude<Vfs.VfsCode, "InvalidArgument">, SystemErrorTag>

/** @internal */
export const argumentError = (method: string, description: string) =>
  badArgument({ module: "FileSystem", method, description })

/** @internal */
export const resourceError = (method: string, pathOrDescriptor: string | number, description?: string) =>
  description === undefined
    ? systemError({ module: "FileSystem", method, pathOrDescriptor, _tag: "BadResource" })
    : systemError({ module: "FileSystem", method, pathOrDescriptor, _tag: "BadResource", description })

/** @internal */
export const toPlatformError = (
  error: Vfs.VfsError,
  method: string,
  pathOrDescriptor: string | number
): PlatformError => {
  if (error.code === "InvalidArgument") {
    return badArgument({ module: "FileSystem", method, description: error.code, cause: error })
  }

  return systemError({
    module: "FileSystem",
    method,
    pathOrDescriptor,
    _tag: systemTags[error.code] ?? "Unknown",
    description: error.code,
    cause: error
  })
}
