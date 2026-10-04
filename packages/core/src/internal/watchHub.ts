import * as Cause from "effect/Cause"
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
export interface Selection<A, C, E = never> {
  // Filtering precedes capacity checks.
  readonly includes: (event: A, context: C) => boolean
  readonly prepare?: (context: C) => void
  readonly project?: (event: A, context: C) => A | undefined
  readonly failure?: (context: C) => E | undefined
  readonly boundedTerminal?: boolean
  readonly rescan: (context: C) => A
  // Volume watches retain final removals; bounded selections replace terminal overflow with Rescan.
  readonly settle?: (context: C) => Iterable<A> | undefined
}

/** @internal */
export interface WatchHub<A, C, E = never> {
  readonly publishUnsafe: (events: () => Iterable<A>, context: C) => void
  readonly subscribe: <F extends E = never>(
    select: Effect.Effect<Selection<A, C, F>, E>,
    afterSubscribe: Effect.Effect<void>
  ) => Effect.Effect<Stream.Stream<A, F>, E, Scope.Scope>
}

interface Subscriber<A, C, E> {
  readonly queue: Queue.Queue<A, E | Cause.Done>
  readonly selection: Selection<A, C, E>
  overflowed: boolean
}

/** @internal */
export const make = Effect.fnUntraced(function*<A, C, E = never>(
  coordinate: Coordinator,
  capacity: number
): Effect.fn.Return<WatchHub<A, C, E>> {
  const subscribers = new Set<Subscriber<A, C, E>>()

  const offer = (subscriber: Subscriber<A, C, E>, event: A, context: C): void => {
    const size = Queue.sizeUnsafe(subscriber.queue)

    // An empty queue means the consumer has taken the rescan marker.
    if (subscriber.overflowed && size > 0) return

    subscriber.overflowed = size >= capacity - 1
    Queue.offerUnsafe(subscriber.queue, subscriber.overflowed ? subscriber.selection.rescan(context) : event)
  }

  const publishUnsafe = (events: () => Iterable<A>, context: C): void => {
    if (subscribers.size === 0) return

    for (const subscriber of subscribers) subscriber.selection.prepare?.(context)

    for (const event of events()) {
      for (const subscriber of subscribers) {
        if (subscriber.selection.includes(event, context)) {
          const projected = subscriber.selection.project === undefined
            ? event
            : subscriber.selection.project(event, context)

          if (projected !== undefined) offer(subscriber, projected, context)
        }
      }
    }

    for (const subscriber of subscribers) {
      const last = subscriber.selection.settle?.(context)

      const failure = subscriber.selection.failure?.(context)

      if (last === undefined && failure === undefined) continue

      if (last !== undefined) {
        if (subscriber.selection.boundedTerminal) {
          for (const event of last) offer(subscriber, event, context)

          if (subscriber.overflowed) {
            while (Queue.takeUnsafe(subscriber.queue) !== undefined) { /* Drain before replacing with Rescan. */ }

            Queue.offerUnsafe(subscriber.queue, subscriber.selection.rescan(context))
          }
        } else {
          for (const event of last) Queue.offerUnsafe(subscriber.queue, event)
        }
      }

      subscribers.delete(subscriber)

      if (failure === undefined) Queue.endUnsafe(subscriber.queue)
      else Queue.failCauseUnsafe(subscriber.queue, Cause.fail(failure))
    }
  }

  // Register cleanup before waiting for the volume, including when the scope closes during registration.
  const subscribe = Effect.fnUntraced(function*<F extends E = never>(
    select: Effect.Effect<Selection<A, C, F>, E>,
    afterSubscribe: Effect.Effect<void>
  ) {
    const scope = yield* Effect.scope
    let registered: Subscriber<A, C, E> | undefined

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

      const created: Subscriber<A, C, E> = {
        // Reserve one slot for a final event behind a rescan marker.
        queue: yield* Queue.bounded<A, E | Cause.Done>(capacity + 1),
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

    // SAFETY: A subscription queue only receives failures from its own Selection<F>.
    return subscriber === undefined ? Stream.empty : Stream.fromEffectRepeat(
      Queue.take(subscriber.queue as Queue.Queue<A, F | Cause.Done>)
    )
  })

  return { publishUnsafe, subscribe }
})
