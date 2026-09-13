/** Opaque byte path representation and value protocols. @internal */
import * as Equal from "effect/Equal"
import * as Hash from "effect/Hash"
import { pipeArguments } from "effect/Pipeable"
import type { BytePath } from "../BytePath.js"

/** @internal */
export const BytePathId = "@effect-vfs/core/BytePath" as const

const bytePaths = new WeakMap<BytePath, Uint8Array>()

const hashBytes = (bytes: Uint8Array): number => {
  let hash = Hash.string("@effect-vfs/core/BytePath")
  for (const byte of bytes) {
    hash = Hash.combine(Hash.number(byte))(hash)
  }
  return Hash.combine(Hash.number(bytes.length))(hash)
}

const BytePathProto: BytePath = {
  [BytePathId]: BytePathId,
  [Equal.symbol](this: BytePath, that: unknown): boolean {
    if (!isBytePath(that)) return false
    const selfBytes = bytePaths.get(this)!
    const thatBytes = bytePaths.get(that)!
    if (selfBytes.length !== thatBytes.length) return false
    for (let index = 0; index < selfBytes.length; index++) {
      if (selfBytes[index] !== thatBytes[index]) return false
    }
    return true
  },
  [Hash.symbol](this: BytePath): number {
    return hashBytes(bytePaths.get(this)!)
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
}

export const isBytePath = (value: unknown): value is BytePath =>
  typeof value === "object" && value !== null && bytePaths.has(value as BytePath)

export const make = (bytes: Uint8Array): BytePath => {
  const path = Object.create(BytePathProto) as BytePath
  bytePaths.set(path, bytes)
  return Object.freeze(path)
}

export const getBytes = (path: BytePath): Uint8Array | undefined => bytePaths.get(path)
