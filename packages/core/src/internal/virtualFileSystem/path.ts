// Byte-preserving path validation and conversion.
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import type { BytePath } from "../../BytePath.js"
import type { PathInput } from "../../VirtualFileSystem.js"
import { getBytes as getBytePathBytes, make as makeBytePath } from "../bytePath.js"
import { type FsCode, FsError } from "./errors.js"

// Components are hex-encoded bytes so names compare as bytes, not text: 2f is "/", 2e is ".", 2e2e is "..".
/** @internal */
export const SLASH_HEX = "2f"

/** @internal */
export const DOT_HEX = "2e"

/** @internal */
export const DOT_DOT_HEX = "2e2e"

/** @internal */
export const SLASH_BYTE = 47

// POSIX NAME_MAX: the longest single path component.
/** @internal */
export const MAX_NAME_BYTES = 255

// A missing final component is rejected wherever "." and ".." are, so it counts as a dot component.
// Callers pass the code POSIX gives their operation, so the codes differ on purpose: EEXIST for
// create (link, symlink, mkdir), EISDIR for open and unlink, EINVAL for rename and rmdir.
/** @internal */
export const isDotComponent = (name: string | undefined): name is undefined | typeof DOT_HEX | typeof DOT_DOT_HEX =>
  name === undefined || name === DOT_HEX || name === DOT_DOT_HEX

/** @internal */
export const failure = (code: FsCode, operation: string, path?: PathInput) =>
  path === undefined ? new FsError({ code, operation }) : new FsError({ code, operation, path })

/** @internal */
export const ownedPath = (bytes: Uint8Array): BytePath => makeBytePath(bytes)

/** @internal */
export const strictString = (bytes: Uint8Array, operation: string) =>
  Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    catch: () => failure("UnrepresentableName", operation)
  })

/** @internal */
export const nameBytes = (name: string): Uint8Array => Result.getOrThrow(Encoding.decodeHex(name))

// A zero-length view distinguishes a detached buffer from a valid empty buffer.
const attachedBuffer = (bytes: Uint8Array): boolean => {
  try {
    const probe = new Uint8Array(bytes.buffer, bytes.byteOffset, 0)

    return probe.byteLength === 0
  } catch (error) {
    if (error instanceof TypeError) return false
    throw error
  }
}

// Accepts any Uint8Array, subclasses such as Node's Buffer included; rejects views over a
// SharedArrayBuffer or a detached buffer before the bytes are copied or trusted.
/** @internal */
export const isAttachedBytes = (bytes: Uint8Array): boolean =>
  Predicate.isUint8Array(bytes) && bytes.buffer instanceof ArrayBuffer && attachedBuffer(bytes)

/** @internal */
export const pathFromBytes = Effect.fn("VirtualFileSystem.pathFromBytes")(function*(bytes: Uint8Array) {
  if (!isAttachedBytes(bytes)) return yield* failure("InvalidArgument", "pathFromBytes")
  const owned = new Uint8Array(bytes)

  if (owned.length === 0 || owned.includes(0)) return yield* failure("InvalidArgument", "pathFromBytes")

  return makeBytePath(owned)
})

/** @internal */
export const pathToBytes = Effect.fn("VirtualFileSystem.pathToBytes")(function*(path: BytePath) {
  const bytes = getBytePathBytes(path)

  if (bytes === undefined) return yield* failure("InvalidArgument", "pathToBytes")

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

// Hand-rolled because String.prototype.isWellFormed is ES2024 and the package targets ES2023.
const wellFormed = (value: string): boolean => {
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

// Strings must be well-formed UTF-16 before encoding; BytePaths must belong to this package.
/** @internal */
export const inputBytes = (input: PathInput): Result.Result<Uint8Array, "InvalidPathEncoding" | "InvalidArgument"> =>
  Predicate.isString(input)
    ? wellFormed(input) ? Result.succeed(UTF8_ENCODER.encode(input)) : Result.fail("InvalidPathEncoding")
    : Result.fromNullishOr(getBytePathBytes(input), () => "InvalidArgument" as const)

/** @internal */
export const preparePath = (
  input: PathInput,
  operation: string,
  maxPathBytes: ByteSize.ByteSize | undefined
): Result.Result<PreparedPath, FsError> => {
  const encoded = inputBytes(input)

  if (Result.isFailure(encoded)) {
    return Result.fail(
      encoded.failure === "InvalidPathEncoding"
        ? failure("InvalidPathEncoding", operation, input)
        : failure("InvalidArgument", operation)
    )
  }

  const bytes = encoded.success

  if (bytes.length === 0) return Result.fail(failure("NotFound", operation, input))

  if (bytes.includes(0)) return Result.fail(failure("InvalidArgument", operation, input))

  if (maxPathBytes !== undefined && ByteSize.isGreaterThan(ByteSize.bytes(bytes.length), maxPathBytes)) {
    return Result.fail(failure("PathTooLong", operation, input))
  }

  const components: Array<string> = []
  const suffixes: Array<Uint8Array> = []
  let start = 0

  for (let index = 0; index <= bytes.length; index++) {
    if (index !== bytes.length && bytes[index] !== SLASH_BYTE) continue

    if (index > start) {
      if (index - start > MAX_NAME_BYTES) return Result.fail(failure("PathTooLong", operation, input))
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
