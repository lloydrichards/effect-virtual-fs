import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type { SchedulerDispatcher } from "effect/Scheduler"

/** @internal */
export interface Turnstile {
  readonly withTurn: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

interface Ticket {
  readonly dispatcher: SchedulerDispatcher
  granted: boolean
  wake: (() => void) | undefined
}

// A Semaphore can let a newcomer overtake a scheduled waiter. Transfer ownership before scheduling the oldest waiter.
/** @internal */
export const makeTurnstile = (): Turnstile => {
  let held = false
  const waiting: Array<Ticket> = []

  const release = () => {
    const next = waiting.shift()

    if (next === undefined) {
      held = false

      return
    }

    next.granted = true
    next.dispatcher.scheduleTask(() => next.wake?.(), 0)
  }

  const waitFor = (ticket: Ticket) =>
    Effect.callback<void>((resume) => {
      if (ticket.granted) return resume(Effect.void)
      ticket.wake = () => resume(Effect.void)
    })

  return {
    // Check ticket ownership after interruption so a granted turn is released rather than stranded.
    withTurn: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.withFiber((fiber) => {
          const run = Effect.ensuring(restore(effect), Effect.sync(release))

          if (!held) {
            held = true

            return run
          }

          const ticket: Ticket = { dispatcher: fiber.currentDispatcher, granted: false, wake: undefined }
          waiting.push(ticket)

          return Effect.flatMap(Effect.exit(restore(waitFor(ticket))), (waited): Effect.Effect<A, E, R> => {
            if (Exit.isSuccess(waited)) return run

            if (ticket.granted) release()
            else waiting.splice(waiting.indexOf(ticket), 1)

            return Effect.failCause(waited.cause)
          })
        })
      )
  }
}
