/** Core-owned identity shared by volume construction and native adapters. @internal */
import type * as Effect from "effect/Effect"
import type { Volume } from "../VirtualFileSystem.js"
import type { makeEngine } from "./engine.js"

type Engine = Effect.Success<ReturnType<typeof makeEngine>>

const engines = new WeakMap<Volume, Engine>()

/** @internal */
export const register = (volume: Volume, engine: Engine): void => {
  engines.set(volume, engine)
}

/** @internal */
export const engineOf = (volume: Volume): Engine | undefined => engines.get(volume)

/** @internal */
export const alias = (volume: Volume, original: Volume): void => {
  const engine = engines.get(original)

  if (engine !== undefined) engines.set(volume, engine)
}
