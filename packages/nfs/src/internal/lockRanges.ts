/** @internal */
export const MAX_OFFSET = 0xffff_ffff_ffff_ffffn

/** @internal */
export interface LockRange {
  readonly offset: bigint
  readonly length: bigint
  /** Exclusive end; one past uint64's maximum denotes a lock through EOF. */
  readonly end: bigint
}

/** @internal */
export const lockRange = (offset: bigint, length: bigint): LockRange | undefined => {
  if (length === 0n || (length !== MAX_OFFSET && offset + length > MAX_OFFSET)) return undefined

  return { offset, length, end: length === MAX_OFFSET ? MAX_OFFSET + 1n : offset + length }
}

/** @internal */
export const overlaps = (left: LockRange, right: LockRange): boolean =>
  left.offset < right.end && right.offset < left.end

/** @internal */
export const sameRange = (left: LockRange, right: LockRange): boolean =>
  left.offset === right.offset && left.length === right.length
