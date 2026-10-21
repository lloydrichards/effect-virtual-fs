import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import { type EngineOptions, makeEngine, State } from "../../../core/dist/internal/engine.js"
import { bindOperations } from "../../src/internal/fileSystemAdapter.js"

// Match the community /tmp fixture's initial value without importing its decoder or constructor.
const initialState = () => {
  const state = State.emptyState(0n)
  const root = State.getNode(state, State.ROOT_INO)!

  const temporary: State.Directory = {
    kind: "directory",
    ino: State.Ino(2),
    parent: State.ROOT_INO,
    name: "746d70",
    entries: new Map(),
    metadata: State.directoryMetadata(2n, 0, 0, 0o755, 0n),
    revision: 1n
  }

  const inodes = State.setNode(state.inodes, temporary)

  return {
    ...state,
    inodes: State.setNode(inodes, {
      ...root,
      kind: "directory",
      parent: State.ROOT_INO,
      name: "",
      entries: new Map([["746d70", State.Ino(2)]]),
      metadata: { ...root.metadata, nlink: 3 }
    }),
    nextInode: State.Ino(3),
    entries: 1
  }
}

// This entry is test-only: no core private subpath is added to either package's public exports.
export const make = Effect.fnUntraced(function*(options?: EngineOptions) {
  const engine = yield* makeEngine({ ...options, initialState: initialState() })
  const context = yield* engine.context({ umask: 0 })

  return yield* bindOperations(context.operations)
})

export const layer = Layer.effect(FileSystem.FileSystem, make())
