import type * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Queue from "effect/Queue"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"

/** @internal */
export interface Coordinator {
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
}

/**
 * Selection callbacks share the context of their publication.
 *
 * @internal
 */
export interface Selection<A, C> {
  // Filtering precedes capacity checks.
  readonly includes: (event: A, context: C) => boolean
  readonly rescan: (context: C) => A
  // Final events bypass the rescan marker because no later events can overflow them.
  readonly settle?: (context: C) => Iterable<A> | undefined
}

/** @internal */
export interface WatchHub<A, C, E = never> {
  readonly publishUnsafe: (events: () => Iterable<A>, context: C) => void
  readonly subscribe: (
    select: Effect.Effect<Selection<A, C>, E>,
    afterSubscribe: Effect.Effect<void>
  ) => Effect.Effect<Stream.Stream<A>, E, Scope.Scope>
}

interface Subscriber<A, C> {
  readonly queue: Queue.Queue<A, Cause.Done>
  readonly selection: Selection<A, C>
  overflowed: boolean
}

/** @internal */
export const make = Effect.fnUntraced(function*<A, C, E = never>(
  coordinate: Coordinator,
  capacity: number
): Effect.fn.Return<WatchHub<A, C, E>> {
  const subscribers = new Set<Subscriber<A, C>>()

  const offer = (subscriber: Subscriber<A, C>, event: A, context: C): void => {
    const size = Queue.sizeUnsafe(subscriber.queue)

    // An empty queue means the consumer has taken the rescan marker.
    if (subscriber.overflowed && size > 0) return

    subscriber.overflowed = size >= capacity - 1
    Queue.offerUnsafe(subscriber.queue, subscriber.overflowed ? subscriber.selection.rescan(context) : event)
  }

  const publishUnsafe = (events: () => Iterable<A>, context: C): void => {
    if (subscribers.size === 0) return

    for (const event of events()) {
      for (const subscriber of subscribers) {
        if (subscriber.selection.includes(event, context)) offer(subscriber, event, context)
      }
    }

    for (const subscriber of subscribers) {
      const last = subscriber.selection.settle?.(context)

      if (last === undefined) continue

      for (const event of last) Queue.offerUnsafe(subscriber.queue, event)
      subscribers.delete(subscriber)
      Queue.endUnsafe(subscriber.queue)
    }
  }

  // Register cleanup before waiting for the volume, including when the scope closes during registration.
  const subscribe = Effect.fnUntraced(function*(
    select: Effect.Effect<Selection<A, C>, E>,
    afterSubscribe: Effect.Effect<void>
  ) {
    const scope = yield* Effect.scope
    let registered: Subscriber<A, C> | undefined

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
      const selection = yield* select

      const created: Subscriber<A, C> = {
        // Reserve one slot for a final event behind a rescan marker.
        queue: yield* Queue.bounded<A, Cause.Done>(capacity + 1),
        selection,
        overflowed: false
      }

      yield* afterSubscribe

      // Cleanup may have run before registration; discard the subscriber if the scope closed.
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

  return { publishUnsafe, subscribe }
})
