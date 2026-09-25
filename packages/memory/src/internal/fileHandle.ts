/**
 * Adapts core file handles to Effect FileSystem files.
 *
 * @internal
 * @since 0.1.0
 */
import type { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Semaphore from "effect/Semaphore"
import { info, openOptions, sizeInput } from "./adapterSupport.js"
import { argumentError, resourceError, toPlatformError } from "./platformError.js"

/** @internal */
export const makeOpen = (caller: Vfs.Caller): FileSystem.FileSystem["open"] => {
  let nextDescriptor = 3

  return Effect.fn("MemoryFileSystem.open")(function*(path, options) {
    const chosen = yield* openOptions(options?.flag ?? "r", options?.mode, "open")

    const handle = yield* caller.open(path, chosen).pipe(
      Effect.mapError((error) => toPlatformError(error, "open", path))
    )

    const fd = nextDescriptor++
    let position = 0n
    let closed = false
    const gate = Semaphore.makeUnsafe(1)
    const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) => gate.withPermit(Effect.uninterruptible(effect))
    yield* Effect.addFinalizer(() =>
      locked(Effect.sync(() => {
        closed = true
      }))
    )

    const read = Effect.fnUntraced(function*(length: number, method: string) {
      if (closed) return yield* resourceError(method, fd)

      if (length > 0 && (position < 0n || position > BigInt(Number.MAX_SAFE_INTEGER))) {
        return yield* resourceError(method, fd, "Invalid file position")
      }

      const { bytes } = yield* handle.pread(length, length === 0 ? 0n : position).pipe(
        Effect.mapError((error) => toPlatformError(error, method, fd))
      )

      position += BigInt(bytes.length)

      return bytes
    })

    const write = Effect.fnUntraced(function*(input: Uint8Array, method: string, all: boolean) {
      // Copy the view so writes accept ArrayBuffer- and SharedArrayBuffer-backed input.
      const bytes = new Uint8Array(input)

      return yield* locked(Effect.gen(function*() {
        if (closed) return yield* resourceError(method, fd)

        if (bytes.length > 0 && (position < 0n || position > BigInt(Number.MAX_SAFE_INTEGER))) {
          return yield* resourceError(method, fd, "Invalid file position")
        }

        let total = 0

        do {
          const part = bytes.subarray(total)

          const operation = chosen.append ? handle.write(part) : handle.pwrite(part, bytes.length === 0 ? 0n : position)
          const written = yield* operation.pipe(Effect.mapError((error) => toPlatformError(error, method, fd)))

          total += written

          if (!chosen.append) position += BigInt(written)
          // `all` is loop-invariant by design: it selects between a single write and
          // writing until every byte is consumed.
          // oxlint-disable-next-line eslint/no-unmodified-loop-condition
        } while (all && total < bytes.length)

        return total
      }))
    })

    return {
      [FileSystem.FileTypeId]: FileSystem.FileTypeId,
      stat: handle.stat.pipe(
        Effect.mapError((error) => toPlatformError(error, "stat", fd)),
        Effect.flatMap((value) => info(value, fd))
      ),
      sync: handle.sync.pipe(Effect.mapError((error) => toPlatformError(error, "sync", fd))),
      seek: Effect.fn("MemoryFile.seek")(function*(offset, from) {
        return yield* locked(Effect.gen(function*() {
          if (closed) return 0n
          const next = from === "start" ? offset : position + offset

          if (next < 0n) {
            return yield* argumentError("seek", "Cannot seek before the start of the file")
          }

          position = next

          return next
        }))
      }),
      read: Effect.fn("MemoryFile.read")(function*(buffer) {
        return yield* locked(Effect.gen(function*() {
          const bytes = yield* read(buffer.length, "read")
          buffer.set(bytes)

          return bytes.length
        }))
      }),
      readAlloc: Effect.fn("MemoryFile.readAlloc")(function*(size) {
        const length = yield* sizeInput(size, "readAlloc")

        return yield* locked(
          Effect.map(
            read(Number(length), "readAlloc"),
            (bytes) => bytes.length === 0 ? Option.none() : Option.some(bytes)
          )
        )
      }),
      truncate: Effect.fn("MemoryFile.truncate")(function*(length) {
        const size = yield* sizeInput(length, "truncate", 0)

        return yield* locked(Effect.gen(function*() {
          yield* handle.truncate(size).pipe(Effect.mapError((error) => toPlatformError(error, "truncate", fd)))

          if (!chosen.append && position > size) position = size
        }))
      }),
      write: (buffer) => write(buffer, "write", false),
      writeAll: (buffer) => Effect.asVoid(write(buffer, "writeAll", true))
    } satisfies FileSystem.File
  })
}
