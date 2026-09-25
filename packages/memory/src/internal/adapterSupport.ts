/**
 * Converts core metadata and validates inputs for the Effect FileSystem adapter.
 *
 * @internal
 * @since 0.1.0
 */
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as ByteSize from "effect/ByteSize"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import { type PlatformError, systemError } from "effect/PlatformError"
import * as Predicate from "effect/Predicate"
import { argumentError } from "./platformError.js"

/** @internal */
export const info = Effect.fnUntraced(function*(
  value: Vfs.Metadata,
  pathOrDescriptor: string | number
): Effect.fn.Return<FileSystem.File.Info, PlatformError> {
  const date = (field: "atimeNs" | "mtimeNs" | "birthtimeNs") => {
    const result = DateTime.make(Number(value[field] / 1_000_000n))

    return Option.isSome(result)
      ? Effect.succeedSome(DateTime.toDateUtc(result.value))
      : Effect.fail(systemError({
        module: "FileSystem",
        method: "stat",
        pathOrDescriptor,
        _tag: "InvalidData",
        description: `${field} cannot be represented as a JavaScript Date`
      }))
  }

  return {
    type: value.kind === "file" ? "File" : value.kind === "directory" ? "Directory" : "SymbolicLink",
    ino: Option.some(Number(value.ino)),
    dev: 0,
    mode: value.mode | (value.kind === "file" ? 0o100000 : value.kind === "directory" ? 0o40000 : 0o120000),
    uid: Option.some(value.uid),
    gid: Option.some(value.gid),
    nlink: Option.some(value.nlink),
    rdev: Option.some(0),
    size: ByteSize.bytes(value.size),
    blksize: Option.none(),
    blocks: Option.none(),
    atime: yield* date("atimeNs"),
    mtime: yield* date("mtimeNs"),
    birthtime: yield* date("birthtimeNs")
  }
})

/** @internal */
export const validateMode = (mode: number | undefined, method: string) =>
  mode === undefined || (Number.isInteger(mode) && mode >= 0 && mode <= 0xffffffff)
    ? Effect.void
    : Effect.fail(argumentError(method, "mode must be an unsigned 32-bit integer"))

/** @internal */
export const sizeInput = (size: number | undefined, method: string, defaultValue?: number) => {
  const number = size === undefined ? defaultValue : size

  return Predicate.isNumber(number) && Number.isSafeInteger(number) && number >= 0
    ? Effect.succeed(BigInt(number))
    : Effect.fail(argumentError(method, "size must be a non-negative integer"))
}

/** @internal */
export const openOptions = Effect.fnUntraced(
  function*(flag: FileSystem.OpenFlag, mode: number | undefined, method: string) {
    if (!["r", "r+", "w", "wx", "w+", "wx+", "a", "ax", "a+", "ax+"].includes(flag)) {
      return yield* argumentError(method, "Unsupported open flag")
    }

    yield* validateMode(mode, method)
    const create = flag.startsWith("w") || flag.startsWith("a")

    const access = flag === "r" ? "read" : flag.endsWith("+") ? "readWrite" : "write"
    const append = flag.startsWith("a")
    const truncate = flag.startsWith("w")

    return create
      ? {
        access,
        create: flag.includes("x") ? "exclusive" : "ifMissing",
        mode: (mode ?? 0o644) & 0o7777,
        append,
        truncate
      } satisfies Vfs.OpenOptions
      : { access, create: "never", append, truncate } satisfies Vfs.OpenOptions
  }
)

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

// The text of a name or link target, failing as UnrepresentableName when it is not valid UTF-8.
/** @internal */
export const textOf = (bytes: Uint8Array, method: string): Effect.Effect<string, Vfs.VfsError> =>
  Effect.try({
    try: () => decoder.decode(bytes),
    catch: () => new Vfs.VfsError({ code: "UnrepresentableName", operation: method })
  })

// The text of a byte path.
/** @internal */
export const textPath = (path: Vfs.BytePath, method: string): Effect.Effect<string, Vfs.VfsError> =>
  Effect.flatMap(Vfs.pathToBytes(path), (bytes) => textOf(bytes, method))

interface PathTargetFields {
  path: Vfs.PathInput
  relativeTo?: Vfs.DirectoryHandle
  followFinalSymlink?: boolean
}

// A path target with an optional base handle and symbolic link policy.
/** @internal */
export const at = (
  path: Vfs.PathInput,
  base?: Vfs.DirectoryHandle,
  followFinalSymlink?: boolean
): Vfs.PathTarget => {
  const target: PathTargetFields = { path }

  if (base !== undefined) target.relativeTo = base

  if (followFinalSymlink !== undefined) target.followFinalSymlink = followFinalSymlink

  return Vfs.Target.Path(target)
}

// The names in a listing, as text.
/** @internal */
export const listingNames = (
  listing: Vfs.ObjectObservation<ReadonlyArray<Vfs.DirectoryEntry>>,
  method: string
): Effect.Effect<Array<string>, Vfs.VfsError> => Effect.forEach(listing.value, (entry) => textOf(entry.name, method))
