import { Effect } from "effect"
import * as Atom from "effect/reactivity/Atom"
import { buildWorkspace } from "./build"
import { type Command, initialPlayground, makeWorkspaceController } from "./controller"
import { runBundle } from "./run"
import { deleteCheckpoint, hasSavedCheckpoint, readCheckpoint, saveCheckpoint } from "./storage"
import { openVolume } from "./volume"

export type { Entry, Operation } from "./controller"

const controller = makeWorkspaceController({
  openVolume,
  buildWorkspace,
  runBundle,
  deleteCheckpoint,
  readCheckpoint,
  saveCheckpoint
})

export const playgroundAtom = Atom.make(initialPlayground)

export const checkpointAtom = Atom.make(hasSavedCheckpoint).pipe(Atom.withServerValueInitial)

export const editAtom = Atom.fnSync((source: string, ctx) => {
  const state = ctx(playgroundAtom)
  const next = controller.edit(state, source)

  if (next !== state) ctx.set(playgroundAtom, next)
})

export const commandAtom = Atom.fn<Command>()((command, ctx) =>
  Effect.gen(function*() {
    const success = yield* controller.execute(command, () =>
      ctx(playgroundAtom), (state) =>
      ctx.set(playgroundAtom, state))

    if (success && (command === "save" || command === "deleteCheckpoint")) {
      ctx.refresh(checkpointAtom)
    }

    return success
  }), { concurrent: true })
