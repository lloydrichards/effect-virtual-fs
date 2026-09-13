import * as Effect from "effect/Effect"
import * as PubSub from "effect/PubSub"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"

/** @internal */
export interface Coordinator {
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
}

/** @internal */
export interface WatchHub<A> {
  readonly publishUnsafe: (event: () => A) => void
  readonly publishManyUnsafe: (events: () => Iterable<A>) => void
  readonly subscribe: (afterSubscribe?: Effect.Effect<void>) => Effect.Effect<Stream.Stream<A>, never, Scope.Scope>
}

/** @internal */
export const make = Effect.fnUntraced(function*<A>(coordinate: Coordinator): Effect.fn.Return<WatchHub<A>> {
  const pubsub = yield* PubSub.unbounded<A>()
  let activeSubscribers = 0

  const publishUnsafe = (event: () => A): void => {
    if (activeSubscribers === 0) return
    PubSub.publishUnsafe(pubsub, event())
  }

  const publishManyUnsafe = (events: () => Iterable<A>): void => {
    if (activeSubscribers === 0) return
    for (const event of events()) PubSub.publishUnsafe(pubsub, event)
  }

  const subscribe = (afterSubscribe?: Effect.Effect<void>) =>
    Effect.uninterruptible(Effect.gen(function*() {
      const subscription = yield* coordinate(Effect.gen(function*() {
        const subscription = yield* PubSub.subscribe(pubsub)
        if (afterSubscribe !== undefined) yield* afterSubscribe
        activeSubscribers += 1
        return subscription
      }))
      yield* Effect.addFinalizer(() =>
        coordinate(Effect.sync(() => {
          activeSubscribers -= 1
        }))
      )
      return Stream.fromSubscription(subscription)
    }))

  return { publishUnsafe, publishManyUnsafe, subscribe }
})
