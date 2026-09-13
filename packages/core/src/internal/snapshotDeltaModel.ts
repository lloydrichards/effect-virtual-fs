// Opaque snapshot-delta representation and authenticity checks.
import type { SnapshotDelta } from "../SnapshotDelta.js"

/** @internal */
export const SnapshotDeltaTypeId = "@effect-vfs/core/SnapshotDelta" as const

const snapshotDeltas = new WeakMap<SnapshotDelta, object>()

/** @internal */
export const make = (value: object): SnapshotDelta => {
  const delta = Object.freeze<SnapshotDelta>({ [SnapshotDeltaTypeId]: SnapshotDeltaTypeId })
  snapshotDeltas.set(delta, value)
  return delta
}

/** @internal */
export const value = (delta: SnapshotDelta): object | undefined => snapshotDeltas.get(delta)

/** @internal */
export const isSnapshotDelta = (input: unknown): input is SnapshotDelta =>
  typeof input === "object" && input !== null && snapshotDeltas.has(input as SnapshotDelta)
