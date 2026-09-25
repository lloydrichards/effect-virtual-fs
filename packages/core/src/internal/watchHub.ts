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
 * What one subscriber receives. Every function sees the context its publication was made with.
 *
 * @internal
 */
export interface Selection<A, C> {
  // Whether the subscriber receives the event. Checked before its queue's capacity, so an event it does not
  // receive cannot overflow it.
  readonly includes: (event: A, context: C) => boolean
  // The marker the subscriber receives in place of the event that would fill its queue.
  readonly rescan: (context: C) => A
  // Once a publication's events are offered: the subscriber's last events when its stream ends, or nothing. They
  // are never replaced by the marker, since nothing follows them.
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

    // Nothing is queued behind the marker, so an empty queue means the consumer has taken it.
    if (subscriber.overflowed && size > 0) return

    subscriber.overflowed = size >= capacity - 1
    Queue.offerUnsafe(subscriber.queue, subscriber.overflowed ? subscriber.selection.rescan(context) : event)
  }

  // An ended subscriber leaves the set at once; the consumer still takes what its queue holds.
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

  // The finalizer is registered before the registration waits for the volume, so a scope that closes while the
  // registration is under way, or right after it, still removes the subscriber it added.
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
        // One slot past the capacity holds a stream's last event behind a marker.
        queue: yield* Queue.bounded<A, Cause.Done>(capacity + 1),
        selection,
        overflowed: false
      }

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

  return { publishUnsafe, subscribe }
})
