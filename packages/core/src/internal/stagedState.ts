import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Semaphore from "effect/Semaphore"
import { FsError } from "./errors.js"

/** @internal */
export type CommitOutcome = "committed" | "rejected" | "unknown"

/** @internal */
export interface CommitProvider<State> {
  /** Provides a gate-coordinated shutdown effect once staging is ready. */
  readonly onReady?: (shutdown: Effect.Effect<void>) => void
  /** Checks and encodes a candidate before the commit boundary. Failure leaves the volume available. */
  readonly prepare?: (candidate: State) => Effect.Effect<void, FsError>
  /** Classifies a candidate as committed, definitely rejected, or uncertain. */
  readonly commit: (candidate: State) => Effect.Effect<CommitOutcome>
}

/** @internal */
export const makeStagedState = <State, Event = never>(
  initial: State,
  // The copy must detach every mutable value that change can reach.
  copy: (current: State) => Effect.Effect<State>,
  rawProvider: CommitProvider<State>,
  publish?: (candidate: State, events: ReadonlyArray<Event>) => void
) => {
  const gate = Semaphore.makeUnsafe(1)

  const provider = {
    ...rawProvider,
    commit: (candidate: State) => Effect.suspend(() => rawProvider.commit(candidate))
  }

  let current = initial
  let available = true

  const checkAvailable = (operation: string) =>
    Effect.suspend(() =>
      available
        ? Effect.void
        : Effect.fail(new FsError({ code: "VolumeUnavailable", operation }))
    )

  const coordinate = <A, E, R>(effect: Effect.Effect<A, E, R>) => gate.withPermit(effect)

  const shutdown = coordinate(Effect.sync(() => {
    available = false
  }))

  const read = <A, E, R>(operation: string, inspect: (state: Readonly<State>) => Effect.Effect<A, E, R>) =>
    coordinate(Effect.gen(function*() {
      yield* checkAvailable(operation)

      return yield* inspect(current)
    }))

  const mutate = <A, E, R>(
    operation: string,
    change: (candidate: State, emit: (event: Event) => void) => Effect.Effect<A, E, R>,
    onStorageFailure?: () => void
  ) =>
    coordinate(Effect.uninterruptibleMask((restore) =>
      Effect.gen(function*() {
        yield* checkAvailable(operation)
        const candidate = yield* restore(copy(current))
        const events: Array<Event> = []
        const value = yield* restore(change(candidate, (event) => events.push(event)))

        if (provider.prepare !== undefined) yield* restore(provider.prepare(candidate))
        const committed = yield* Effect.exit(Effect.suspend(() => provider.commit(candidate)))

        if (Exit.isFailure(committed)) {
          available = false
          onStorageFailure?.()

          return yield* new FsError({ code: "OutcomeUnknown", operation })
        }

        const outcome = committed.value

        if (outcome === "rejected") {
          if (onStorageFailure !== undefined) {
            available = false
            onStorageFailure()
          }

          return yield* new FsError({ code: "StorageRejected", operation })
        }

        if (outcome === "unknown") {
          available = false
          onStorageFailure?.()

          return yield* new FsError({ code: "OutcomeUnknown", operation })
        }

        current = candidate
        const published = yield* Effect.exit(Effect.sync(() => publish?.(candidate, events)))

        if (Exit.isFailure(published)) {
          available = false

          return yield* new FsError({ code: "OutcomeUnknown", operation })
        }

        return value
      })
    ))

  return { read, mutate, coordinate, checkAvailable, shutdown }
}
