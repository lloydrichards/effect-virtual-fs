// NDJSON framing for the tree codecs: one JSON value per line, and every line, the last included, ends in a
// newline. The reader works on bytes and copies the pieces of a line that spans chunks into one buffer before
// decoding any of it, so a UTF-8 sequence split across chunks decodes whole, and it refuses a line as soon as the
// line outgrows its bound, holding at most twice the bound however finely the line is chunked. Each line decodes
// with a fatal decoder that keeps a byte-order mark, so malformed UTF-8, a mark, a carriage return before the
// newline and an empty line are all refused.
// `Stream.decodeText` and `Stream.splitLines` fit none of this: the first replaces malformed bytes and drops a
// truncated final sequence, and the second has no bound and also splits on a lone carriage return.
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import type * as Schema from "effect/Schema"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import type { ImageFailure } from "../VfsError.js"
import { imageFailure } from "./errors.js"
import { isAttachedBytes } from "./path.js"
import { WALK_YIELD_INTERVAL } from "./volumeState.js"

const NEWLINE = 0x0a

const CARRIAGE_RETURN = 0x0d

/** @internal */
export interface Framing {
  readonly operation: string
  // The fields a chunk that is not attached bytes, and a line that is not UTF-8 JSON, name.
  readonly inputField: string
  readonly textField: string
}

// The part of a budget the framing charges: a line as it grows, its own bound and the input's, and the input once
// the line ends.
/** @internal */
export interface FrameMeter {
  // A line's length so far, without its newline, and whether its newline has been read.
  readonly line: (bytes: number, ended: boolean) => Result.Result<void, ImageFailure>
}

// What a codec does with the lines it reads: each parsed line in order, then the end of the input.
/** @internal */
export interface LineFold<A> {
  readonly line: (value: typeof Schema.Unknown.Type, index: number) => Result.Result<void, ImageFailure>
  readonly end: () => Result.Result<A, ImageFailure>
}

// A byte limit as a number to compare counts against. Counts stay below the largest safe integer, since they
// measure input in memory, so a limit past it bounds nothing.
/** @internal */
export const byteLimit = (limit: ByteSize.ByteSize): number => {
  const bytes = ByteSize.toBigInt(limit)

  return bytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.POSITIVE_INFINITY : Number(bytes)
}

const concat = (pieces: ReadonlyArray<Uint8Array>, length: number): Uint8Array => {
  const out = new Uint8Array(length)
  let offset = 0

  for (const piece of pieces) {
    out.set(piece, offset)
    offset += piece.length
  }

  return out
}

const EMPTY = new Uint8Array(0)

const makeReader = <A>(framing: Framing, meter: FrameMeter, fold: LineFold<A>) => {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

  const invalid = (cause?: unknown) =>
    imageFailure(framing.operation, "InvalidEncoding", { field: framing.textField, cause })

  // The start of a line the chunks so far have not ended, copied into one buffer that doubles as it fills, since a
  // chunk's bytes may be reused once read and a view per chunk would cost more than the bytes it holds.
  let pending = EMPTY
  let pendingBytes = 0
  let lines = 0

  const hold = (piece: Uint8Array, length: number) => {
    if (length > pending.length) {
      const grown = new Uint8Array(Math.max(length, pending.length * 2))
      grown.set(pending.subarray(0, pendingBytes))
      pending = grown
    }

    pending.set(piece, pendingBytes)
    pendingBytes = length
  }

  const parse = (bytes: Uint8Array): Result.Result<typeof Schema.Unknown.Type, ImageFailure> => {
    if (bytes.length === 0 || bytes[bytes.length - 1] === CARRIAGE_RETURN) return Result.fail(invalid())

    try {
      return Result.succeed(JSON.parse(decoder.decode(bytes)))
    } catch (cause) {
      return Result.fail(invalid(cause))
    }
  }

  // Reads the lines a chunk holds from `start`, a batch at a time, and returns where it stopped.
  const scan = (chunk: Uint8Array, from: number): Result.Result<number, ImageFailure> => {
    for (let start = from, batch = 0; start < chunk.length; batch++) {
      if (batch === WALK_YIELD_INTERVAL) return Result.succeed(start)
      const newline = chunk.indexOf(NEWLINE, start)
      const stop = newline < 0 ? chunk.length : newline
      const length = pendingBytes + stop - start
      const bounded = meter.line(length, newline >= 0)

      if (Result.isFailure(bounded)) return Result.fail(bounded.failure)

      if (newline < 0) {
        hold(chunk.subarray(start), length)
        break
      }

      let bytes = chunk.subarray(start, stop)

      if (pendingBytes > 0) {
        hold(bytes, length)
        bytes = pending.subarray(0, length)
        // A long line does not keep its buffer once it is read.
        pending = EMPTY
        pendingBytes = 0
      }

      start = newline + 1
      const read = Result.flatMap(parse(bytes), (value) => fold.line(value, lines++))

      if (Result.isFailure(read)) return Result.fail(read.failure)
    }

    return Result.succeed(chunk.length)
  }

  const push = Effect.fnUntraced(function*(chunk: Uint8Array) {
    if (!isAttachedBytes(chunk)) {
      return yield* imageFailure(framing.operation, "InvalidEncoding", { field: framing.inputField })
    }

    // Yields between batches, so a large chunk leaves room for other fibers and for interruption.
    for (let start = yield* Effect.fromResult(scan(chunk, 0)); start < chunk.length;) {
      yield* Effect.yieldNow
      start = yield* Effect.fromResult(scan(chunk, start))
    }
  })

  // Input that stops inside a line was cut short, even when what it holds would parse.
  const end = () => (pendingBytes > 0 ? Result.fail(invalid()) : fold.end())

  return { push, end }
}

// Reads a stream of byte chunks as lines, folding each as it ends, and holds at most one unfinished line. Each run
// starts a fresh meter and fold.
/** @internal */
export const sink = <A>(
  framing: Framing,
  start: () => { readonly meter: FrameMeter; readonly fold: LineFold<A> }
): Sink.Sink<A, Uint8Array, never, ImageFailure> =>
  Sink.foldArray(
    () => {
      const { fold, meter } = start()

      return makeReader(framing, meter, fold)
    },
    () => true,
    (reader, chunks: ReadonlyArray<Uint8Array>) =>
      Effect.as(Effect.forEach(chunks, (chunk) => reader.push(chunk), { discard: true }), reader)
  ).pipe(Sink.mapEffect((reader) => Effect.fromResult(reader.end())))

const encoder = new TextEncoder()

// One chunk holding each line and its newline.
/** @internal */
export const frame = (lines: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(lines.reduce((sum, line) => sum + line.length + 1, 0))
  let offset = 0

  for (const line of lines) {
    out.set(line, offset)
    offset += line.length
    out[offset++] = NEWLINE
  }

  return out
}

/** @internal */
export const encodeLine = (text: string): Uint8Array => encoder.encode(text)

/** @internal */
export const collect = <E, R>(stream: Stream.Stream<Uint8Array, E, R>): Effect.Effect<Uint8Array, E, R> =>
  Effect.map(
    Stream.runCollect(stream),
    (chunks) => concat(chunks, chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  )
