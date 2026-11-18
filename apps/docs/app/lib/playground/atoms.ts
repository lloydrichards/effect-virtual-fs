import * as BrowserWorker from "@effect/platform-browser/BrowserWorker"
import { Effect, Layer } from "effect"
import * as Atom from "effect/reactivity/Atom"
import * as AtomRegistry from "effect/reactivity/AtomRegistry"
import * as AtomRpc from "effect/reactivity/AtomRpc"
import * as RpcClient from "effect/rpc/RpcClient"
import * as WorkerPlatform from "effect/workers/Worker"
import { type Command, editPlayground, initialPlayground, makeWorkspaceController } from "./controller"
import { Mutation, type Role, WorkspaceRpc } from "./protocol"
import { runBundle } from "./run"

export type { Entry, Operation } from "./controller"

const workerLayer = Layer.effect(
  WorkerPlatform.Spawner,
  Effect.acquireRelease(
    Effect.sync(() =>
      new Worker(new URL("./workspace.worker.ts", import.meta.url), { type: "module", name: "Browser filesystem" })
    ),
    (worker) => Effect.sync(() => worker.terminate())
  ).pipe(Effect.map((worker) => () => worker))
)

class WorkspaceClient extends AtomRpc.Service<WorkspaceClient>()("DocsWorkspaceClient", {
  group: WorkspaceRpc,
  protocol: RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 }).pipe(
    Layer.provide(Layer.merge(BrowserWorker.layerPlatform, workerLayer))
  )
}) {}

const makeController = Effect.gen(function*() {
  const client = yield* WorkspaceClient

  const bind = (role: Role) => ({
    files: () => client("files", { role }),
    read: (path: string) => client("read", { role, path }),
    permissions: (path: string) => client("permissions", { role, path }),
    setFileMode: (path: string, mode: 0o600 | 0o644) =>
      client("mutate", Mutation.cases.mode.make({ role, path, mode })),
    write: (path: string, text: string) => client("mutate", Mutation.cases.write.make({ role, path, text })),
    rename: (path: string, to: string) => client("mutate", Mutation.cases.rename.make({ role, path, to })),
    mkdir: (path: string) => client("mutate", Mutation.cases.mkdir.make({ role, path })),
    removeFolder: (path: string) => client("mutate", Mutation.cases.removeFolder.make({ role, path })),
    unlink: (path: string) => client("mutate", Mutation.cases.unlink.make({ role, path })),
    create: (path: string) => client("mutate", Mutation.cases.create.make({ role, path }))
  })

  return makeWorkspaceController({
    openVolume: (restore) =>
      client("open", { restore }).pipe(
        Effect.as({ admin: bind("admin"), editor: bind("editor"), reader: bind("reader") })
      ),
    buildWorkspace: (_, role) => client("build", { role }),
    runBundle,
    saveCheckpoint: client("saveCheckpoint", undefined),
    inspectCheckpoint: client("inspectCheckpoint", undefined),
    deleteCheckpoint: client("deleteCheckpoint", undefined)
  })
})

export const playgroundAtom = Atom.make(initialPlayground)

export const checkpointAtom = WorkspaceClient.query("hasCheckpoint", undefined).pipe(Atom.withServerValueInitial)

export const editAtom = Atom.fnSync((source: string, ctx) => {
  const state = ctx(playgroundAtom)

  const next = editPlayground(state, source)

  if (next !== state) ctx.set(playgroundAtom, next)
})

export const commandAtom = WorkspaceClient.runtime.fn((command: Command) =>
  Effect.gen(function*() {
    const registry = yield* AtomRegistry.AtomRegistry
    const controller = yield* makeController

    const success = yield* controller.execute(
      command,
      () => registry.get(playgroundAtom),
      (state) => registry.set(playgroundAtom, state)
    )

    if (success && (command === "save" || command === "deleteCheckpoint")) {
      registry.refresh(checkpointAtom)
    }

    return success
  }), { concurrent: true })
