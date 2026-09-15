// Opaque snapshot-delta representation and authenticity checks.
import * as Predicate from "effect/Predicate"
import type { SnapshotDelta } from "../SnapshotDelta.js"

/** @internal */
export const SnapshotDeltaTypeId = "@effect-vfs/core/SnapshotDelta" as const

const snapshotDeltas = new WeakMap<object, WeakKey>()

/** @internal */
export const make = (value: WeakKey): SnapshotDelta => {
  const delta = Object.freeze<SnapshotDelta>({ [SnapshotDeltaTypeId]: SnapshotDeltaTypeId })
  snapshotDeltas.set(delta, value)

  return delta
}

/** @internal */
export const value = (delta: SnapshotDelta): WeakKey | undefined => snapshotDeltas.get(delta)

/** @internal */
export const isSnapshotDelta = (input: unknown): input is SnapshotDelta =>
  Predicate.isObject(input) && snapshotDeltas.has(input)
