import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Queue from "effect/Queue"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"

/** @internal */
export interface Coordinator {
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
}

/** @internal */
export interface WatchHub<A, E = never> {
  readonly publishUnsafe: (event: () => A) => void
  readonly publishManyUnsafe: (events: () => Iterable<A>) => void
  readonly subscribe: (afterSubscribe: Effect.Effect<void>) => Effect.Effect<Stream.Stream<A>, E, Scope.Scope>
}

interface Subscriber<A> {
  readonly queue: Queue.Queue<A>
  overflowed: boolean
}

/** @internal */
export const make = Effect.fnUntraced(function*<A, E = never>(
  coordinate: Coordinator,
  capacity: number,
  rescan: () => A,
  checkAvailable?: Effect.Effect<void, E>
): Effect.fn.Return<WatchHub<A, E>> {
  const subscribers = new Set<Subscriber<A>>()

  const publish = (event: A): void => {
    for (const subscriber of subscribers) {
      const size = Queue.sizeUnsafe(subscriber.queue)

      // Nothing is queued behind the marker, so an empty queue means the consumer has taken it.
      if (subscriber.overflowed && size > 0) continue

      subscriber.overflowed = size >= capacity - 1
      Queue.offerUnsafe(subscriber.queue, subscriber.overflowed ? rescan() : event)
    }
  }

  const publishUnsafe = (event: () => A): void => {
    if (subscribers.size > 0) publish(event())
  }

  const publishManyUnsafe = (events: () => Iterable<A>): void => {
    if (subscribers.size > 0) { for (const event of events()) publish(event) }
  }

  // The finalizer is registered before the registration waits for the volume, so a scope that closes while the
  // registration is under way, or right after it, still removes the subscriber it added.
  const subscribe = Effect.fnUntraced(function*(afterSubscribe: Effect.Effect<void>) {
    const scope = yield* Effect.scope
    let registered: Subscriber<A> | undefined

    yield* Scope.addFinalizer(
      scope,
      Effect.suspend(() => {
        const subscriber = registered

        if (subscriber === undefined) return Effect.void

        return coordinate(Effect.sync(() => subscribers.delete(subscriber))).pipe(
          Effect.andThen(Queue.shutdown(subscriber.queue))
        )
      })
    )

    const closed = () => Predicate.isTagged(scope.state, "Closed")

    const subscriber = yield* coordinate(Effect.gen(function*() {
      if (checkAvailable !== undefined) yield* checkAvailable
      const created: Subscriber<A> = { queue: yield* Queue.bounded<A>(capacity), overflowed: false }

      yield* afterSubscribe

      // A scope closed before or during registration already ran its finalizer, which found nothing to remove,
      // so the subscriber is dropped here and its stream is empty.
      if (closed()) {
        yield* Queue.shutdown(created.queue)

        return undefined
      }

      subscribers.add(created)
      registered = created

      return created
    }))

    return subscriber === undefined ? Stream.empty : Stream.fromEffectRepeat(Queue.take(subscriber.queue))
  })

  return { publishUnsafe, publishManyUnsafe, subscribe }
})
