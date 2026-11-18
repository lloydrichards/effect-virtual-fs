import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as RpcServer from "effect/rpc/RpcServer"
import { buildWorkspace } from "./build"
import { Mutation, type Role, WorkspaceError, WorkspaceRpc } from "./protocol"
import { deleteCheckpoint, hasSavedCheckpoint, readCheckpoint, saveCheckpoint } from "./storage"
import { openVolume, type Workspace } from "./volume"

const failure = (error: unknown) =>
  new WorkspaceError({ message: error instanceof Error ? error.message : String(error) })

const handlers = WorkspaceRpc.toLayer(Effect.sync(() => {
  let volume: Workspace | undefined

  const workspace = Effect.suspend(() =>
    volume ? Effect.succeed(volume) : Effect.fail(new WorkspaceError({ message: "Open a workspace first." }))
  )

  const caller = (role: Role) => workspace.pipe(Effect.map((value) => value[role]))

  return WorkspaceRpc.of({
    open: Effect.fnUntraced(function*({ restore }) {
      const image = restore ? (yield* readCheckpoint).image : undefined
      volume = yield* openVolume(image)
    }, Effect.mapError(failure)),
    files: ({ role }) => caller(role).pipe(Effect.flatMap((access) => access.files()), Effect.mapError(failure)),
    read: ({ role, path }) =>
      caller(role).pipe(Effect.flatMap((access) => access.read(path)), Effect.mapError(failure)),
    permissions: ({ role, path }) =>
      caller(role).pipe(Effect.flatMap((access) => access.permissions(path)), Effect.mapError(failure)),
    mutate: Effect.fnUntraced(function*(request) {
      const access = yield* caller(request.role)
      yield* Mutation.match(request, {
        mode: ({ path, mode }) => access.setFileMode(path, mode),
        write: ({ path, text }) => access.write(path, text),
        mkdir: ({ path }) => access.mkdir(path),
        rename: ({ path, to }) => access.rename(path, to),
        removeFolder: ({ path }) => access.removeFolder(path),
        unlink: ({ path }) => access.unlink(path),
        create: ({ path }) => access.create(path)
      }).pipe(Effect.asVoid)
    }, Effect.mapError(failure)),
    build: ({ role }) => caller(role).pipe(Effect.flatMap(buildWorkspace), Effect.mapError(failure)),
    saveCheckpoint: () =>
      workspace.pipe(
        Effect.flatMap((value) => value.snapshot()),
        Effect.flatMap(saveCheckpoint),
        Effect.mapError(failure)
      ),
    hasCheckpoint: () => hasSavedCheckpoint.pipe(Effect.mapError(failure)),
    inspectCheckpoint: () =>
      readCheckpoint.pipe(Effect.map(({ savedAt, size }) => ({ savedAt, size })), Effect.mapError(failure)),
    deleteCheckpoint: () => deleteCheckpoint.pipe(Effect.mapError(failure))
  })
}))

const live = RpcServer.layer(WorkspaceRpc, { concurrency: 1 }).pipe(
  Layer.provide(handlers),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(BrowserWorkerRunner.layer)
)

Effect.runFork(Layer.launch(live))
