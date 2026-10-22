import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Atom from "effect/reactivity/Atom"
import * as AtomRpc from "effect/reactivity/AtomRpc"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import { type Command, type SourcePath, type View, WorkbenchRpc } from "../workbench/domain.ts"

export class WorkbenchClient extends AtomRpc.Service<WorkbenchClient>()("WorkbenchClient", {
  group: WorkbenchRpc,
  protocol: RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(RpcSerialization.layerNdjson)
  )
}) {}

export const workspaceAtom = Atom.make<View | null>(null).pipe(Atom.keepAlive)

export const draftsAtom = Atom.make<Partial<Record<typeof SourcePath.Type, string>>>({}).pipe(Atom.keepAlive)

export const selectedAtom = Atom.make<string>("/src/index.ts")

export const busyAtom = Atom.make<Command["action"] | null>(null)

export const errorAtom = Atom.make("")

export const roleAtom = Atom.make<Command["role"]>("compiler")

const ticketAtom = Atom.make(0).pipe(Atom.keepAlive)

const sources = ["/src/index.ts", "/src/format.ts"] as const

const perform = Effect.fnUntraced(function*(action: Command["action"]) {
  const ticket = (yield* Atom.get(ticketAtom)) + 1
  yield* Atom.set(ticketAtom, ticket)
  yield* Atom.set(busyAtom, action)
  yield* Atom.set(errorAtom, "")
  const state = yield* Atom.get(workspaceAtom)
  const drafts = yield* Atom.get(draftsAtom)
  const role = yield* Atom.get(roleAtom)

  const edits = action === "compile" || action === "compileRun" || action === "save"
    ? sources.flatMap((path) => drafts[path] === undefined ? [] : [{ path, text: drafts[path] }])
    : []

  const client = yield* WorkbenchClient

  const exit = yield* Effect.exit(
    client("command", { action, generation: state?.generation ?? 0, revision: state?.revision ?? 0, edits, role })
  )

  if (ticket !== (yield* Atom.get(ticketAtom))) return

  if (Exit.isSuccess(exit)) {
    yield* Atom.set(workspaceAtom, exit.value)

    if (action !== "view") yield* Atom.set(draftsAtom, {})
  } else yield* Atom.set(errorAtom, Cause.pretty(exit.cause))
  yield* Atom.set(busyAtom, null)
})

export const commandAtom = WorkbenchClient.runtime.fn(perform)

export const stopAtom = WorkbenchClient.runtime.fn(() => perform("stop"))
