import * as ByteSize from "effect/ByteSize"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as SynchronizedRef from "effect/SynchronizedRef"

/** @internal */
export interface DecodeLimits {
  readonly maxOpaqueBytes: ByteSize.ByteSize
  readonly maxStringBytes: ByteSize.ByteSize
  readonly maxArrayElements: number
}

type XdrErrorReason =
  | "invalid-limit"
  | "truncated"
  | "padding"
  | "invalid-boolean"
  | "invalid-utf8"
  | "length-limit"
  | "range"
  | "discriminant"
  | "trailing-bytes"
  | "sealed"
  | "output-limit"

type Path = ReadonlyArray<string | number>

/** @internal */
export class XdrDecodeError extends Data.TaggedError("XdrDecodeError")<
  { readonly reason: XdrErrorReason; readonly offset: number; readonly path: Path; readonly detail: string }
> {
  override get message(): string {
    return this.detail
  }
}

/** @internal */
export class XdrEncodeError extends Data.TaggedError("XdrEncodeError")<
  { readonly reason: XdrErrorReason; readonly offset: number; readonly path: Path; readonly detail: string }
> {
  override get message(): string {
    return this.detail
  }
}

const valid = (n: number) => Number.isSafeInteger(n) && n >= 0

const padding = (n: number) => (4 - n % 4) % 4

const u32 = (n: number) => {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, n)

  return bytes
}

const join = (parts: ReadonlyArray<Uint8Array>) => {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  parts.reduce((at, part) => {
    bytes.set(part, at)

    return at + part.length
  }, 0)

  return bytes
}

const need = (bytes: Uint8Array, at: number, count: number, path: Path) =>
  count <= bytes.length - at
    ? Result.succeed(void 0) :
    Result.fail(new XdrDecodeError({ reason: "truncated", offset: at, path, detail: "Truncated XDR value" }))

type Read<A> = (
  bytes: Uint8Array,
  at: number,
  limits: DecodeLimits,
  path: Path
) => Result.Result<readonly [A, number], XdrDecodeError>

type Write<A> = (
  value: A,
  limits: DecodeLimits,
  at: number,
  path: Path,
  budget: number
) => Result.Result<Uint8Array, XdrEncodeError>

const CodecImpl = Symbol("XdrCodec")

/** Bidirectional XDR wire description. @internal */
export interface XdrCodec<A> {
  readonly [CodecImpl]: { readonly read: Read<A>; readonly write: Write<A> }
}

const codec = <A>(read: Read<A>, write: Write<A>): XdrCodec<A> => ({ [CodecImpl]: { read, write } })

type ValueOf<C> = C extends XdrCodec<infer A> ? A : never

const readWord: Read<number> = (bytes, at, _limits, path) =>
  Result.map(
    need(bytes, at, 4, path),
    () => [new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at), at + 4] as const
  )

const writeWord: Write<number> = (value, _limits, at, path, budget) =>
  Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff
    ? budget < 4
      ? Result.fail(
        new XdrEncodeError({ reason: "output-limit", offset: at, path, detail: "XDR output exceeds its limit" })
      )
      : Result.succeed(u32(value))
    : Result.fail(new XdrEncodeError({ reason: "range", offset: at, path, detail: "uint32 out of range" }))

const readMany = <A>(
  item: XdrCodec<A>,
  count: number,
  bytes: Uint8Array,
  at: number,
  limits: DecodeLimits,
  path: Path
): Result.Result<readonly [ReadonlyArray<A>, number], XdrDecodeError> => {
  const values: Array<A> = []
  let position = at

  for (let index = 0; index < count; index++) {
    const result = item[CodecImpl].read(bytes, position, limits, [...path, index])

    if (Result.isFailure(result)) return Result.fail(result.failure)

    values.push(result.success[0])
    position = result.success[1]
  }

  return Result.succeed([values, position] as const)
}

const writeMany = <A>(
  item: XdrCodec<A>,
  values: ReadonlyArray<A>,
  limits: DecodeLimits,
  at: number,
  path: Path,
  budget: number
): Result.Result<readonly [ReadonlyArray<Uint8Array>, number], XdrEncodeError> => {
  const parts: Array<Uint8Array> = []
  let position = at

  for (const [index, value] of values.entries()) {
    const result = item[CodecImpl].write(value, limits, position, [...path, index], budget - (position - at))

    if (Result.isFailure(result)) return Result.fail(result.failure)

    parts.push(result.success)
    position += result.success.length
  }

  return Result.succeed([parts, position] as const)
}

const textEncoder = new TextEncoder()

const textDecoder = new TextDecoder("utf-8", { fatal: true })

/** @internal */
export const XdrCodec = {
  uint32: codec(readWord, writeWord),
  int32: codec<number>(
    (bytes, at, limits, path) => Result.map(readWord(bytes, at, limits, path), ([n, next]) => [n | 0, next] as const),
    (n, limits, at, path, budget) =>
      Number.isInteger(n) && n >= -0x8000_0000 && n <= 0x7fff_ffff
        ? writeWord(n >>> 0, limits, at, path, budget)
        : Result.fail(new XdrEncodeError({ reason: "range", offset: at, path, detail: "int32 out of range" }))
  ),
  uint64: codec<bigint>(
    (bytes, at, _limits, path) =>
      Result.map(
        need(bytes, at, 8, path),
        () => [new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(at), at + 8] as const
      ),
    (n, _limits, at, path, budget) => {
      const primitive = (() => {
        try {
          return Result.succeed(BigInt.prototype.valueOf.call(n))
        } catch {
          return Result.fail(new XdrEncodeError({ reason: "range", offset: at, path, detail: "uint64 out of range" }))
        }
      })()

      return Result.flatMap(primitive, (value) => {
        if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
          return Result.fail(new XdrEncodeError({ reason: "range", offset: at, path, detail: "uint64 out of range" }))
        }

        if (budget < 8) {
          return Result.fail(
            new XdrEncodeError({ reason: "output-limit", offset: at, path, detail: "XDR output exceeds its limit" })
          )
        }

        const bytes = new Uint8Array(8)
        new DataView(bytes.buffer).setBigUint64(0, value)

        return Result.succeed(bytes)
      })
    }
  ),
  boolean: codec<boolean>(
    (bytes, at, limits, path) =>
      Result.flatMap(
        readWord(bytes, at, limits, path),
        ([n, next]) =>
          n <= 1
            ? Result.succeed([n === 1, next] as const)
            : Result.fail(
              new XdrDecodeError({ reason: "invalid-boolean", offset: at, path, detail: `Invalid XDR boolean: ${n}` })
            )
      ),
    (value, limits, at, path, budget) => writeWord(value ? 1 : 0, limits, at, path, budget)
  ),
  fixedOpaque: (length: number): XdrCodec<Uint8Array> =>
    codec<Uint8Array>(
      (bytes, at, _limits, path) =>
        !valid(length) ?
          Result.fail(
            new XdrDecodeError({ reason: "invalid-limit", offset: at, path, detail: "Invalid fixed opaque length" })
          )
          : Result.flatMap(need(bytes, at, length + padding(length), path), () =>
            bytes.subarray(at + length, at + length + padding(length)).every((b) => b === 0)
              ? Result.succeed([bytes.slice(at, at + length), at + length + padding(length)] as const)
              : Result.fail(
                new XdrDecodeError({ reason: "padding", offset: at + length, path, detail: "XDR padding must be zero" })
              )),
      (value, _limits, at, path, budget) => {
        if (!valid(length) || !(value instanceof Uint8Array) || value.length !== length) {
          return Result.fail(
            new XdrEncodeError({ reason: "range", offset: at, path, detail: "fixed opaque length mismatch" })
          )
        }

        if (length + padding(length) > budget) {
          return Result.fail(
            new XdrEncodeError({ reason: "output-limit", offset: at, path, detail: "XDR output exceeds its limit" })
          )
        }

        const bytes = new Uint8Array(length + padding(length))
        bytes.set(value)

        return Result.succeed(bytes)
      }
    ),
  opaque: (maxBytes?: ByteSize.ByteSize): XdrCodec<Uint8Array> =>
    codec<Uint8Array>(
      (bytes, at, limits, path) =>
        Result.flatMap(readWord(bytes, at, limits, path), ([length, start]) => {
          const max = Number(maxBytes ?? limits.maxOpaqueBytes)

          if (!valid(max)) {
            return Result.fail(
              new XdrDecodeError({ reason: "invalid-limit", offset: at, path, detail: "Invalid opaque limit" })
            )
          }

          if (length > max || BigInt(length) > limits.maxOpaqueBytes) {
            return Result.fail(
              new XdrDecodeError({
                reason: "length-limit",
                offset: at,
                path,
                detail: "XDR opaque value exceeds its limit"
              })
            )
          }

          return Result.flatMap(need(bytes, start, length + padding(length), path), () =>
            bytes.subarray(start + length, start + length + padding(length)).every((b) => b === 0)
              ? Result.succeed([bytes.slice(start, start + length), start + length + padding(length)] as const)
              : Result.fail(
                new XdrDecodeError({
                  reason: "padding",
                  offset: start + length,
                  path,
                  detail: "XDR padding must be zero"
                })
              ))
        }),
      (value, limits, at, path, budget) => {
        const max = Number(maxBytes ?? limits.maxOpaqueBytes)

        if (!valid(max)) {
          return Result.fail(
            new XdrEncodeError({ reason: "invalid-limit", offset: at, path, detail: "Invalid opaque limit" })
          )
        }

        if (
          !(value instanceof Uint8Array) || value.length > max || BigInt(value.length) > limits.maxOpaqueBytes ||
          value.length > 0xffff_ffff
        ) {
          return Result.fail(
            new XdrEncodeError({
              reason: "length-limit",
              offset: at,
              path,
              detail: "XDR opaque value exceeds its limit"
            })
          )
        }

        if (4 + value.length + padding(value.length) > budget) {
          return Result.fail(
            new XdrEncodeError({ reason: "output-limit", offset: at, path, detail: "XDR output exceeds its limit" })
          )
        }

        const bytes = new Uint8Array(4 + value.length + padding(value.length))
        new DataView(bytes.buffer).setUint32(0, value.length)
        bytes.set(value, 4)

        return Result.succeed(bytes)
      }
    ),
  string: (maxBytes?: ByteSize.ByteSize): XdrCodec<string> =>
    codec(
      (bytes, at, limits, path) =>
        Result.flatMap(
          XdrCodec.opaque(ByteSize.min(maxBytes ?? limits.maxStringBytes, limits.maxStringBytes))[CodecImpl].read(
            bytes,
            at,
            limits,
            path
          ),
          ([value, next]) => {
            try {
              return Result.succeed([textDecoder.decode(value), next] as const)
            } catch {
              return Result.fail(
                new XdrDecodeError({ reason: "invalid-utf8", offset: at, path, detail: "Invalid UTF-8 in XDR string" })
              )
            }
          }
        ),
      (value, limits, at, path, budget) => {
        if (Object.prototype.toString.call(value) !== "[object String]") {
          return Result.fail(new XdrEncodeError({ reason: "range", offset: at, path, detail: "Invalid XDR string" }))
        }

        if (value.length + 4 > budget) {
          return Result.fail(
            new XdrEncodeError({ reason: "output-limit", offset: at, path, detail: "XDR output exceeds its limit" })
          )
        }

        return XdrCodec.opaque(ByteSize.min(maxBytes ?? limits.maxStringBytes, limits.maxStringBytes))[CodecImpl].write(
          textEncoder.encode(value),
          limits,
          at,
          path,
          budget
        )
      }
    ),
  array: <A>(item: XdrCodec<A>, maximum?: number): XdrCodec<ReadonlyArray<A>> =>
    codec(
      (bytes, at, limits, path) =>
        Result.flatMap(readWord(bytes, at, limits, path), ([count, start]) =>
          !valid(maximum ?? limits.maxArrayElements)
            ? Result.fail(
              new XdrDecodeError({ reason: "invalid-limit", offset: at, path, detail: "Invalid array limit" })
            )
            : count > (maximum ?? limits.maxArrayElements) || count > limits.maxArrayElements
            ? Result.fail(
              new XdrDecodeError({
                reason: "length-limit",
                offset: at,
                path,
                detail: "XDR array exceeds its element limit"
              })
            )
            : readMany(item, count, bytes, start, limits, path)),
      (values, limits, at, path, budget) =>
        !Array.isArray(values) || !valid(maximum ?? limits.maxArrayElements) ||
          values.length > (maximum ?? limits.maxArrayElements) || values.length > limits.maxArrayElements ||
          values.length > 0xffff_ffff
          ? Result.fail(
            new XdrEncodeError({
              reason: "length-limit",
              offset: at,
              path,
              detail: "XDR array exceeds its element limit"
            })
          )
          : budget < 4 ?
          Result.fail(
            new XdrEncodeError({ reason: "output-limit", offset: at, path, detail: "XDR output exceeds its limit" })
          )
          : Result.map(
            writeMany(item, values, limits, at + 4, path, budget - 4),
            ([parts]) => join([u32(values.length), ...parts])
          )
    ),
  fixedArray: <A>(item: XdrCodec<A>, count: number): XdrCodec<ReadonlyArray<A>> =>
    codec(
      (bytes, at, limits, path) =>
        !valid(count) || count > limits.maxArrayElements
          ? Result.fail(
            new XdrDecodeError({ reason: "invalid-limit", offset: at, path, detail: "Invalid fixed array length" })
          )
          : readMany(item, count, bytes, at, limits, path),
      (values, limits, at, path, budget) =>
        !Array.isArray(values) || values.length !== count || count > limits.maxArrayElements
          ? Result.fail(
            new XdrEncodeError({ reason: "length-limit", offset: at, path, detail: "fixed array length mismatch" })
          )
          : Result.map(writeMany(item, values, limits, at, path, budget), ([parts]) => join(parts))
    ),
  dependent: <H, B>(
    head: XdrCodec<H>,
    select: (head: H) => XdrCodec<B> | undefined
  ): XdrCodec<{ readonly head: H; readonly body: B }> =>
    codec(
      (bytes, at, limits, path) =>
        Result.flatMap(head[CodecImpl].read(bytes, at, limits, [...path, "head"]), ([header, start]) => {
          const body = select(header)

          return body === undefined ?
            Result.fail(
              new XdrDecodeError({ reason: "discriminant", offset: at, path, detail: "Unknown XDR discriminant" })
            )
            : Result.map(body[CodecImpl].read(bytes, start, limits, [...path, "body"]), ([value, next]) =>
              [{ head: header, body: value }, next] as const)
        }),
      (value, limits, at, path, budget) => {
        if (value == null || Object(value) !== value) {
          return Result.fail(
            new XdrEncodeError({ reason: "range", offset: at, path, detail: "Invalid dependent XDR value" })
          )
        }

        const body = select(value.head)

        return body === undefined ?
          Result.fail(
            new XdrEncodeError({ reason: "discriminant", offset: at, path, detail: "Unknown XDR discriminant" })
          )
          : Result.flatMap(head[CodecImpl].write(value.head, limits, at, [...path, "head"], budget), (prefix) =>
            Result.map(
              body[CodecImpl].write(value.body, limits, at + prefix.length, [...path, "body"], budget - prefix.length),
              (suffix) =>
                join([prefix, suffix])
            ))
      }
    ),
  struct: <const F extends Readonly<Record<string, XdrCodec<any>>>>(
    fields: F
  ): XdrCodec<{ readonly [K in keyof F]: ValueOf<F[K]> }> => {
    const entries = Object.entries(fields)

    return codec(
      (bytes, at, limits, path) =>
        Result.map(
          entries.reduce<Result.Result<readonly [ReadonlyArray<readonly [string, unknown]>, number], XdrDecodeError>>(
            (state, [name, field]) =>
              Result.flatMap(state, ([values, position]) =>
                Result.map(field[CodecImpl].read(bytes, position, limits, [...path, name]), ([value, next]) =>
                  [[...values, [name, value] as const], next] as const)),
            Result.succeed([[], at] as const)
          ),
          // SAFETY: Every entry comes from the corresponding field descriptor and retains its key.
          ([values, next]) =>
            [Object.fromEntries(values) as { readonly [K in keyof F]: ValueOf<F[K]> }, next] as const
        ),
      (value, limits, at, path, budget) =>
        value == null || Object(value) !== value ?
          Result.fail(new XdrEncodeError({ reason: "range", offset: at, path, detail: "Invalid XDR struct value" })) :
          Result.map(
            entries.reduce<Result.Result<readonly [ReadonlyArray<Uint8Array>, number], XdrEncodeError>>(
              (state, [name, field]) =>
                Result.flatMap(state, ([parts, position]) =>
                  Result.map(
                    // SAFETY: name comes from Object.entries(fields), so it is a key of F.
                    field[CodecImpl].write(
                      value[name as keyof F],
                      limits,
                      position,
                      [...path, name],
                      budget - (position - at)
                    ),
                    (part) => [[...parts, part], position + part.length] as const
                  )),
              Result.succeed([[], at] as const)
            ),
            ([parts]) => join(parts)
          )
    )
  },
  discriminant: <const F extends Readonly<Record<number, XdrCodec<any>>>>(
    cases: F
  ): XdrCodec<{ readonly [K in keyof F]: { readonly tag: K; readonly value: ValueOf<F[K]> } }[keyof F]> =>
    codec<{ readonly [K in keyof F]: { readonly tag: K; readonly value: ValueOf<F[K]> } }[keyof F]>(
      (bytes, at, limits, path) =>
        Result.flatMap(readWord(bytes, at, limits, path), ([tag, start]) => {
          const selected = cases[tag]

          return Object.hasOwn(cases, tag) && selected !== undefined
            ? Result.map(selected[CodecImpl].read(bytes, start, limits, [...path, tag]), ([value, next]) =>
              // SAFETY: The own-key check selects the descriptor for this numeric tag.
              [
                { tag, value },
                next
              ] as const)
            : Result.fail(
              new XdrDecodeError({
                reason: "discriminant",
                offset: at,
                path,
                detail: `Invalid XDR discriminant: ${tag}`
              })
            )
        }),
      (value, limits, at, path, budget) => {
        if (value == null || Object(value) !== value) {
          return Result.fail(
            new XdrEncodeError({ reason: "range", offset: at, path, detail: "Invalid XDR discriminant value" })
          )
        }

        // SAFETY: discriminant cases use numeric own keys, and the value type carries one of those keys.
        const tag = Number(value.tag)
        const selected: XdrCodec<unknown> | undefined = cases[tag]

        return Object.hasOwn(cases, tag) && selected !== undefined
          ? budget < 4 ?
            Result.fail(
              new XdrEncodeError({ reason: "output-limit", offset: at, path, detail: "XDR output exceeds its limit" })
            ) :
            Result.map(
              selected[CodecImpl].write(value.value, limits, at + 4, [...path, tag], budget - 4),
              (body) => join([u32(tag), body])
            )
          : Result.fail(
            new XdrEncodeError({
              reason: "discriminant",
              offset: at,
              path,
              detail: `Invalid XDR discriminant: ${String(value.tag)}`
            })
          )
      }
    )
} as const

const validateLimits = (limits: DecodeLimits) =>
  valid(ByteSize.toNumberUnsafe(limits.maxOpaqueBytes)) && valid(ByteSize.toNumberUnsafe(limits.maxStringBytes)) &&
    valid(limits.maxArrayElements)
    ? Result.succeed(limits) :
    Result.fail(new XdrDecodeError({ reason: "invalid-limit", offset: 0, path: [], detail: "Invalid XDR limits" }))

const validateEncodeLimits = (limits: DecodeLimits) =>
  valid(ByteSize.toNumberUnsafe(limits.maxOpaqueBytes)) && valid(ByteSize.toNumberUnsafe(limits.maxStringBytes)) &&
    valid(limits.maxArrayElements)
    ? Result.succeed(limits) :
    Result.fail(new XdrEncodeError({ reason: "invalid-limit", offset: 0, path: [], detail: "Invalid XDR limits" }))

const validateOutput = (maxBytes: number) =>
  valid(maxBytes)
    ? Result.succeed(maxBytes)
    : Result.fail(
      new XdrEncodeError({ reason: "invalid-limit", offset: 0, path: [], detail: "Invalid XDR output limit" })
    )

const lift = <A, E>(run: () => Result.Result<A, E>): Effect.Effect<A, E> =>
  Effect.suspend(() => Result.match(run(), { onFailure: Effect.fail, onSuccess: Effect.succeed }))

const encodeValue = <A>(value: A, description: XdrCodec<A>, limits: DecodeLimits, at: number, maxBytes: number) =>
  Result.flatMap(
    description[CodecImpl].write(value, limits, at, [], maxBytes - at),
    (bytes) =>
      bytes.length <= maxBytes - at
        ? Result.succeed(bytes) :
        Result.fail(
          new XdrEncodeError({ reason: "output-limit", offset: at, path: [], detail: "XDR output exceeds its limit" })
        )
  )

export interface DecoderSession {
  readonly position: Effect.Effect<number, XdrDecodeError>
  readonly read: <A>(description: XdrCodec<A>) => Effect.Effect<A, XdrDecodeError>
  readonly remaining: Effect.Effect<number, XdrDecodeError>
  readonly finish: Effect.Effect<void, XdrDecodeError>
}

export interface EncoderSession {
  readonly write: <A>(description: XdrCodec<A>, value: A) => Effect.Effect<void, XdrEncodeError>
  readonly appendEncoded: (bytes: Uint8Array) => Effect.Effect<void, XdrEncodeError>
  readonly length: Effect.Effect<number, XdrEncodeError>
  readonly bytes: Effect.Effect<Uint8Array, XdrEncodeError>
  readonly finish: Effect.Effect<Uint8Array, XdrEncodeError>
}

export interface XdrApi {
  readonly decode: <A>(
    bytes: Uint8Array,
    limits: DecodeLimits,
    description: XdrCodec<A>
  ) => Effect.Effect<A, XdrDecodeError>
  readonly encode: <A>(
    value: A,
    description: XdrCodec<A>,
    limits: DecodeLimits,
    maxBytes: number
  ) => Effect.Effect<Uint8Array, XdrEncodeError>
  readonly openReader: (bytes: Uint8Array, limits: DecodeLimits) => Effect.Effect<DecoderSession, XdrDecodeError>
  readonly openWriter: (limits: DecodeLimits, maxBytes: number) => Effect.Effect<EncoderSession, XdrEncodeError>
}

export const Xdr = Context.Service<XdrApi>("@effect-vfs/nfs/Xdr")

const decode = <A>(bytes: Uint8Array, limits: DecodeLimits, description: XdrCodec<A>) =>
  lift(() =>
    Result.flatMap(
      validateLimits(limits),
      () =>
        Result.flatMap(description[CodecImpl].read(bytes, 0, limits, []), ([value, at]) =>
          at === bytes.length
            ? Result.succeed(value) :
            Result.fail(
              new XdrDecodeError({
                reason: "trailing-bytes",
                offset: at,
                path: [],
                detail: "Trailing bytes after XDR message"
              })
            ))
    )
  )

const encode = <A>(value: A, description: XdrCodec<A>, limits: DecodeLimits, maxBytes: number) =>
  lift(() =>
    Result.flatMap(
      validateEncodeLimits(limits),
      () => Result.flatMap(validateOutput(maxBytes), () => encodeValue(value, description, limits, 0, maxBytes))
    )
  )

const openReader = (source: Uint8Array, limits: DecodeLimits): Effect.Effect<DecoderSession, XdrDecodeError> =>
  Effect.flatMap(
    lift(() => validateLimits(limits)),
    () =>
      Effect.map(SynchronizedRef.make({ at: 0, sealed: false }), (state): DecoderSession => {
        const bytes = source.slice()

        const read = <A>(description: XdrCodec<A>) =>
          SynchronizedRef.modifyEffect(state, (current) =>
            current.sealed
              ? Effect.fail(
                new XdrDecodeError({ reason: "sealed", offset: current.at, path: [], detail: "XDR reader is sealed" })
              )
              : lift(() => description[CodecImpl].read(bytes, current.at, limits, [])).pipe(
                Effect.map(([value, at]) => [value, { at, sealed: false }] as const)
              ))

        const position = SynchronizedRef.modifyEffect(state, (current) =>
          current.sealed
            ? Effect.fail(
              new XdrDecodeError({ reason: "sealed", offset: current.at, path: [], detail: "XDR reader is sealed" })
            )
            : Effect.succeed([current.at, current] as const))

        const remaining = SynchronizedRef.modifyEffect(state, (current) =>
          current.sealed
            ? Effect.fail(
              new XdrDecodeError({ reason: "sealed", offset: current.at, path: [], detail: "XDR reader is sealed" })
            )
            : Effect.succeed([bytes.length - current.at, current] as const))

        const finish = SynchronizedRef.modifyEffect(state, (current) =>
          current.sealed ?
            Effect.fail(
              new XdrDecodeError({ reason: "sealed", offset: current.at, path: [], detail: "XDR reader is sealed" })
            ) :
            current.at !== bytes.length
            ? Effect.fail(
              new XdrDecodeError({
                reason: "trailing-bytes",
                offset: current.at,
                path: [],
                detail: "Trailing bytes after XDR message"
              })
            ) :
            Effect.succeed([void 0, { ...current, sealed: true }] as const))

        return { read, position, remaining, finish }
      })
  )

const openWriter = (limits: DecodeLimits, maxBytes: number): Effect.Effect<EncoderSession, XdrEncodeError> =>
  Effect.flatMap(
    lift(() => Result.flatMap(validateEncodeLimits(limits), () => validateOutput(maxBytes))),
    () =>
      Effect.map(
        // SAFETY: The empty parts array is the initial immutable writer state.
        SynchronizedRef.make({ parts: [] as ReadonlyArray<Uint8Array>, length: 0, sealed: false }),
        (state): EncoderSession => {
          const sealed = (at: number) =>
            Effect.fail(new XdrEncodeError({ reason: "sealed", offset: at, path: [], detail: "XDR writer is sealed" }))

          const write = <A>(description: XdrCodec<A>, value: A) =>
            SynchronizedRef.modifyEffect(state, (current) =>
              current.sealed ?
                sealed(current.length)
                : lift(() => encodeValue(value, description, limits, current.length, maxBytes)).pipe(
                  Effect.map((part) =>
                    [void 0, {
                      parts: [...current.parts, part],
                      length: current.length + part.length,
                      sealed: false
                    }] as const
                  )
                ))

          const appendEncoded = (bytes: Uint8Array) =>
            SynchronizedRef.modifyEffect(state, (current) =>
              current.sealed ?
                sealed(current.length)
                : bytes.length > maxBytes - current.length ?
                Effect.fail(
                  new XdrEncodeError({
                    reason: "output-limit",
                    offset: current.length,
                    path: [],
                    detail: "XDR output exceeds its limit"
                  })
                )
                : Effect.succeed(
                  [void 0, {
                    parts: [...current.parts, bytes.slice()],
                    length: current.length + bytes.length,
                    sealed: false
                  }] as const
                ))

          const length = SynchronizedRef.modifyEffect(
            state,
            (current) => current.sealed ? sealed(current.length) : Effect.succeed([current.length, current] as const)
          )

          const bytes = SynchronizedRef.modifyEffect(
            state,
            (current) =>
              current.sealed ? sealed(current.length) : Effect.succeed([join(current.parts), current] as const)
          )

          const finish = SynchronizedRef.modifyEffect(state, (current) =>
            current.sealed
              ? sealed(current.length)
              : Effect.succeed([join(current.parts), { ...current, sealed: true }] as const))

          return { write, appendEncoded, length, bytes, finish }
        }
      )
  )

export const make = { decode, encode, openReader, openWriter } satisfies XdrApi

export const layer = Layer.succeed(Xdr, make)

/** Compiles a self-contained whole-value Schema codec. @internal */
export const compile = <A>(
  description: XdrCodec<A>,
  valueSchema: Schema.Codec<A>,
  limits: DecodeLimits,
  maxBytes: number
): Schema.Codec<A, Uint8Array> =>
  Schema.Uint8Array.pipe(Schema.decodeTo(
    valueSchema,
    SchemaTransformation.transformEffect({
      decode: (bytes, options) =>
        decode(bytes, limits, description).pipe(
          Effect.mapError((error) => new SchemaIssue.InvalidValue({ message: error.detail }, bytes, options))
        ),
      encode: (value, options) =>
        encode(value, description, limits, maxBytes).pipe(
          Effect.mapError((error) => new SchemaIssue.InvalidValue({ message: error.detail }, value, options))
        )
    })
  ))
