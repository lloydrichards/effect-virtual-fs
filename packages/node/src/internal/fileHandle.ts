// Node requires promises at this native boundary. The memory operations finish before each promise settles.
/* eslint-disable effecttsgo/async-function, effecttsgo/node-builtin-import */
import type { Handle } from "@effect-vfs/core/SynchronousAdapter"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type { BigIntStats, Stats } from "node:fs"
import {
  dataOf,
  encoded,
  encodingOf,
  type EncodingOptions,
  integer,
  invoke,
  NodeError,
  ownerOf,
  statsOf,
  timesOf
} from "./conversions.js"

export type Position = number | bigint | null

export type Time = number | string | Date

export type StatOptions = { readonly bigint?: boolean | undefined }

export type WriteOptions = Exclude<EncodingOptions, string> | BufferEncoding

const BufferOptionsSchema = Schema.Struct({
  offset: Schema.optional(Schema.Finite),
  length: Schema.optional(Schema.Finite),
  position: Schema.optional(Schema.NullOr(Schema.Union([Schema.Finite, Schema.BigInt])))
})

export type BufferOptions = typeof BufferOptionsSchema.Type

const View = Schema.declare<NodeJS.ArrayBufferView>((value): value is NodeJS.ArrayBufferView =>
  ArrayBuffer.isView(value)
)

const ReadOptionsSchema = Schema.Struct({ ...BufferOptionsSchema.fields, buffer: Schema.optional(View) })

export type ReadOptions = typeof ReadOptionsSchema.Type

const isBufferOptions = Schema.is(BufferOptionsSchema)

const isReadOptions = Schema.is(ReadOptionsSchema)

const bufferOptionsOf = (input: BufferOptions | null | undefined, syscall: string): BufferOptions => {
  if (input === undefined || input === null) return {}

  if (!isBufferOptions(input)) throw new NodeError("EINVAL", syscall)

  return input
}

/** Node owns virtual descriptor numbers. This object owns only its engine handle and cursor. */
export class NodeFileHandle {
  #position = 0
  constructor(
    private readonly handle: Handle,
    readonly path: string,
    readonly flags: string | number,
    readonly mode: number,
    private readonly access: { readonly readable: boolean; readonly writable: boolean; readonly append: boolean },
    private readonly readonly: boolean
  ) {}

  get closed() {
    return this.handle.closed
  }
  get position() {
    return this.#position
  }
  set position(value: number) {
    this.#position = integer(value, "seek")
  }

  private check(syscall: string, write = false): void {
    if (this.closed) throw new NodeError("EBADF", syscall, this.path)

    if (write && this.readonly) throw new NodeError("EROFS", syscall, this.path)
  }
  private at(position: Position | undefined, syscall: string): bigint {
    if (position === null || position === undefined || position === -1) return BigInt(this.#position)

    if (Predicate.isBigInt(position)) {
      if (position < 0n || position > 0x7fffffffffffffffn) throw new NodeError("EINVAL", syscall, this.path)

      return position
    }

    return BigInt(integer(position, syscall))
  }
  private bytes(buffer: NodeJS.ArrayBufferView, syscall: string): Uint8Array {
    if (!ArrayBuffer.isView(buffer)) throw new NodeError("EINVAL", syscall, this.path)

    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  }

  readSync(buffer: NodeJS.ArrayBufferView, options?: BufferOptions): number
  readSync(buffer: NodeJS.ArrayBufferView, offset?: number, length?: number, position?: Position): number
  readSync(
    buffer: NodeJS.ArrayBufferView,
    offsetOrOptions: number | BufferOptions = 0,
    length?: number,
    position: Position = null
  ): number {
    this.check("read")

    if (!this.access.readable) throw new NodeError("EBADF", "read", this.path)
    const bytes = this.bytes(buffer, "read")

    const chosen = Predicate.isNumber(offsetOrOptions)
      ? { offset: offsetOrOptions, length, position }
      : bufferOptionsOf(offsetOrOptions, "read")

    const offset = integer(chosen.offset ?? 0, "read", bytes.length)
    const size = integer(chosen.length ?? bytes.length - offset, "read", bytes.length - offset)
    const selected = chosen.position ?? null
    const at = this.at(selected, "read")
    const content = invoke("read", this.path, () => this.handle.read(size, at))
    bytes.set(content, offset)

    if (selected === null || selected === -1) this.#position = Number(at) + content.length

    return content.length
  }

  read<T extends NodeJS.ArrayBufferView>(buffer: T, options?: BufferOptions): Promise<{ bytesRead: number; buffer: T }>
  read<T extends NodeJS.ArrayBufferView>(
    buffer: T,
    offset?: number,
    length?: number,
    position?: Position
  ): Promise<{ bytesRead: number; buffer: T }>
  read<T extends NodeJS.ArrayBufferView>(
    options: BufferOptions & { readonly buffer: T }
  ): Promise<{ bytesRead: number; buffer: T }>
  read(options?: BufferOptions | null): Promise<{ bytesRead: number; buffer: Buffer }>
  read(options?: ReadOptions | null): Promise<{ bytesRead: number; buffer: NodeJS.ArrayBufferView }>
  async read(
    input?: NodeJS.ArrayBufferView | ReadOptions | null,
    offsetOrOptions: number | BufferOptions = 0,
    length?: number,
    position: Position = null
  ) {
    if (ArrayBuffer.isView(input)) {
      const bytesRead = Predicate.isNumber(offsetOrOptions)
        ? this.readSync(input, offsetOrOptions, length, position)
        : this.readSync(input, offsetOrOptions)

      return { bytesRead, buffer: input }
    }

    const chosen = input ?? {}

    if (!isReadOptions(chosen)) throw new NodeError("EINVAL", "read", this.path)
    const buffer = chosen.buffer ?? Buffer.alloc(16384)

    return { bytesRead: this.readSync(buffer, chosen.offset ?? 0, chosen.length, chosen.position ?? null), buffer }
  }

  private writeInput(
    data: NodeJS.ArrayBufferView | string,
    offsetOrOptions: number | BufferOptions | null | undefined,
    lengthOrEncoding: number | BufferEncoding | undefined,
    position: Position
  ): number {
    this.check("write", true)

    if (!this.access.writable) throw new NodeError("EBADF", "write", this.path)

    if (Predicate.isString(data)) {
      if (offsetOrOptions !== undefined && offsetOrOptions !== null && !Predicate.isNumber(offsetOrOptions)) {
        throw new NodeError("EINVAL", "write", this.path)
      }

      if (lengthOrEncoding !== undefined && !Predicate.isString(lengthOrEncoding)) {
        throw new NodeError("EINVAL", "write", this.path)
      }

      const bytes = dataOf(data, lengthOrEncoding)

      return this.writeInput(bytes, 0, bytes.length, offsetOrOptions ?? null)
    }

    const buffer = this.bytes(data, "write")

    if (lengthOrEncoding !== undefined && !Predicate.isNumber(lengthOrEncoding)) {
      throw new NodeError("EINVAL", "write", this.path)
    }

    const chosen = offsetOrOptions === undefined || offsetOrOptions === null || Predicate.isNumber(offsetOrOptions)
      ? { offset: offsetOrOptions ?? 0, length: lengthOrEncoding, position }
      : bufferOptionsOf(offsetOrOptions, "write")

    const offset = integer(chosen.offset ?? 0, "write", buffer.length)
    const size = integer(chosen.length ?? buffer.length - offset, "write", buffer.length - offset)
    const selected = chosen.position ?? null
    const at = this.at(selected, "write")

    const count = invoke(
      "write",
      this.path,
      () => this.handle.write(buffer.subarray(offset, offset + size), at, this.access.append)
    )

    if (selected === null || selected === -1) {
      this.#position = this.access.append
        ? Number(invoke("fstat", this.path, () => this.handle.stat()).size)
        : Number(at) + count
    }

    return count
  }

  writeSync(data: string, position?: number | null, encoding?: BufferEncoding): number
  writeSync(buffer: NodeJS.ArrayBufferView, options?: BufferOptions): number
  writeSync(buffer: NodeJS.ArrayBufferView, offset?: number, length?: number, position?: Position): number
  writeSync(
    data: NodeJS.ArrayBufferView | string,
    offsetOrOptions?: number | BufferOptions | null,
    lengthOrEncoding?: number | BufferEncoding,
    position: Position = null
  ): number {
    return this.writeInput(data, offsetOrOptions, lengthOrEncoding, position)
  }

  write(
    data: string,
    position?: number | null,
    encoding?: BufferEncoding
  ): Promise<{ bytesWritten: number; buffer: string }>
  write<T extends NodeJS.ArrayBufferView>(
    buffer: T,
    options?: BufferOptions
  ): Promise<{ bytesWritten: number; buffer: T }>
  write<T extends NodeJS.ArrayBufferView>(
    buffer: T,
    offset?: number,
    length?: number,
    position?: Position
  ): Promise<{ bytesWritten: number; buffer: T }>
  async write(
    data: NodeJS.ArrayBufferView | string,
    offsetOrOptions?: number | BufferOptions | null,
    lengthOrEncoding?: number | BufferEncoding,
    position: Position = null
  ) {
    return { bytesWritten: this.writeInput(data, offsetOrOptions, lengthOrEncoding, position), buffer: data }
  }

  readFileSync(options?: EncodingOptions) {
    this.check("read")
    encodingOf(options)
    const chunks: Array<Buffer> = []

    for (;;) {
      const buffer = Buffer.alloc(65536)
      const count = this.readSync(buffer)

      if (count === 0) break
      chunks.push(buffer.subarray(0, count))
    }

    return encoded(Buffer.concat(chunks), options)
  }
  async readFile(options?: EncodingOptions) {
    return this.readFileSync(options)
  }
  writeFileSync(data: string | Uint8Array, options?: WriteOptions): void {
    const buffer = dataOf(data, options)
    let offset = 0

    do {
      const count = this.writeSync(buffer, offset, buffer.length - offset)

      if (count === 0 && offset < buffer.length) throw new NodeError("EIO", "write", this.path)
      offset += count
    } while (offset < buffer.length)
  }
  async writeFile(data: string | Uint8Array, options?: WriteOptions) {
    this.writeFileSync(data, options)
  }
  appendFileSync(data: string | Uint8Array, options?: WriteOptions): void {
    this.writeFileSync(data, options)
  }
  async appendFile(data: string | Uint8Array, options?: WriteOptions) {
    this.appendFileSync(data, options)
  }

  statSync(options: { readonly bigint: true }): BigIntStats
  statSync(options?: { readonly bigint?: false | undefined }): Stats
  statSync(options?: StatOptions): Stats | BigIntStats
  statSync(options?: StatOptions) {
    this.check("fstat")

    return statsOf(invoke("fstat", this.path, () => this.handle.stat()), options)
  }
  stat(options: { readonly bigint: true }): Promise<BigIntStats>
  stat(options?: { readonly bigint?: false | undefined }): Promise<Stats>
  stat(options?: StatOptions): Promise<Stats | BigIntStats>
  async stat(options?: StatOptions) {
    return this.statSync(options)
  }
  truncateSync(length = 0): void {
    this.check("ftruncate", true)

    if (!this.access.writable) throw new NodeError("EBADF", "ftruncate", this.path)
    const size = BigInt(integer(length, "ftruncate"))
    invoke("ftruncate", this.path, () => this.handle.truncate(size))
  }
  async truncate(length = 0) {
    this.truncateSync(length)
  }
  chmodSync(mode: number): void {
    this.check("fchmod", true)
    integer(mode, "fchmod", 0o7777)
    invoke("fchmod", this.path, () => this.handle.chmod(mode))
  }
  async chmod(mode: number) {
    this.chmodSync(mode)
  }
  chownSync(uid: number, gid: number): void {
    this.check("fchown", true)
    invoke("fchown", this.path, () => this.handle.chown(ownerOf(uid, gid, "fchown")))
  }
  async chown(uid: number, gid: number) {
    this.chownSync(uid, gid)
  }
  utimesSync(atime: Time, mtime: Time): void {
    this.check("futimes", true)
    invoke("futimes", this.path, () => this.handle.utimes(timesOf(atime, mtime)))
  }
  async utimes(atime: Time, mtime: Time) {
    this.utimesSync(atime, mtime)
  }
  syncSync(): void {
    this.check("fsync")
    invoke("fsync", this.path, () => this.handle.sync())
  }
  async sync() {
    this.syncSync()
  }
  datasyncSync(): void {
    this.syncSync()
  }
  async datasync() {
    this.datasyncSync()
  }

  private vectors(buffers: ReadonlyArray<NodeJS.ArrayBufferView>, syscall: string): void {
    if (!Array.isArray(buffers)) throw new NodeError("EINVAL", syscall, this.path)

    for (let index = 0; index < buffers.length; index++) {
      if (!ArrayBuffer.isView(buffers[index])) {
        throw new NodeError("EINVAL", syscall, this.path)
      }
    }
  }
  readvSync(buffers: ReadonlyArray<NodeJS.ArrayBufferView>, position: Position = null): number {
    this.check("readv")
    this.vectors(buffers, "readv")
    let total = 0
    const at = this.at(position, "readv")

    for (const buffer of buffers) {
      const count = this.readSync(
        buffer,
        0,
        buffer.byteLength,
        position === null || position === undefined || position === -1 ? null : at + BigInt(total)
      )

      total += count

      if (count < buffer.byteLength) break
    }

    return total
  }
  async readv(buffers: ReadonlyArray<NodeJS.ArrayBufferView>, position: Position = null) {
    return { bytesRead: this.readvSync(buffers, position), buffers }
  }
  writevSync(buffers: ReadonlyArray<NodeJS.ArrayBufferView>, position: Position = null): number {
    this.check("writev", true)
    this.vectors(buffers, "writev")
    let total = 0
    const at = this.at(position, "writev")

    for (const buffer of buffers) {
      const count = this.writeSync(
        buffer,
        0,
        buffer.byteLength,
        position === null || position === undefined || position === -1 ? null : at + BigInt(total)
      )

      total += count

      if (count < buffer.byteLength) break
    }

    return total
  }
  async writev(buffers: ReadonlyArray<NodeJS.ArrayBufferView>, position: Position = null) {
    return { bytesWritten: this.writevSync(buffers, position), buffers }
  }

  closeSync(): void {
    this.check("close")
    invoke("close", this.path, () => this.handle.close())
  }
  async close() {
    this.closeSync()
  }
  [Symbol.dispose]() {
    if (!this.closed) this.closeSync()
  }
  async [Symbol.asyncDispose]() {
    if (!this.closed) this.closeSync()
  }

  readableWebStream(): never {
    throw new NodeError("ENOSYS", "readableWebStream", this.path)
  }
  readLines(): never {
    throw new NodeError("ENOSYS", "readLines", this.path)
  }
  createReadStream(): never {
    throw new NodeError("ENOSYS", "createReadStream", this.path)
  }
  createWriteStream(): never {
    throw new NodeError("ENOSYS", "createWriteStream", this.path)
  }
}
