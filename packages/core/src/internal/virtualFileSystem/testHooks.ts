// Package-internal synchronization hooks for deterministic volume tests.

import type * as Effect from "effect/Effect"
import type { Snapshot } from "../../Snapshot.js"
import type { Volume } from "../../VirtualFileSystem.js"

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

/** @internal */
export interface RegistrationHook {
  readonly afterSubscribe: Effect.Effect<void>
}

const registrationHooks = new WeakMap<Volume, RegistrationHook>()

/** @internal */
export const getRegistrationHook = (volume: Volume): RegistrationHook | undefined => registrationHooks.get(volume)

/** @internal */
export const setRegistrationHook = (volume: Volume, hook: RegistrationHook): () => void => {
  registrationHooks.set(volume, hook)
  return () => {
    if (registrationHooks.get(volume) === hook) registrationHooks.delete(volume)
  }
}
