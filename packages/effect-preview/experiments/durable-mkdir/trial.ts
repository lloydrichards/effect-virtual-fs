import { Context, Data, Effect, Exit, Result } from "effect"
import * as BytePath from "../../src/compat/BytePath.js"
import * as Atomic from "../../src/virtual-file-system/internal/atomic.js"
import * as Engine from "../../src/virtual-file-system/internal/engine.js"
import * as Model from "../../src/virtual-file-system/internal/model.js"
import * as Runtime from "../../src/virtual-file-system/internal/runtime.js"
import * as Vfs from "../../src/virtual-file-system/VirtualFileSystem.js"

class StorageRejected extends Data.TaggedError("StorageRejected") {}

class VolumeUnavailable extends Data.TaggedError("VolumeUnavailable") {}

type OfferError = StorageRejected | VolumeUnavailable

interface Marker {
  readonly runtime: Runtime.Runtime
  active: boolean
}

const ActiveOffers = Context.Reference<ReadonlyArray<Marker>>("durable-mkdir/active-offers", { defaultValue: () => [] })

// The store receives a directory delta. Object numbers and revisions are persistent data.
// References, binding tokens, mutable directory drafts and publication closures stay in the turn.
const directoryRecord = (engine: Engine.Engine, node: Engine.DirectoryNode) =>
  Object.freeze({
    ...engine.metadata(node),
    revision: node.revision,
    namespaceRevision: node.namespace
  })

export interface Candidate {
  readonly name: Uint8Array
  readonly parent: ReturnType<typeof directoryRecord>
  readonly child: ReturnType<typeof directoryRecord>
  readonly nextObject: bigint
}

interface Created {
  readonly candidate: Candidate
  readonly created: Model.DirectoryObservation
}

type Offer = (candidate: Candidate) => Effect.Effect<"committed" | "rejected" | "unknown">

export const makeMkdirTrial = Effect.fnUntraced(function*(offer: Offer) {
  // eslint-disable-next-line effecttsgo/experimental-api-usage -- Exercise the pinned preview constructor.
  const owner = yield* Vfs.make()
  const authorized = yield* owner.authorize({ credentials: { uid: 0, gid: 0, privileged: true } })

  return makeCallerTrial(authorized, offer)
})

const makeCallerTrial = (authorized: Model.VirtualFileSystem, offer: Offer) => {
  const caller = Engine.callers.get(authorized)

  if (caller === undefined) throw new Error("Missing authorized preview caller")
  const { resource, runtime } = caller
  const engine = Engine.resolveEngine(caller)

  let unavailable = false
  const queuedUnavailable = Runtime.closed("durableMkdir")

  const decide = Effect.fnUntraced(function*({ candidate }: Created) {
    const active = yield* ActiveOffers
    const marker = { runtime, active: true }

    const result = yield* Effect.exit(
      Effect.suspend(() => offer(candidate)).pipe(
        Effect.provideService(ActiveOffers, [...active, marker]),
        Effect.ensuring(Effect.sync(() => {
          marker.active = false
        }))
      )
    )

    if (Exit.isSuccess(result)) {
      if (result.value === "committed") return

      if (result.value === "rejected") return yield* new StorageRejected()
    }

    unavailable = true

    return yield* new VolumeUnavailable()
  })

  const turn = Effect.fnUntraced(function*<A>(
    operation: string,
    path: Model.Path,
    prepare: (
      tx: Engine.Transaction,
      selected: Model.Path
    ) => Result.Result<Runtime.ResultTransition<A>, Model.OperationError>,
    beforePublish?: (value: A) => Effect.Effect<void, OfferError>
  ) {
    if (unavailable) return yield* new VolumeUnavailable()
    const offers = yield* ActiveOffers

    if (offers.some((offer) => offer.runtime === runtime && offer.active)) {
      return yield* new Model.ReentrantOperation({ operation, reason: "sameInstance" })
    }

    return yield* runtime.runResult(
      resource,
      operation,
      () =>
        Result.gen(function*() {
          const bytes = yield* Engine.addressBytesResult(path, operation, runtime.limits)

          return {
            bytes,
            snapshot: (work) =>
              Result.map(
                Engine.pathValueResult(path, operation),
                (selected) => ({
                  execute: () =>
                    unavailable
                      ? Result.fail(queuedUnavailable)
                      : prepare(new Engine.Transaction(caller, work), selected)
                })
              )
          }
        }),
      undefined,
      beforePublish
    ).pipe(
      Effect.mapError((error) => error === queuedUnavailable ? new VolumeUnavailable() : error)
    )
  })

  return Object.freeze({
    mkdir: (path: Model.Path, options?: Model.MkdirOptions) =>
      turn<Created>("makeDirectory", path, (tx, path) =>
        Result.gen(function*() {
          const created = yield* Atomic.makeDirectory(tx, path, options)
          // Finalize timestamps, revisions and quotas before constructing the store's candidate.
          const transition = yield* tx.transitionResult(created)
          const child = tx.changes.get(created.metadata.objectNumber)

          if (child?.kind !== "directory" || child.parent === undefined) throw new Error("Missing staged mkdir child")
          const parent = tx.changes.get(child.parent)

          if (parent?.kind !== "directory") throw new Error("Missing staged mkdir parent")
          const binding = yield* tx.findBindingResult(parent, child.id)

          if (binding === undefined) throw new Error("Missing staged mkdir binding")

          const candidate = Object.freeze({
            name: BytePath.toBytes(binding.name),
            parent: directoryRecord(engine, parent),
            child: directoryRecord(engine, child),
            nextObject: tx.nextObject
          })

          return { ...transition, value: { created: transition.value, candidate } }
        }), decide).pipe(Effect.map(({ created }) => created)),
    stat: (path: Model.Path) =>
      turn<Model.ObjectObservation>(
        "stat",
        path,
        (tx, path) => Result.map(Atomic.stat(tx, path), (value) => ({ value }))
      ),
    onCommit: Effect.fnUntraced(function*(listener: (batch: ReadonlyArray<Model.CommittedMutation>) => void) {
      const sink = (batch: ReadonlyArray<Model.CommittedMutation>) => listener(batch)
      let open = true
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          open = false
          engine.listeners.delete(sink)
        })
      )
      yield* turn("onCommit", "/", () =>
        Result.succeed({
          value: undefined,
          publish: () => {
            if (!open) return Result.fail(Runtime.closed("onCommit"))
            engine.listeners.add(sink)

            return Result.succeed(undefined)
          }
        }))
    })
  })
}
