// Opaque byte path representation and value protocols.
import * as Equal from "effect/Equal"
import * as Hash from "effect/Hash"
import { pipeArguments } from "effect/Pipeable"
import * as Predicate from "effect/Predicate"
import type { BytePath } from "../BytePath.js"
import { sameBytes } from "./bytes.js"

/** @internal */
export const BytePathId = "@effect-vfs/core/BytePath" as const

const bytePaths = new WeakMap<object, Uint8Array>()

const hashBytes = (bytes: Uint8Array): number => {
  let hash = Hash.string("@effect-vfs/core/BytePath")

  for (const byte of bytes) {
    hash = Hash.combine(Hash.number(byte))(hash)
  }

  return Hash.combine(Hash.number(bytes.length))(hash)
}

const BytePathProto: BytePath = {
  [BytePathId]: BytePathId,
  [Equal.symbol](this: BytePath, that): boolean {
    if (!isBytePath(that)) return false

    return sameBytes(bytePaths.get(this), bytePaths.get(that))
  },
  [Hash.symbol](this: BytePath): number {
    return hashBytes(bytePaths.get(this)!)
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
}

/** @internal */
export const isBytePath = (value: unknown): value is BytePath => Predicate.isObject(value) && bytePaths.has(value)

/** @internal */
export const make = (bytes: Uint8Array): BytePath => {
  // SAFETY: BytePathProto implements every member of the opaque BytePath contract.
  const path = Object.create(BytePathProto) as BytePath
  bytePaths.set(path, bytes)

  return Object.freeze(path)
}

/** @internal */
export const getBytes = (path: BytePath): Uint8Array | undefined => bytePaths.get(path)
