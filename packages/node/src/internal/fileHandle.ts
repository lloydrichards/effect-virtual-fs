// Node requires promises at this native boundary. The memory operations finish before each promise settles.
/* eslint-disable effecttsgo/async-function, effecttsgo/node-builtin-import */
import type { Handle } from "@effect-vfs/core/SynchronousAdapter"
import * as Predicate from "effect/Predicate"
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
  private range(buffer: Uint8Array, offset: number, length: number, syscall: string): void {
    if (!(buffer instanceof Uint8Array)) throw new NodeError("EINVAL", syscall, this.path)
    integer(offset, syscall, buffer.length)
    integer(length, syscall, buffer.length - offset)
  }

  readSync(buffer: Uint8Array, offset = 0, length = buffer.length - offset, position: Position = null): number {
    this.check("read")

    if (!this.access.readable) throw new NodeError("EBADF", "read", this.path)
    this.range(buffer, offset, length, "read")
    const at = this.at(position, "read")
    const bytes = invoke("read", this.path, () => this.handle.read(length, at))
    buffer.set(bytes, offset)

    if (position === null || position === undefined || position === -1) this.#position = Number(at) + bytes.length

    return bytes.length
  }
  async read(
    buffer: Uint8Array = Buffer.alloc(16384),
    offset = 0,
    length = buffer.length - offset,
    position: Position = null
  ) {
    return { bytesRead: this.readSync(buffer, offset, length, position), buffer }
  }

  writeSync(buffer: Uint8Array, offset = 0, length?: number, position: Position = null): number {
    this.check("write", true)

    if (!this.access.writable) throw new NodeError("EBADF", "write", this.path)
    const size = length ?? buffer.length - offset
    this.range(buffer, offset, size, "write")
    const at = this.at(position, "write")

    const count = invoke(
      "write",
      this.path,
      () => this.handle.write(buffer.subarray(offset, offset + size), at, this.access.append)
    )

    if (position === null || position === undefined || position === -1) {
      this.#position = this.access.append
        ? Number(invoke("fstat", this.path, () => this.handle.stat()).size)
        : Number(at) + count
    }

    return count
  }
  async write(buffer: Uint8Array, offset = 0, length?: number, position: Position = null) {
    return { bytesWritten: this.writeSync(buffer, offset, length, position), buffer }
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

  private vectors(buffers: ReadonlyArray<Uint8Array>, syscall: string): void {
    if (!Array.isArray(buffers) || buffers.some((buffer) => !(buffer instanceof Uint8Array))) {
      throw new NodeError("EINVAL", syscall, this.path)
    }
  }
  readvSync(buffers: ReadonlyArray<Uint8Array>, position: Position = null): number {
    this.check("readv")
    this.vectors(buffers, "readv")
    let total = 0
    const at = this.at(position, "readv")

    for (const buffer of buffers) {
      const count = this.readSync(
        buffer,
        0,
        buffer.length,
        position === null || position === undefined || position === -1 ? null : at + BigInt(total)
      )

      total += count

      if (count < buffer.length) break
    }

    return total
  }
  async readv(buffers: ReadonlyArray<Uint8Array>, position: Position = null) {
    return { bytesRead: this.readvSync(buffers, position), buffers }
  }
  writevSync(buffers: ReadonlyArray<Uint8Array>, position: Position = null): number {
    this.check("writev", true)
    this.vectors(buffers, "writev")
    let total = 0
    const at = this.at(position, "writev")

    for (const buffer of buffers) {
      const count = this.writeSync(
        buffer,
        0,
        buffer.length,
        position === null || position === undefined || position === -1 ? null : at + BigInt(total)
      )

      total += count

      if (count < buffer.length) break
    }

    return total
  }
  async writev(buffers: ReadonlyArray<Uint8Array>, position: Position = null) {
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
