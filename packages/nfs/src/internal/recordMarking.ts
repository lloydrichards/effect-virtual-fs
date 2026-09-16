/** @internal */
export interface RecordLimits {
  readonly maxFragmentBytes: ByteSize.ByteSize
  readonly maxRecordBytes: ByteSize.ByteSize
  readonly maxFragmentsPerRecord: number
}

/** @internal */
export class RecordMarkingError extends Data.TaggedError("RecordMarkingError")<{ readonly detail: string }> {
  constructor(message: string) {
    super({ detail: message })
  }

  override get message(): string {
    return this.detail
  }
}

const validate = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`)
}

const join = (chunks: ReadonlyArray<Uint8Array>, size: number): Uint8Array => {
  const result = new Uint8Array(size)
  let offset = 0

  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }

  return result
}

/** @internal */
export class RecordDecoder {
  readonly #limits: RecordLimits
  #header = new Uint8Array(4)
  #headerLength = 0
  #fragmentLength = -1
  #fragmentLast = false
  #fragmentChunks: Array<Uint8Array> = []
  #fragmentBytes = 0
  #recordFragments: Array<Uint8Array> = []
  #recordBytes = 0
  #recordFragmentCount = 0

  constructor(limits: RecordLimits) {
    validate("maxFragmentBytes", ByteSize.toNumberUnsafe(limits.maxFragmentBytes))
    validate("maxRecordBytes", ByteSize.toNumberUnsafe(limits.maxRecordBytes))
    validate("maxFragmentsPerRecord", limits.maxFragmentsPerRecord)
    this.#limits = limits
  }

  get bufferedByteLength(): number {
    return this.#headerLength + this.#fragmentBytes + this.#recordBytes
  }
  reset(): void {
    this.#headerLength = 0
    this.#fragmentLength = -1
    this.#fragmentLast = false
    this.#fragmentChunks = []
    this.#fragmentBytes = 0
    this.#recordFragments = []
    this.#recordBytes = 0
    this.#recordFragmentCount = 0
  }

  push(input: Uint8Array): ReadonlyArray<Uint8Array> {
    const records: Array<Uint8Array> = []
    let offset = 0

    try {
      while (offset < input.length) {
        if (this.#fragmentLength < 0) {
          const count = Math.min(4 - this.#headerLength, input.length - offset)
          this.#header.set(input.subarray(offset, offset + count), this.#headerLength)
          this.#headerLength += count
          offset += count

          if (this.#headerLength < 4) continue
          const marker = new DataView(this.#header.buffer).getUint32(0)
          this.#fragmentLast = (marker & 0x8000_0000) !== 0
          this.#fragmentLength = marker & 0x7fff_ffff
          this.#headerLength = 0

          if (BigInt(this.#fragmentLength) > this.#limits.maxFragmentBytes) {
            throw new RecordMarkingError("RPC fragment exceeds its byte limit")
          }

          if (BigInt(this.#recordBytes + this.#fragmentLength) > this.#limits.maxRecordBytes) {
            throw new RecordMarkingError("RPC record exceeds its byte limit")
          }

          if (this.#recordFragmentCount >= this.#limits.maxFragmentsPerRecord) {
            throw new RecordMarkingError("RPC record exceeds its fragment limit")
          }

          if (this.#fragmentLength === 0) this.#finishFragment(records)
        }

        if (this.#fragmentLength < 0) continue
        const count = Math.min(this.#fragmentLength - this.#fragmentBytes, input.length - offset)

        if (count > 0) {
          this.#fragmentChunks.push(input.slice(offset, offset + count))
          this.#fragmentBytes += count
          offset += count
        }

        if (this.#fragmentBytes === this.#fragmentLength) this.#finishFragment(records)
      }

      return records
    } catch (error) {
      this.reset()
      throw error
    }
  }

  #finishFragment(records: Array<Uint8Array>): void {
    const fragment = join(this.#fragmentChunks, this.#fragmentBytes)
    this.#recordFragments.push(fragment)
    this.#recordFragmentCount += 1
    this.#recordBytes += fragment.length
    const last = this.#fragmentLast
    this.#fragmentLength = -1
    this.#fragmentChunks = []
    this.#fragmentBytes = 0

    if (last) {
      records.push(join(this.#recordFragments, this.#recordBytes))
      this.#recordFragments = []
      this.#recordBytes = 0
      this.#recordFragmentCount = 0
    }
  }
}

/** @internal */
export const encodeRecord = (record: Uint8Array): Uint8Array => {
  if (record.length > 0x7fff_ffff) throw new RangeError("RPC record is too large for one fragment")
  const result = new Uint8Array(record.length + 4)
  new DataView(result.buffer).setUint32(0, 0x8000_0000 | record.length)
  result.set(record, 4)

  return result
}

import * as ByteSize from "effect/ByteSize"
import * as Data from "effect/Data"
