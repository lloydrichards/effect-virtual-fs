import { ByteSize, Chunk, Context, Data, Effect, Layer, MutableRef, Result } from "effect"

export interface DecodeLimits {
  readonly maxOpaqueBytes: ByteSize.ByteSize
  readonly maxStringBytes: ByteSize.ByteSize
  readonly maxArrayElements: number
}

export class XdrDecodeError extends Data.TaggedError("XdrDecodeError")<{ readonly detail: string }> {}

export class XdrEncodeError extends Data.TaggedError("XdrEncodeError")<{ readonly detail: string }> {}

const validSize = (value: number): boolean => Number.isSafeInteger(value) && value >= 0

const padding = (length: number): number => (4 - length % 4) % 4

const decodeError = (detail: string) => new XdrDecodeError({ detail })

const encodeError = (detail: string) => new XdrEncodeError({ detail })

const utf8Decoder = new TextDecoder("utf-8", { fatal: true })

const utf8Encoder = new TextEncoder()

type DecodeResult<A> = Result.Result<A, XdrDecodeError>

type EncodeResult<A> = Result.Result<A, XdrEncodeError>

interface ReadKernel {
  readonly position: () => number
  readonly restore: (position: number) => void
  readonly limits: DecodeLimits
  readonly remaining: () => number
  readonly uint32: () => DecodeResult<number>
  readonly int32: () => DecodeResult<number>
  readonly uint64: () => DecodeResult<bigint>
  readonly fixedOpaque: (length: number) => DecodeResult<Uint8Array>
  readonly opaque: (maximum: ByteSize.ByteSize) => DecodeResult<Uint8Array>
  readonly finish: () => DecodeResult<void>
}

interface WriteKernel {
  readonly uint32: (value: number) => EncodeResult<void>
  readonly int32: (value: number) => EncodeResult<void>
  readonly uint64: (value: bigint) => EncodeResult<void>
  readonly fixedOpaque: (value: Uint8Array, length: number) => EncodeResult<void>
  readonly opaque: (value: Uint8Array) => EncodeResult<void>
  readonly bytes: () => Uint8Array
}

const makeReadKernel = (bytes: Uint8Array, limits: DecodeLimits): DecodeResult<ReadKernel> => {
  if (!validSize(ByteSize.toNumberUnsafe(limits.maxOpaqueBytes))) {
    return Result.fail(decodeError("Invalid opaque limit"))
  }

  if (!validSize(ByteSize.toNumberUnsafe(limits.maxStringBytes))) {
    return Result.fail(decodeError("Invalid string limit"))
  }

  if (!validSize(limits.maxArrayElements)) return Result.fail(decodeError("Invalid array limit"))

  const offset = MutableRef.make(0)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const position = () => MutableRef.get(offset)
  const restore = (value: number) => MutableRef.set(offset, value)
  const remaining = () => bytes.length - position()

  const take = <A>(width: number, read: (position: number) => A): DecodeResult<A> => {
    if (!validSize(width) || width > remaining()) return Result.fail(decodeError("Truncated XDR value"))
    const start = position()
    const value = read(start)
    restore(start + width)

    return Result.succeed(value)
  }

  const uint32 = () => take(4, (start) => view.getUint32(start))
  const int32 = () => take(4, (start) => view.getInt32(start))
  const uint64 = () => take(8, (start) => view.getBigUint64(start))

  const fixedOpaque = (length: number): DecodeResult<Uint8Array> => {
    if (!validSize(length)) return Result.fail(decodeError("Invalid fixed opaque length"))

    return Result.flatMap(take(length + padding(length), (start) => start), (start) => {
      const end = start + length

      if (!bytes.subarray(end, end + padding(length)).every((byte) => byte === 0)) {
        restore(start)

        return Result.fail(decodeError("XDR padding must be zero"))
      }

      return Result.succeed(bytes.slice(start, end))
    })
  }

  const opaque = (maximum: ByteSize.ByteSize): DecodeResult<Uint8Array> => {
    if (!validSize(ByteSize.toNumberUnsafe(maximum))) return Result.fail(decodeError("Invalid opaque limit"))

    if (remaining() < 4) return Result.fail(decodeError("Truncated XDR value"))
    const start = position()
    const length = view.getUint32(start)

    if (BigInt(length) > maximum || BigInt(length) > limits.maxOpaqueBytes) {
      return Result.fail(decodeError("XDR opaque value exceeds its limit"))
    }

    const width = 4 + length + padding(length)

    if (width > remaining()) return Result.fail(decodeError("Truncated XDR value"))
    const end = start + 4 + length

    if (!bytes.subarray(end, start + width).every((byte) => byte === 0)) {
      return Result.fail(decodeError("XDR padding must be zero"))
    }

    restore(start + width)

    return Result.succeed(bytes.slice(start + 4, end))
  }

  const finish = (): DecodeResult<void> =>
    remaining() === 0
      ? Result.succeed(void 0)
      : Result.fail(decodeError("Trailing bytes after XDR message"))

  return Result.succeed({ limits, position, restore, remaining, uint32, int32, uint64, fixedOpaque, opaque, finish })
}

const makeWriteKernel = (): WriteKernel => {
  const chunks = MutableRef.make(Chunk.empty<Uint8Array>())
  const length = MutableRef.make(0)

  const append = (part: Uint8Array): EncodeResult<void> => {
    MutableRef.set(chunks, Chunk.append(MutableRef.get(chunks), part))
    MutableRef.set(length, MutableRef.get(length) + part.length)

    return Result.succeed(void 0)
  }

  const uint32 = (value: number): EncodeResult<void> => {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
      return Result.fail(encodeError("uint32 out of range"))
    }

    const part = new Uint8Array(4)
    new DataView(part.buffer).setUint32(0, value)

    return append(part)
  }

  const int32 = (value: number): EncodeResult<void> => {
    if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
      return Result.fail(encodeError("int32 out of range"))
    }

    return uint32(value >>> 0)
  }

  const uint64 = (value: bigint): EncodeResult<void> => {
    if (value < 0n || value > 0xffff_ffff_ffff_ffffn) return Result.fail(encodeError("uint64 out of range"))
    const part = new Uint8Array(8)
    new DataView(part.buffer).setBigUint64(0, value)

    return append(part)
  }

  const fixedOpaque = (value: Uint8Array, expected: number): EncodeResult<void> => {
    if (!validSize(expected) || value.length !== expected) {
      return Result.fail(encodeError("fixed opaque length mismatch"))
    }

    const part = new Uint8Array(expected + padding(expected))
    part.set(value)

    return append(part)
  }

  const opaque = (value: Uint8Array): EncodeResult<void> => {
    if (value.length > 0xffff_ffff) return Result.fail(encodeError("opaque length out of range"))
    const part = new Uint8Array(4 + value.length + padding(value.length))
    new DataView(part.buffer).setUint32(0, value.length)
    part.set(value, 4)

    return append(part)
  }

  const bytes = () => {
    const output = new Uint8Array(MutableRef.get(length))
    Chunk.reduce(MutableRef.get(chunks), 0, (position, part) => {
      output.set(part, position)

      return position + part.length
    })

    return output
  }

  return { uint32, int32, uint64, fixedOpaque, opaque, bytes }
}

const CodecImpl = Symbol("XdrCodec")

export interface XdrCodec<A> {
  readonly [CodecImpl]: {
    readonly read: (kernel: ReadKernel) => DecodeResult<A>
    readonly write: (kernel: WriteKernel, value: A) => EncodeResult<void>
  }
}

const codec = <A>(
  read: (kernel: ReadKernel) => DecodeResult<A>,
  write: (kernel: WriteKernel, value: A) => EncodeResult<void>
): XdrCodec<A> => ({
  [CodecImpl]: { read, write }
})

type ValueOf<C> = C extends XdrCodec<infer A> ? A : never

export const XdrCodec = {
  uint32: codec((reader) => reader.uint32(), (writer, value) => writer.uint32(value)),
  int32: codec((reader) => reader.int32(), (writer, value) => writer.int32(value)),
  uint64: codec((reader) => reader.uint64(), (writer, value) => writer.uint64(value)),
  boolean: codec(
    (reader) =>
      Result.flatMap(reader.uint32(), (value) =>
        value > 1
          ? Result.fail(decodeError(`Invalid XDR boolean: ${value}`))
          : Result.succeed(value === 1)),
    (writer, value) => writer.uint32(value ? 1 : 0)
  ),
  fixedOpaque: (length: number) =>
    codec(
      (reader) => reader.fixedOpaque(length),
      (writer, value: Uint8Array) => writer.fixedOpaque(value, length)
    ),
  opaque: (maximum?: ByteSize.ByteSize) =>
    codec(
      (reader) => reader.opaque(maximum ?? reader.limits.maxOpaqueBytes),
      (writer, value: Uint8Array) => {
        if (maximum !== undefined && !validSize(ByteSize.toNumberUnsafe(maximum))) {
          return Result.fail(encodeError("Invalid opaque limit"))
        }

        return maximum !== undefined && BigInt(value.length) > maximum
          ? Result.fail(encodeError("XDR opaque value exceeds its limit"))
          : writer.opaque(value)
      }
    ),
  string: (maximum?: ByteSize.ByteSize) =>
    codec(
      (reader) =>
        Result.flatMap(
          reader.opaque(ByteSize.min(maximum ?? reader.limits.maxStringBytes, reader.limits.maxStringBytes)),
          (bytes) => {
            try {
              return Result.succeed(utf8Decoder.decode(bytes))
            } catch {
              return Result.fail(decodeError("Invalid UTF-8 in XDR string"))
            }
          }
        ),
      (writer, value: string) => {
        if (maximum !== undefined && !validSize(ByteSize.toNumberUnsafe(maximum))) {
          return Result.fail(encodeError("Invalid string limit"))
        }

        const bytes = utf8Encoder.encode(value)

        return maximum !== undefined && BigInt(bytes.length) > maximum
          ? Result.fail(encodeError("XDR string exceeds its limit"))
          : writer.opaque(bytes)
      }
    ),
  fixedArray: <A>(item: XdrCodec<A>, count: number): XdrCodec<ReadonlyArray<A>> =>
    codec(
      (reader) => {
        if (!validSize(count) || count > reader.limits.maxArrayElements) {
          return Result.fail(
            decodeError("Invalid fixed array length")
          )
        }

        return Result.map(
          Array.from({ length: count }).reduce<DecodeResult<Chunk.Chunk<A>>>(
            (state) =>
              Result.flatMap(state, (values) =>
                Result.map(item[CodecImpl].read(reader), (value) => Chunk.append(values, value))),
            Result.succeed(Chunk.empty<A>())
          ),
          Chunk.toReadonlyArray
        )
      },
      (writer, values) => {
        if (!validSize(count) || values.length !== count) {
          return Result.fail(encodeError("fixed array length mismatch"))
        }

        return values.reduce<EncodeResult<void>>(
          (state, value) =>
            Result.flatMap(state, () => item[CodecImpl].write(writer, value)),
          Result.succeed(void 0)
        )
      }
    ),
  array: <A>(item: XdrCodec<A>, maximum?: number): XdrCodec<ReadonlyArray<A>> =>
    codec(
      (reader) => {
        const limit = maximum ?? reader.limits.maxArrayElements

        if (!validSize(limit)) return Result.fail(decodeError("Invalid array limit"))

        return Result.flatMap(reader.uint32(), (count) => {
          if (count > limit || count > reader.limits.maxArrayElements) {
            return Result.fail(decodeError("XDR array exceeds its element limit"))
          }

          return Result.map(
            Array.from({ length: count }).reduce<DecodeResult<Chunk.Chunk<A>>>(
              (state) =>
                Result.flatMap(state, (values) =>
                  Result.map(item[CodecImpl].read(reader), (value) => Chunk.append(values, value))),
              Result.succeed(Chunk.empty<A>())
            ),
            Chunk.toReadonlyArray
          )
        })
      },
      (writer, values) => {
        if (maximum !== undefined && (!validSize(maximum) || values.length > maximum)) {
          return Result.fail(encodeError("XDR array exceeds its element limit"))
        }

        return Result.flatMap(writer.uint32(values.length), () =>
          values.reduce<EncodeResult<void>>(
            (state, value) =>
              Result.flatMap(state, () => item[CodecImpl].write(writer, value)),
            Result.succeed(void 0)
          ))
      }
    ),
  struct: <const F extends Readonly<Record<string, XdrCodec<any>>>>(
    fields: F
  ): XdrCodec<{ readonly [K in keyof F]: ValueOf<F[K]> }> => {
    const entries = Object.entries(fields)

    return codec(
      // SAFETY: Each decoded entry retains its field name and value as a tuple.
      (reader) =>
        Result.map(
          entries.reduce<DecodeResult<Chunk.Chunk<readonly [string, unknown]>>>(
            (state, [name, field]) =>
              Result.flatMap(
                state,
                (values) =>
                  Result.map(field[CodecImpl].read(reader), (value) => Chunk.append(values, [name, value] as const))
              ),
            Result.succeed(Chunk.empty<readonly [string, unknown]>())
          ),
          (values) => Object.fromEntries(Chunk.toReadonlyArray(values)) as { readonly [K in keyof F]: ValueOf<F[K]> }
        ),
      // SAFETY: Entries come from fields, so their names are keys of F.
      (writer, value) =>
        entries.reduce<EncodeResult<void>>(
          (state, [name, field]) => Result.flatMap(state, () => field[CodecImpl].write(writer, value[name as keyof F])),
          Result.succeed(void 0)
        )
    )
  }
} as const

export interface DecoderSession {
  readonly read: <A>(value: XdrCodec<A>) => Effect.Effect<A, XdrDecodeError>
  readonly remaining: Effect.Effect<number>
  readonly finish: Effect.Effect<void, XdrDecodeError>
}

export interface XdrApi {
  readonly decode: <A>(bytes: Uint8Array, limits: DecodeLimits, value: XdrCodec<A>) => Effect.Effect<A, XdrDecodeError>
  readonly encode: <A>(value: A, codec: XdrCodec<A>) => Effect.Effect<Uint8Array, XdrEncodeError>
  readonly open: (bytes: Uint8Array, limits: DecodeLimits) => Effect.Effect<DecoderSession, XdrDecodeError>
}

export const Xdr = Context.Service<XdrApi>("@effect-vfs/nfs/Xdr")

const lift = <A, E>(run: () => Result.Result<A, E>): Effect.Effect<A, E> =>
  Effect.suspend(() => Result.match(run(), { onFailure: Effect.fail, onSuccess: Effect.succeed }))

const decode = <A>(bytes: Uint8Array, limits: DecodeLimits, value: XdrCodec<A>) =>
  lift(() =>
    Result.flatMap(
      makeReadKernel(bytes, limits),
      (reader) => Result.flatMap(value[CodecImpl].read(reader), (result) => Result.map(reader.finish(), () => result))
    )
  )

const encode = <A>(value: A, valueCodec: XdrCodec<A>) =>
  lift(() => {
    const writer = makeWriteKernel()

    return Result.map(valueCodec[CodecImpl].write(writer, value), () => writer.bytes())
  })

const open = (bytes: Uint8Array, limits: DecodeLimits): Effect.Effect<DecoderSession, XdrDecodeError> =>
  lift(() =>
    Result.map(makeReadKernel(bytes, limits), (reader) => ({
      read: <A>(value: XdrCodec<A>) =>
        lift(() => {
          const start = reader.position()
          const result = value[CodecImpl].read(reader)

          if (Result.isFailure(result)) reader.restore(start)

          return result
        }),
      remaining: Effect.sync(() => reader.remaining()),
      finish: lift(() => reader.finish())
    }))
  )

export const make = { decode, encode, open } satisfies XdrApi

export const layer = Layer.succeed(Xdr, make)

export interface ChannelAttrs {
  readonly headerPadding: number
  readonly maxRequest: number
  readonly maxResponse: number
  readonly maxCachedResponse: number
  readonly maxOperations: number
  readonly maxRequests: number
  readonly rdmaIrd: ReadonlyArray<number>
}

export const ChannelAttrsCodec: XdrCodec<ChannelAttrs> = XdrCodec.struct({
  headerPadding: XdrCodec.uint32,
  maxRequest: XdrCodec.uint32,
  maxResponse: XdrCodec.uint32,
  maxCachedResponse: XdrCodec.uint32,
  maxOperations: XdrCodec.uint32,
  maxRequests: XdrCodec.uint32,
  rdmaIrd: XdrCodec.array(XdrCodec.uint32, 1)
})

/** Successful CREATE_SESSION result body, excluding operation status and COMPOUND framing. */
export const CreateSessionResponseCodec = XdrCodec.struct({
  sessionId: XdrCodec.fixedOpaque(16),
  sequence: XdrCodec.uint32,
  flags: XdrCodec.uint32,
  fore: ChannelAttrsCodec,
  back: ChannelAttrsCodec
})

export const RpcCallHeader = XdrCodec.struct({
  xid: XdrCodec.uint32,
  messageType: XdrCodec.uint32,
  rpcVersion: XdrCodec.uint32,
  program: XdrCodec.uint32,
  version: XdrCodec.uint32,
  procedure: XdrCodec.uint32
})

export const decodeExample = (bytes: Uint8Array, limits: DecodeLimits) =>
  Effect.flatMap(Xdr, (xdr) => xdr.decode(bytes, limits, RpcCallHeader))

/** A COMPOUND parser can retain valid operations before a malformed one. */
export const previewOperations = Effect.fnUntraced(function*(bytes: Uint8Array, limits: DecodeLimits) {
  const xdr = yield* Xdr
  const session = yield* xdr.open(bytes, limits)
  const count = yield* session.read(XdrCodec.uint32)

  if (count > limits.maxArrayElements) return yield* decodeError("XDR array exceeds its element limit")

  const readOperations = (remaining: number, values: ReadonlyArray<number>): Effect.Effect<{
    readonly values: ReadonlyArray<number>
    readonly malformed: XdrDecodeError | undefined
  }> =>
    remaining === 0
      ? Effect.succeed({ values, malformed: undefined })
      : Effect.result(session.read(XdrCodec.uint32)).pipe(Effect.flatMap((result) =>
        Result.isFailure(result)
          ? Effect.succeed({ values, malformed: result.failure })
          : readOperations(remaining - 1, [...values, result.success])
      ))

  const result = yield* readOperations(count, [])

  if (result.malformed === undefined) yield* session.finish

  return result
})
