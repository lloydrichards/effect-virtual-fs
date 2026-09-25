/**
 * Opaque, byte-preserving filesystem paths.
 *
 * A `BytePath` stores the exact bytes of a path component so that names which
 * are not valid UTF-8 survive a round trip through the virtual filesystem.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import type * as Equal from "effect/Equal"
import * as Option from "effect/Option"
import * as OrderModule from "effect/Order"
import type { Pipeable } from "effect/Pipeable"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Internal from "./internal/bytePath.js"
import * as Bytes from "./internal/bytes.js"
import { fsFailure, retargetFailure } from "./internal/errors.js"
import * as Path from "./internal/path.js"
import type { FsFailure } from "./VfsError.js"
import type { PathInput } from "./VirtualFileSystem.js"

/**
 * Type identifier for opaque byte-preserving filesystem paths.
 *
 * @category type IDs
 * @since 0.1.0
 */
export const BytePathId: "@effect-vfs/core/BytePath" = Internal.BytePathId

/**
 * Type identifier for opaque byte-preserving filesystem paths.
 *
 * @category type IDs
 * @since 0.1.0
 */
export type BytePathId = typeof BytePathId

/**
 * An opaque path that preserves arbitrary non-NUL bytes without UTF-8 conversion.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * // A name that is not valid UTF-8 still round-trips exactly.
 * const program = Effect.gen(function*() {
 *   const caller = yield* (yield* Vfs.make()).caller()
 *   const path = yield* Vfs.pathFromBytes(new Uint8Array([47, 0xff, 0xfe]))
 *
 *   yield* caller.writeFile(path, new Uint8Array([1]), {
 *     access: "write",
 *     create: "exclusive"
 *   })
 *
 *   // A listing carries names as bytes, so nothing is lost to text decoding.
 *   return (yield* caller.readDirectory("/")).value.map((entry) => entry.name)
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // [ Uint8Array(2) [ 255, 254 ] ]
 * ```
 *
 * @category models
 * @since 0.1.0
 */
export interface BytePath extends Equal.Equal, Pipeable {
  readonly [BytePathId]: BytePathId
}

/**
 * Schema for an opaque byte-preserving filesystem path.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BytePath = Schema.declare<BytePath>(Internal.isBytePath)

const encoder = new TextEncoder()

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

const SLASH = 0x2f

const bytesOf = (path: BytePath): Uint8Array => Internal.getBytes(path) ?? new Uint8Array()

/**
 * Whether a value is a byte path.
 *
 * @category predicates
 * @since 0.6.0
 */
export const isBytePath: (value: unknown) => value is BytePath = Internal.isBytePath

/**
 * Orders raw byte strings, such as entry names, byte by byte and then by length.
 *
 * @category ordering
 * @since 0.6.0
 */
export const byteOrder: OrderModule.Order<Uint8Array> = Bytes.bytesOrder

/**
 * Orders byte paths by their bytes.
 *
 * @category ordering
 * @since 0.6.0
 */
export const Order: OrderModule.Order<BytePath> = OrderModule.mapInput(Bytes.bytesOrder, bytesOf)

// The shared conversions fail under their own names; each toolkit function names itself instead.
const named = <A>(operation: string, effect: Effect.Effect<A, FsFailure>): Effect.Effect<A, FsFailure> =>
  Effect.mapError(effect, (error) => retargetFailure(operation, error))

/**
 * A byte path holding a copy of `bytes`, which must be non-empty and hold no NUL.
 *
 * @category constructors
 * @since 0.6.0
 */
export const fromBytes = (bytes: Uint8Array): Effect.Effect<BytePath, FsFailure> =>
  named("BytePath.fromBytes", Path.pathFromBytes(bytes))

/**
 * A byte path holding the UTF-8 encoding of `text`.
 *
 * @category constructors
 * @since 0.6.0
 */
export const fromString = (text: string): Effect.Effect<BytePath, FsFailure> => {
  const bytes = Path.inputBytes(text)

  return Result.isFailure(bytes)
    ? Effect.fail(fsFailure(bytes.failure, "BytePath.fromString"))
    : named("BytePath.fromString", Path.pathFromBytes(new Uint8Array(bytes.success)))
}

/**
 * A byte path for any path input: a byte path is returned as is, a string is encoded.
 *
 * @category constructors
 * @since 0.6.0
 */
export const fromInput = (input: PathInput): Effect.Effect<BytePath, FsFailure> =>
  Internal.isBytePath(input) ? Effect.succeed(input) : fromString(input)

/**
 * A copy of the bytes a byte path holds.
 *
 * @category getters
 * @since 0.6.0
 */
export const toBytes = (path: BytePath): Effect.Effect<Uint8Array, FsFailure> =>
  named("BytePath.toBytes", Path.pathToBytes(path))

/**
 * The text of a byte path, failing as `UnrepresentableName` when its bytes are not valid UTF-8.
 *
 * @category getters
 * @since 0.6.0
 */
export const toString = (path: BytePath): Effect.Effect<string, FsFailure> =>
  Effect.flatMap(
    named("BytePath.toString", Path.pathToBytes(path)),
    (bytes) => Path.strictString(bytes, "BytePath.toString")
  )

/**
 * The text of a byte path, or none when its bytes are not valid UTF-8.
 *
 * @category getters
 * @since 0.6.0
 */
export const toStringOption = (path: BytePath): Option.Option<string> => decodeOption(bytesOf(path))

/**
 * The text of raw bytes such as an entry name, or none when they are not valid UTF-8.
 *
 * @category getters
 * @since 0.6.0
 */
export const decodeOption: (bytes: Uint8Array) => Option.Option<string> = Option.liftThrowable((bytes) =>
  decoder.decode(bytes)
)

/**
 * Whether a byte path is exactly `/`.
 *
 * @category predicates
 * @since 0.6.0
 */
export const isRoot = (path: BytePath): boolean => {
  const bytes = bytesOf(path)

  return bytes.length === 1 && bytes[0] === SLASH
}

/**
 * Whether a byte path starts with a slash.
 *
 * @category predicates
 * @since 0.6.0
 */
export const isAbsolute = (path: BytePath): boolean => bytesOf(path)[0] === SLASH

/**
 * The final component of a byte path as bytes; empty for the root and for a path that ends in a slash.
 *
 * @category getters
 * @since 0.6.0
 */
export const basename = (path: BytePath): Uint8Array => {
  const bytes = bytesOf(path)

  return bytes.slice(bytes.lastIndexOf(SLASH) + 1)
}

/**
 * The byte path holding everything before the final component, or the path itself when it has no parent.
 *
 * @category getters
 * @since 0.6.0
 */
export const parent = (path: BytePath): BytePath => {
  const bytes = bytesOf(path)
  const slash = bytes.lastIndexOf(SLASH)

  if (slash < 0) return path

  return Internal.make(slash === 0 ? bytes.slice(0, 1) : bytes.slice(0, slash))
}

/**
 * A byte path naming `name` under `path`. A string name is encoded as UTF-8 and not checked: a slash in it
 * adds further components, and a NUL makes a path that fails where it is used.
 *
 * @category combinators
 * @since 0.6.0
 */
export const join = (path: BytePath, name: string | Uint8Array): BytePath => {
  const prefix = bytesOf(path)
  const suffix = Predicate.isString(name) ? encoder.encode(name) : name
  const separator = prefix.length > 0 && prefix[prefix.length - 1] === SLASH ? 0 : 1
  const output = new Uint8Array(prefix.length + separator + suffix.length)
  output.set(prefix)

  if (separator === 1) output[prefix.length] = SLASH
  output.set(suffix, prefix.length + separator)

  return Internal.make(output)
}
