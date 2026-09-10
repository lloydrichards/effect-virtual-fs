/** Package-internal synchronization hooks for deterministic overlay tests. @internal */

import type * as Effect from "effect/Effect"
import type { Snapshot } from "../Snapshot.js"

/** @internal */
export interface ObservationHook {
  readonly betweenSnapshotAndSummary: Effect.Effect<void>
}

const observationHooks = new WeakMap<Snapshot, ObservationHook>()

/** @internal */
export const getObservationHook = (snapshot: Snapshot): ObservationHook | undefined => observationHooks.get(snapshot)

/** @internal */
export const setObservationHook = (snapshot: Snapshot, hook: ObservationHook): () => void => {
  observationHooks.set(snapshot, hook)
  return () => {
    if (observationHooks.get(snapshot) === hook) observationHooks.delete(snapshot)
  }
}
