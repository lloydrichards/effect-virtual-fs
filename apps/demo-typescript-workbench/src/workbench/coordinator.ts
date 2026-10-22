// Native worker creation is the Node boundary. Scope, RPC and command lifetimes are owned by Effect.
/* eslint-disable effecttsgo/node-builtin-import */
import * as NodeWorker from "@effect/platform-node/NodeWorker"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as RpcClient from "effect/rpc/RpcClient"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import { Worker } from "node:worker_threads"
import { type Command, type InternalCommand, type View, WorkbenchError, WorkerRpc } from "./domain.ts"

export const makeCoordinator = Effect.fnUntraced(function*(runTimeout = 3000) {
  const owner = yield* Scope.make()
  const commands = yield* Scope.make()
  let closing = false
  const gate = yield* Semaphore.make(1)
  const replacements = yield* Semaphore.make(1)
  let generation = 0
  let saved: Uint8Array | undefined
  let saves = 0
  let state: View
  let handle: Effect.Success<typeof spawn> | undefined

  yield* Effect.addFinalizer(() =>
    Effect.gen(function*() {
      closing = true
      yield* (handle?.close ?? Effect.void).pipe(
        Effect.ensuring(Scope.close(commands, Exit.void)),
        Effect.ensuring(Scope.close(owner, Exit.void))
      )
    })
  )

  const spawn = Effect.gen(function*() {
    const scope = yield* Scope.fork(owner)
    let native: Worker | undefined

    const protocol = RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 }).pipe(
      Layer.provide(NodeWorker.layer(() => {
        native = new Worker(new URL("./worker.ts", import.meta.url), { stdout: true, stderr: true })
        // Program console is captured inside the worker; drain direct native writes separately from RPC messages.
        native.stdout?.on("data", () => {})
        native.stderr?.on("data", () => {})

        return native
      }))
    )

    return yield* Effect.gen(function*() {
      const services = yield* Layer.buildWithScope(protocol, scope)

      const rpc = yield* RpcClient.make(WorkerRpc).pipe(
        Effect.provideContext(services),
        Effect.provideService(Scope.Scope, scope)
      )

      // Terminate before protocol teardown: synchronous user code cannot acknowledge graceful shutdown.
      yield* Scope.addFinalizer(scope, Effect.promise(() => native!.terminate()))

      return { rpc, close: Scope.close(scope, Exit.void) }
    }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)))
  })

  handle = yield* spawn

  const boot = (snapshot?: Uint8Array) => {
    const input: InternalCommand = { action: "boot", generation, revision: 0, edits: [], role: "compiler" }

    return handle!.rpc.execute(snapshot ? { ...input, snapshot } : input)
  }

  const initial = yield* boot()
  state = initial.view
  saved = initial.snapshot

  const replace = (reset: boolean, notice: string, expected: number) =>
    replacements.withPermit(Effect.gen(function*() {
      if (closing || generation !== expected) {
        return yield* new WorkbenchError({ message: "This workspace was already replaced." })
      }

      generation++
      yield* handle!.close
      handle = yield* spawn
      const restored = yield* boot(reset ? undefined : saved)
      state = { ...restored.view, checkpoint: reset ? 0 : saves, notice }

      if (reset) {
        saved = restored.snapshot
        saves = 0
      }

      return state
    }))

  const command = Effect.fnUntraced(function*(input: Command) {
    if (closing) return yield* new WorkbenchError({ message: "The workbench is closed." })
    const requested = input.action

    if (requested === "stop") {
      return yield* replace(false, "Execution stopped. Save point restored; compile before running.", input.generation)
    }

    return yield* gate.withPermit(Effect.gen(function*() {
      if (requested === "view") return yield* replacements.withPermit(Effect.sync(() => state))

      if (
        input.generation !== generation || input.generation !== state.generation || input.revision !== state.revision
      ) {
        return yield* new WorkbenchError({
          message: "The workspace changed. Reopen the latest revision before applying this action."
        })
      }

      if (requested === "restore" || requested === "reset") {
        return yield* replace(
          requested === "reset",
          requested === "reset" ? "Starting fixture restored." : "Save point restored. Compile before running.",
          input.generation
        )
      }

      if (
        requested === "run" &&
        (input.edits.length > 0 || state.build?.status !== "success" || state.build.revision !== state.revision)
      ) return yield* new WorkbenchError({ message: "Compile your current source before running." })
      const active = handle!
      const expectedGeneration = generation

      const performRun = Effect.gen(function*() {
        const result = yield* Effect.exit(
          active.rpc.execute({
            action: "run",
            generation: state.generation,
            revision: state.revision,
            edits: [],
            role: "compiler"
          }).pipe(Effect.timeout(runTimeout))
        )

        if (closing || generation !== expectedGeneration) {
          return yield* new WorkbenchError({ message: "Execution was stopped and the workspace was replaced." })
        }

        if (Exit.isFailure(result)) {
          return yield* replace(
            false,
            `Run stopped; save point restored. ${Cause.pretty(result.cause)}`,
            expectedGeneration
          )
        }

        state = { ...result.value.view, checkpoint: saves }

        return state
      })

      if (requested === "run") return yield* performRun

      const reply = yield* active.rpc.execute({
        ...input,
        action: requested === "compileRun" ? "compile" : requested
      })

      if (closing || generation !== expectedGeneration) {
        return yield* new WorkbenchError({ message: "Workspace replaced while the command was running." })
      }

      state = { ...reply.view, checkpoint: saves }

      if (reply.snapshot) {
        saved = reply.snapshot
        saves++
        state = { ...state, checkpoint: saves }
        generation = state.generation
      }

      if (requested === "compileRun" && state.build?.status === "success") return yield* performRun

      return state
    }))
  })

  const submit = Effect.fn("Workbench.command")(function*(input: Command) {
    if (closing) return yield* new WorkbenchError({ message: "The workbench is closed." })

    // The caller owns only its wait. Accepted commands retain the workbench lifetime.
    const pending = yield* command(input).pipe(
      Effect.mapError((cause) =>
        Schema.is(WorkbenchError)(cause) ? cause : new WorkbenchError({ message: String(cause) })
      ),
      Effect.forkIn(commands)
    )

    return yield* Fiber.join(pending)
  })

  return { command: submit }
})

export class Workbench
  extends Context.Service<Workbench, Effect.Success<ReturnType<typeof makeCoordinator>>>()("Workbench")
{
  static layer = Layer.effect(Workbench, makeCoordinator())
}
