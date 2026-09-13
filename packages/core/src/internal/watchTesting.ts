/** Package-internal synchronization hooks for deterministic watch tests. @internal */

import type * as Effect from "effect/Effect"
import type { Volume } from "../VirtualFileSystem.js"

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
