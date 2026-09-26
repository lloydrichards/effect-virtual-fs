import * as Effect from "effect/Effect"
import * as Order from "effect/Order"

const compareBytes = (left: Uint8Array, right: Uint8Array): -1 | 0 | 1 => {
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

/** @internal */
export const sameBytes = (left: Uint8Array | undefined, right: Uint8Array | undefined): boolean =>
  left === right || (left !== undefined && right !== undefined && compareBytes(left, right) === 0)

// Copy the input to prevent a shared buffer changing during decoding.
/** @internal */
export const decodeUtf8 = <E>(bytes: Uint8Array, onInvalid: (cause: unknown) => E): Effect.Effect<string, E> =>
  Effect.try({ try: () => new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)), catch: onInvalid })
