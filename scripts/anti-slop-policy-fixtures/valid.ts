declare const systemError: (options: { readonly _tag: "BadResource" }) => unknown
declare const code: 1 | 2 | 3

interface CheckpointStoreService {
  readonly load: () => void
}

const label = code === 1 ? "one" : code === 2 ? "two" : "three"
const error = systemError({ _tag: "BadResource" })

export { type CheckpointStoreService, error, label }
