export interface DecodeLimits {
  readonly maxOpaqueBytes: ByteSize.ByteSize
  readonly maxStringBytes: ByteSize.ByteSize
  readonly maxArrayElements: number
}

export class XdrDecodeError extends Data.TaggedError("XdrDecodeError")<{ readonly detail: string }> {
  constructor(message: string) {
    super({ detail: message })
  }

  override get message(): string {
    return this.detail
  }
}

const padding = (length: number): number => (4 - length % 4) % 4
const assertLimit = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`)
}

export class Reader {
  readonly #view: DataView
  #offset = 0

  constructor(readonly bytes: Uint8Array, readonly limits: DecodeLimits) {
    assertLimit("maxOpaqueBytes", ByteSize.toNumberUnsafe(limits.maxOpaqueBytes))
    assertLimit("maxStringBytes", ByteSize.toNumberUnsafe(limits.maxStringBytes))
    assertLimit("maxArrayElements", limits.maxArrayElements)
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  get remaining(): number {
    return this.bytes.length - this.#offset
  }

  #require(length: number): void {
    if (length > this.remaining) throw new XdrDecodeError("Truncated XDR value")
  }

  uint32(): number {
    this.#require(4)
    const value = this.#view.getUint32(this.#offset)
    this.#offset += 4
    return value
  }

  int32(): number {
    this.#require(4)
    const value = this.#view.getInt32(this.#offset)
    this.#offset += 4
    return value
  }

  uint64(): bigint {
    this.#require(8)
    const value = this.#view.getBigUint64(this.#offset)
    this.#offset += 8
    return value
  }

  boolean(): boolean {
    const value = this.uint32()
    if (value > 1) throw new XdrDecodeError(`Invalid XDR boolean: ${value}`)
    return value === 1
  }

  fixedOpaque(length: number): Uint8Array {
    assertLimit("fixed opaque length", length)
    const pad = padding(length)
    this.#require(length + pad)
    const value = this.bytes.slice(this.#offset, this.#offset + length)
    this.#offset += length
    for (let index = 0; index < pad; index++) {
      if (this.bytes[this.#offset + index] !== 0) throw new XdrDecodeError("XDR padding must be zero")
    }
    this.#offset += pad
    return value
  }

  opaque(maxBytes = this.limits.maxOpaqueBytes): Uint8Array {
    assertLimit("opaque limit", ByteSize.toNumberUnsafe(maxBytes))
    const length = this.uint32()
    if (BigInt(length) > maxBytes || BigInt(length) > this.limits.maxOpaqueBytes) {
      throw new XdrDecodeError("XDR opaque value exceeds its limit")
    }
    return this.fixedOpaque(length)
  }

  string(maxBytes = this.limits.maxStringBytes): string {
    assertLimit("string limit", ByteSize.toNumberUnsafe(maxBytes))
    const bytes = this.opaque(ByteSize.min(maxBytes, this.limits.maxStringBytes))
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      throw new XdrDecodeError("Invalid UTF-8 in XDR string")
    }
  }

  array<A>(decode: (reader: Reader) => A, maxElements = this.limits.maxArrayElements): ReadonlyArray<A> {
    assertLimit("array limit", maxElements)
    const length = this.uint32()
    if (length > maxElements || length > this.limits.maxArrayElements) {
      throw new XdrDecodeError("XDR array exceeds its element limit")
    }
    const values = Array.from<A>({ length })
    for (let index = 0; index < length; index++) values[index] = decode(this)
    return values
  }

  discriminant<const A extends Record<number, unknown>>(cases: A): A[keyof A] {
    const value = this.uint32()
    if (!Object.prototype.hasOwnProperty.call(cases, value)) {
      throw new XdrDecodeError(`Invalid XDR discriminant: ${value}`)
    }
    return cases[value] as A[keyof A]
  }

  finish(): void {
    if (this.remaining !== 0) throw new XdrDecodeError("Trailing bytes after XDR message")
  }
}

export class Writer {
  readonly #chunks: Array<Uint8Array> = []
  #length = 0

  get length(): number {
    return this.#length
  }

  #append(bytes: Uint8Array): void {
    this.#chunks.push(bytes)
    this.#length += bytes.length
  }

  uint32(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new RangeError("uint32 out of range")
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setUint32(0, value)
    this.#append(bytes)
    return this
  }

  int32(value: number): this {
    if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
      throw new RangeError("int32 out of range")
    }
    return this.uint32(value >>> 0)
  }

  uint64(value: bigint): this {
    if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new RangeError("uint64 out of range")
    return this.uint32(Number(value >> 32n)).uint32(Number(value & 0xffff_ffffn))
  }

  boolean(value: boolean): this {
    return this.uint32(value ? 1 : 0)
  }
  fixedOpaque(value: Uint8Array): this {
    this.#append(new Uint8Array(value))
    const pad = padding(value.length)
    if (pad > 0) this.#append(new Uint8Array(pad))
    return this
  }
  opaque(value: Uint8Array): this {
    return this.uint32(value.length).fixedOpaque(value)
  }
  string(value: string): this {
    return this.opaque(new TextEncoder().encode(value))
  }
  array<A>(values: ReadonlyArray<A>, encode: (writer: Writer, value: A) => void): this {
    this.uint32(values.length)
    for (const value of values) encode(this, value)
    return this
  }
  bytes(): Uint8Array {
    const bytes = new Uint8Array(this.#length)
    let offset = 0
    for (const chunk of this.#chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return bytes
  }
}
import * as ByteSize from "effect/ByteSize"
import * as Data from "effect/Data"
