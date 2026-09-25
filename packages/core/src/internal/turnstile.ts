// A first-come lock for the volume's change turnstile.
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type { SchedulerDispatcher } from "effect/Scheduler"

/** @internal */
export interface Turnstile {
  // Runs `effect` holding the turnstile, after every fiber that asked for it earlier.
  readonly withTurn: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

interface Ticket {
  readonly dispatcher: SchedulerDispatcher
  granted: boolean
  wake: (() => void) | undefined
}

// A Semaphore frees a permit on release and wakes its waiters on a later task, so a fiber that arrives in
// between takes the permit ahead of them. This lock hands itself to its oldest waiter at release instead, and
// only schedules that waiter's resumption, so nothing that arrives later can pass it.
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

    // The turnstile is the waiter's from here on; only its resumption waits for its dispatcher.
    next.granted = true
    next.dispatcher.scheduleTask(() => next.wake?.(), 0)
  }

  const waitFor = (ticket: Ticket) =>
    Effect.callback<void>((resume) => {
      if (ticket.granted) return resume(Effect.void)
      ticket.wake = () => resume(Effect.void)
    })

  return {
    // The turnstile is taken and given back while uninterruptible, and only the wait for it is interruptible.
    // Whether the waiter owns the turnstile is read from its ticket after the wait, however the wait ended, so
    // an interruption can neither strand the turnstile nor lose the waiter's place to a later arrival.
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
