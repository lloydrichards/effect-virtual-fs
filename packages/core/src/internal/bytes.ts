// Byte-array comparison shared by the overlay diff, the snapshot delta, and BytePath equality.
import * as Order from "effect/Order"

/** @internal */
export const compareBytes = (left: Uint8Array, right: Uint8Array): -1 | 0 | 1 => {
  const length = Math.min(left.length, right.length)

  for (let index = 0; index < length; index++) {
    const l = left[index]!
    const r = right[index]!

    if (l !== r) return l < r ? -1 : 1
  }

  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1
}

/** @internal */
export const bytesOrder: Order.Order<Uint8Array> = Order.make(compareBytes)

// A plain loop: Equal.equals would hash both arrays and memoise the pair in a WeakMap first.
/** @internal */
export const sameBytes = (left: Uint8Array | undefined, right: Uint8Array | undefined): boolean =>
  left === right || (left !== undefined && right !== undefined && compareBytes(left, right) === 0)
