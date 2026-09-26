import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import type { BytePath } from "../BytePath.js"
import type { FsFailure } from "../VfsError.js"
import type { PathInput } from "../VirtualFileSystem.js"
import { getBytes as getBytePathBytes, make as makeBytePath } from "./bytePath.js"
import { fsFailure } from "./errors.js"

/** @internal */
export const SLASH_HEX = "2f"
/** @internal */
export const DOT_HEX = "2e"
/** @internal */
export const DOT_DOT_HEX = "2e2e"
/** @internal */
export const SLASH_BYTE = 47
const DOT_BYTE = 46
/** @internal */
export const NUL_BYTE = 0
/** @internal */
export const MAX_SYMLINK_TRAVERSALS = 40
/** @internal */
export const MAX_NAME_BYTES = 255

/** @internal */
export const isNameBytes = (name: Uint8Array): boolean =>
  name.length >= 1 && name.length <= MAX_NAME_BYTES && !name.includes(NUL_BYTE) && !name.includes(SLASH_BYTE) &&
  !(name.length === 1 && name[0] === DOT_BYTE) && !(name.length === 2 && name[0] === DOT_BYTE && name[1] === DOT_BYTE)

/** @internal */
export const ROOT_PATH = new Uint8Array([SLASH_BYTE])

/** @internal */
export const joinPath = (prefix: Uint8Array, name: Uint8Array): Uint8Array => {
  const separator = prefix.length === 0 || prefix[prefix.length - 1] === SLASH_BYTE ? 0 : 1
  const joined = new Uint8Array(prefix.length + separator + name.length)
  joined.set(prefix)

  if (separator === 1) joined[prefix.length] = SLASH_BYTE
  joined.set(name, prefix.length + separator)

  return joined
}

// A missing final component follows the same rejection path as "." and ".."; callers choose the POSIX error code.
/** @internal */
export const isDotComponent = (name: string | undefined): name is undefined | typeof DOT_HEX | typeof DOT_DOT_HEX =>
  name === undefined || name === DOT_HEX || name === DOT_DOT_HEX

/** @internal */
export const ownedPath = (bytes: Uint8Array): BytePath => makeBytePath(bytes)

/** @internal */
export const strictString = (bytes: Uint8Array, operation: string) =>
  Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    catch: () => fsFailure("UnrepresentableName", operation)
  })

/** @internal */
export const nameBytes = (name: string): Uint8Array => Result.getOrThrow(Encoding.decodeHex(name))

// Constructing a view detects detached buffers, including empty ones.
const attachedBuffer = (bytes: Uint8Array): boolean => {
  try {
    const probe = new Uint8Array(bytes.buffer, bytes.byteOffset, 0)

    return probe.byteLength === 0
  } catch (error) {
    if (error instanceof TypeError) return false
    throw error
  }
}

// Reject shared or detached buffers before copying; Buffer subclasses remain valid.
/** @internal */
export const isAttachedBytes = (bytes: Uint8Array): boolean =>
  Predicate.isUint8Array(bytes) && bytes.buffer instanceof ArrayBuffer && attachedBuffer(bytes)

/** @internal */
export const pathFromBytes = Effect.fn("VirtualFileSystem.pathFromBytes")(function*(bytes: Uint8Array) {
  if (!isAttachedBytes(bytes)) return yield* fsFailure("InvalidArgument", "pathFromBytes")
  const owned = new Uint8Array(bytes)

  if (owned.length === 0 || owned.includes(0)) {
    return yield* fsFailure("InvalidArgument", "pathFromBytes")
  }

  return makeBytePath(owned)
})

/** @internal */
export const pathToBytes = Effect.fn("VirtualFileSystem.pathToBytes")(function*(path: BytePath) {
  const bytes = getBytePathBytes(path)

  if (bytes === undefined) return yield* fsFailure("InvalidArgument", "pathToBytes")

  return new Uint8Array(bytes)
})

/** @internal */
export interface PreparedPath {
  readonly input: PathInput
  readonly absolute: boolean
  readonly trailingSlash: boolean
  readonly bytes: Uint8Array
  readonly suffixes: ReadonlyArray<Uint8Array>
  readonly components: ReadonlyArray<string>
}

// String.prototype.isWellFormed requires ES2024; this package targets ES2023.
/** @internal */
export const isWellFormed = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index)

      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }

  return true
}

const UTF8_ENCODER = new TextEncoder()

/** @internal */
export const inputBytes = (input: PathInput): Result.Result<Uint8Array, "InvalidPathEncoding" | "InvalidArgument"> =>
  Predicate.isString(input)
    ? isWellFormed(input) ? Result.succeed(UTF8_ENCODER.encode(input)) : Result.fail("InvalidPathEncoding")
    : Result.fromNullishOr(getBytePathBytes(input), () => "InvalidArgument" as const)

/** @internal */
export const preparePath = (
  input: PathInput,
  operation: string,
  maxPathBytes: ByteSize.ByteSize | undefined
): Result.Result<PreparedPath, FsFailure> => {
  const encoded = inputBytes(input)

  if (Result.isFailure(encoded)) {
    return Result.fail(
      encoded.failure === "InvalidPathEncoding"
        ? fsFailure("InvalidPathEncoding", operation, { path: input })
        : fsFailure("InvalidArgument", operation)
    )
  }

  const bytes = encoded.success

  if (bytes.length === 0) return Result.fail(fsFailure("NotFound", operation, { path: input }))

  if (bytes.includes(0)) return Result.fail(fsFailure("InvalidArgument", operation, { path: input }))

  if (maxPathBytes !== undefined && ByteSize.isGreaterThan(ByteSize.bytes(bytes.length), maxPathBytes)) {
    return Result.fail(fsFailure("PathTooLong", operation, { path: input }))
  }

  const components: Array<string> = []
  const suffixes: Array<Uint8Array> = []
  let start = 0

  for (let index = 0; index <= bytes.length; index++) {
    if (index !== bytes.length && bytes[index] !== SLASH_BYTE) continue

    if (index > start) {
      if (index - start > MAX_NAME_BYTES) {
        return Result.fail(fsFailure("PathTooLong", operation, { path: input }))
      }

      components.push(Encoding.encodeHex(bytes.subarray(start, index)))
      suffixes.push(bytes.subarray(index))
    }

    start = index + 1
  }

  return Result.succeed({
    input,
    absolute: bytes[0] === SLASH_BYTE,
    trailingSlash: bytes.at(-1) === SLASH_BYTE,
    bytes,
    suffixes,
    components
  })
}
