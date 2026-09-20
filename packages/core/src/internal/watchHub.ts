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
  readonly subscribe: (afterSubscribe?: Effect.Effect<void>) => Effect.Effect<Stream.Stream<A>, E, Scope.Scope>
}

interface Subscriber<A> {
  readonly queue: Queue.Queue<A>
  overflowed: boolean
  marker: A | undefined
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
      if (subscriber.overflowed) continue

      if (Queue.sizeUnsafe(subscriber.queue) < capacity - 1) {
        Queue.offerUnsafe(subscriber.queue, event)
      } else {
        subscriber.overflowed = true
        subscriber.marker = rescan()
        Queue.offerUnsafe(subscriber.queue, subscriber.marker)
      }
    }
  }

  const publishUnsafe = (event: () => A): void => {
    if (subscribers.size > 0) publish(event())
  }

  const publishManyUnsafe = (events: () => Iterable<A>): void => {
    if (subscribers.size > 0) { for (const event of events()) publish(event) }
  }

  const subscribe = (afterSubscribe?: Effect.Effect<void>) =>
    Effect.acquireRelease(
      coordinate(Effect.gen(function*() {
        if (checkAvailable !== undefined) yield* checkAvailable
        const queue = yield* Queue.bounded<A>(capacity)

        const subscriber: Subscriber<A> = {
          queue,
          overflowed: false,
          marker: undefined
        }

        if (afterSubscribe !== undefined) yield* afterSubscribe
        subscribers.add(subscriber)

        return subscriber
      })),
      (subscriber) =>
        coordinate(Effect.sync(() => {
          subscribers.delete(subscriber)
        })).pipe(
          Effect.andThen(Queue.shutdown(subscriber.queue))
        ),
      { interruptible: true }
    ).pipe(Effect.map((subscriber) =>
      Stream.fromEffectRepeat(Queue.take(subscriber.queue)).pipe(
        Stream.map((event) => {
          if (subscriber.overflowed && event === subscriber.marker) {
            subscriber.overflowed = false
            subscriber.marker = undefined
          }

          return event
        })
      )
    ))

  return { publishUnsafe, publishManyUnsafe, subscribe }
})
