import { BytePath, type VirtualFileSystem as P } from "@effect-vfs/effect-preview"
import { Cause, Effect, Exit, Predicate, Queue, Scope, Stream } from "effect"
import * as Scheduler from "effect/Scheduler"
import type * as V from "../VirtualFileSystem.js"
import { Change } from "../Watch.js"
import { sameBytes } from "./bytes.js"
import { Errors, Paths, type State, VolumeTestSeams } from "./model.js"

import * as CallerWatch from "./callerWatchSelection.js"
import type { CallerWatchSelection, Event, Link } from "./callerWatchSelection.js"

export type { CallerWatchSelection } from "./callerWatchSelection.js"

interface Mailbox<E> {
  readonly queue: Queue.Queue<V.Change, E | Cause.Done>
  overflowed: boolean
}

interface Subscription extends Mailbox<never> {
  readonly root: bigint
  readonly recursive: boolean
}

interface CallerSubscription extends Mailbox<V.FsFailure> {
  readonly options: CallerWatchSelection
  selected: Link | undefined
  view: CallerWatch.View
}

const root = 1n

// Queue offers run inside the commit listener. Schedule their wakeups on a microtask before invoking consumer code.
const wakeScheduler = new Scheduler.MixedScheduler("sync")

// Object numbers identify scope across renames. Only namespace bindings are needed to project events to byte paths.
export const make = (initial: State.VolumeState | undefined, capacity: number) => {
  const names = new Map<bigint, Array<Link>>()
  const subscriptions = new Set<Subscription>()
  const callers = new Set<CallerSubscription>()

  const add = (object: bigint, link: Link) => {
    const links = names.get(object)

    if (links === undefined) names.set(object, [link])
    else links.push(link)
  }

  if (initial !== undefined) {
    for (const [, node] of initial.inodes) {
      if (node.kind !== "directory") continue

      for (const [name, child] of node.entries) {
        add(BigInt(child), { parent: BigInt(node.ino), name: Paths.nameBytes(name) })
      }
    }
  }

  const remove = (object: bigint, link: Link) => {
    const links = names.get(object)

    if (links === undefined) return
    const index = links.findIndex((old) => old.parent === link.parent && sameBytes(old.name, link.name))

    if (index >= 0) links.splice(index, 1)

    if (links.length === 0) names.delete(object)
  }

  const path = (link: Link, relativeRoot = root) => {
    const components = [link.name]
    let parent = link.parent

    while (parent !== relativeRoot) {
      const ancestor = names.get(parent)?.[0]

      if (ancestor === undefined) return undefined
      components.push(ancestor.name)
      parent = ancestor.parent
    }

    const length = components.reduce((total, name) => total + name.length + 1, 0)
    const bytes = new Uint8Array(length)
    let offset = 0

    for (const component of components.reverse()) {
      bytes[offset++] = 47
      bytes.set(component, offset)
      offset += component.length
    }

    return bytes
  }

  const rootPath = Paths.ownedPath(Paths.ROOT_PATH)

  const directoryPath = (id: bigint, relativeRoot: bigint) => {
    if (id === relativeRoot) return rootPath
    const link = names.get(id)?.[0]
    const bytes = link === undefined ? undefined : path(link, relativeRoot)

    return bytes === undefined ? undefined : Paths.ownedPath(bytes)
  }

  const aliases = (id: bigint) =>
    id === root ? [Paths.ROOT_PATH] : (names.get(id) ?? []).flatMap((link) => {
      const value = path(link)

      return value === undefined ? [] : [value]
    })

  const offer = <E>(subscriber: Mailbox<E>, change: V.Change, rescan: () => V.BytePath) => {
    const size = Queue.sizeUnsafe(subscriber.queue)

    if (subscriber.overflowed && size > 0) return
    subscriber.overflowed = size >= capacity - 1
    Queue.offerUnsafe(subscriber.queue, subscriber.overflowed ? Change.cases.Rescan.make({ path: rescan() }) : change)
  }

  const includes = (subscriber: Subscription, event: Event) => {
    if (subscriber.root === event.object || subscriber.root === event.parent) return true

    if (!subscriber.recursive) return false

    for (let parent = event.parent; parent !== root;) {
      const ancestor = names.get(parent)?.[0]

      if (ancestor === undefined) return false
      parent = ancestor.parent

      if (parent === subscriber.root) return true
    }

    return subscriber.root === root
  }

  const publish = (batch: ReadonlyArray<P.CommittedMutation>) => {
    const events: Array<Event> = []
    const removed = new Map<bigint, Uint8Array>()
    const watching = subscriptions.size !== 0 || callers.size !== 0
    let lastRemoval: { object: bigint; link: Link } | undefined

    for (const action of batch) {
      if (Predicate.isTagged(action, "Update")) {
        lastRemoval = undefined

        if (!watching) continue

        if (action.object === root) {
          events.push({
            object: root,
            parent: root,
            path: Paths.ROOT_PATH,
            change: Change.cases.Update.make({ path: rootPath })
          })
        }

        for (const link of names.get(action.object) ?? []) {
          const current = path(link)

          if (current !== undefined) {
            events.push({
              object: action.object,
              parent: link.parent,
              path: current,
              change: Change.cases.Update.make({ path: Paths.ownedPath(current) })
            })
          }
        }

        continue
      }

      const link = { parent: action.parent, name: BytePath.toBytes(action.name) }
      const current = watching ? path(link) : undefined

      if (Predicate.isTagged(action, "Remove")) {
        lastRemoval = { object: action.object, link }
        remove(action.object, link)

        if (current !== undefined) removed.set(action.object, current)
      } else {
        if (action.previous !== undefined) {
          remove(action.previous, link)

          if (current !== undefined) removed.set(action.previous, current)
        }

        // The feed publishes one rename as adjacent Remove/Create facts for the same object.
        if (lastRemoval?.object === action.object && Predicate.isTagged(action, "Create")) {
          for (const subscriber of callers) {
            if (
              subscriber.options.target === action.object && subscriber.selected?.parent === lastRemoval.link.parent &&
              sameBytes(subscriber.selected.name, lastRemoval.link.name)
            ) subscriber.selected = link
          }
        }

        lastRemoval = undefined
        add(action.object, link)
      }

      if (current !== undefined) {
        const tag = Predicate.isTagged(action, "Replace") ? "Update" : action._tag
        const change = Change.cases[tag].make({ path: Paths.ownedPath(current) })

        events.push({
          object: action.object,
          parent: link.parent,
          path: current,
          change,
          previous: Predicate.isTagged(action, "Remove") ? undefined : action.previous
        })
      }
    }

    for (const subscriber of subscriptions) {
      const terminal = names.has(subscriber.root) ? undefined : removed.get(subscriber.root)

      for (const event of events) {
        const displaced = event.previous === subscriber.root && event.object !== subscriber.root

        if (
          terminal !== undefined &&
          (displaced || (event.object === subscriber.root && Predicate.isTagged(event.change, "Remove")))
        ) {
          continue
        }

        if (!displaced && !includes(subscriber, event)) continue
        const change = displaced ? Change.cases.Remove.make({ path: event.change.path }) : event.change

        offer(subscriber, change, () => {
          const link = names.get(subscriber.root)?.[0]
          const current = link === undefined ? terminal : path(link)

          return current === undefined ? rootPath : Paths.ownedPath(current)
        })
      }

      if (terminal !== undefined) {
        // The extra queue slot preserves final removal even when a rescan marker is pending.
        Queue.offerUnsafe(subscriber.queue, Change.cases.Remove.make({ path: Paths.ownedPath(terminal) }))
        Queue.endUnsafe(subscriber.queue)
        subscriptions.delete(subscriber)
      }
    }

    for (const subscriber of callers) {
      const after = CallerWatch.observe(subscriber.options, subscriber.selected, aliases, path)

      if (!("aliases" in after)) {
        callers.delete(subscriber)
        Queue.failCauseUnsafe(subscriber.queue, Cause.fail(after))
        continue
      }

      CallerWatch.deliver(
        subscriber.options,
        subscriber.view,
        after,
        events,
        (change, rescan) => offer(subscriber, change, () => rescan),
        (last, rescan) => {
          for (const change of last) offer(subscriber, change, () => rescan)

          if (subscriber.overflowed) {
            while (Queue.takeUnsafe(subscriber.queue) !== undefined) {
              /* Replace any undelivered prefix with one marker. */
            }

            Queue.offerUnsafe(subscriber.queue, Change.cases.Rescan.make({ path: rescan }))
          }

          callers.delete(subscriber)
          Queue.endUnsafe(subscriber.queue)
        }
      )
      subscriber.view = after
    }
  }

  const register = Effect.fnUntraced(function*<E, S extends Mailbox<E>>(
    subscribers: Set<S>,
    create: (queue: Queue.Queue<V.Change, E | Cause.Done>) => S
  ) {
    const scope = yield* Scope.fork(yield* Effect.scope)

    if (Predicate.isTagged(scope.state, "Closed")) return Stream.empty

    const queue = yield* Queue.bounded<V.Change, E | Cause.Done>(capacity + 1).pipe(
      Effect.provideService(Scheduler.Scheduler, wakeScheduler)
    )

    const subscriber = create(queue)

    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        subscribers.delete(subscriber)
        Queue.shutdownUnsafe(subscriber.queue)
      })
    )

    const seams = yield* VolumeTestSeams
    yield* Effect.suspend(() => {
      if (Predicate.isTagged(scope.state, "Closed")) return Effect.void
      subscribers.add(subscriber)

      return seams.afterSubscribe
    }).pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))))

    return Predicate.isTagged(scope.state, "Closed")
      ? Stream.empty
      : Stream.fromEffectRepeat(Queue.take(subscriber.queue))
  })

  const subscribe = Effect.fnUntraced(function*(object: bigint, recursive: boolean) {
    if (object !== root && !names.has(object)) return yield* Errors.fsFailure("StaleReference", "watch")

    return yield* register<never, Subscription>(
      subscriptions,
      (queue) => ({ root: object, recursive, queue, overflowed: false })
    )
  })

  const subscribeCaller = Effect.fnUntraced(function*(options: CallerWatchSelection) {
    if (options.target !== root && !names.has(options.target)) return yield* Errors.fsFailure("NotFound", "watch")
    const view = CallerWatch.observe(options, options.selected, aliases, path)

    if (!("aliases" in view)) return yield* view

    if (view.aliases.length === 0) return yield* Errors.fsFailure("AccessDenied", "watch")

    return yield* register<V.FsFailure, CallerSubscription>(callers, (queue) => ({
      options,
      selected: options.selected,
      view,
      queue,
      overflowed: false
    }))
  })

  return { publish, subscribe, subscribeCaller, directoryPath }
}
