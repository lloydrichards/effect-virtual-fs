import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import type * as Scope from "effect/Scope"
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

  const subscribe = (afterSubscribe: Effect.Effect<void>) =>
    Effect.acquireRelease(
      coordinate(Effect.gen(function*() {
        if (checkAvailable !== undefined) yield* checkAvailable
        const subscriber: Subscriber<A> = { queue: yield* Queue.bounded<A>(capacity), overflowed: false }

        yield* afterSubscribe
        subscribers.add(subscriber)

        return subscriber
      })),
      (subscriber) =>
        coordinate(Effect.sync(() => subscribers.delete(subscriber))).pipe(
          Effect.andThen(Queue.shutdown(subscriber.queue))
        ),
      { interruptible: true }
    ).pipe(Effect.map((subscriber) => Stream.fromEffectRepeat(Queue.take(subscriber.queue))))

  return { publishUnsafe, publishManyUnsafe, subscribe }
})
