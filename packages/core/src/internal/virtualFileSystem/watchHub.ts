// Change broadcasting for Volume.watch: one PubSub per volume, published to only while someone listens.
import * as Effect from "effect/Effect"
import * as PubSub from "effect/PubSub"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"

/** @internal */
export interface Coordinator {
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
}

// Events are passed as thunks so nothing is allocated when there are no subscribers.
/** @internal */
export interface WatchHub<A> {
  readonly publishUnsafe: (event: () => A) => void
  readonly publishManyUnsafe: (events: () => Iterable<A>) => void
  readonly subscribe: (afterSubscribe?: Effect.Effect<void>) => Effect.Effect<Stream.Stream<A>, never, Scope.Scope>
}

/** @internal */
export const make = Effect.fnUntraced(function*<A>(coordinate: Coordinator): Effect.fn.Return<WatchHub<A>> {
  const pubsub = yield* PubSub.unbounded<A>()
  // Guarded by `coordinate`: publishers run inside coordinated mutations and both writes below hold the gate.
  let activeSubscribers = 0

  const publishUnsafe = (event: () => A): void => {
    if (activeSubscribers === 0) return
    PubSub.publishUnsafe(pubsub, event())
  }

  const publishManyUnsafe = (events: () => Iterable<A>): void => {
    if (activeSubscribers === 0) return

    for (const event of events()) PubSub.publishUnsafe(pubsub, event)
  }

  // Registration is uninterruptible end to end, including the permit wait, so a watcher is never
  // half-registered. This deliberately tightens the engine's "permit waits stay interruptible" rule.
  const subscribe = (afterSubscribe?: Effect.Effect<void>) =>
    Effect.acquireRelease(
      coordinate(Effect.gen(function*() {
        const subscription = yield* PubSub.subscribe(pubsub)

        if (afterSubscribe !== undefined) yield* afterSubscribe
        activeSubscribers += 1

        return subscription
      })),
      () =>
        coordinate(Effect.sync(() => {
          activeSubscribers -= 1
        }))
    ).pipe(Effect.map(Stream.fromSubscription))

  return { publishUnsafe, publishManyUnsafe, subscribe }
})
