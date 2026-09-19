import * as Internal from "./internal/model.js"

declare const systemError: (options: { readonly _tag: "BadResource" }) => unknown
declare const code: 1 | 2 | 3

interface CheckpointStoreService {
  readonly load: () => void
}

const label = code === 1 ? "one" : code === 2 ? "two" : "three"
const error = systemError({ _tag: "BadResource" })

export { type CheckpointStoreService, error, label }

/** @internal */
export const internalOperation = Effect.fn("internalOperation")(function*() {})

export const publicOperation: () => unknown = Effect.fn("publicOperation")(function*() {})

export const publicAlias: () => unknown = Internal.operation

/** @internal */
export const internalAlias = Internal.operation
