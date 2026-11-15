/* eslint-disable effecttsgo/experimental-api-usage */
import { BytePath, type VirtualFileSystem as P } from "@effect-vfs/effect-preview"
import { type Cause, Effect, Exit, Predicate, Queue, Scope, Stream } from "effect"
import * as Scheduler from "effect/Scheduler"
import type * as V from "../VirtualFileSystem.js"
import { Change } from "../Watch.js"
import { sameBytes } from "./bytes.js"
import { Errors, Paths, type State, VolumeTestSeams } from "./model.js"

interface Link {
  readonly parent: bigint
  readonly name: Uint8Array
}

interface Event {
  readonly change: V.Change
  readonly object: bigint
  readonly parent: bigint
}

interface Subscription {
  readonly root: bigint
  readonly recursive: boolean
  readonly queue: Queue.Queue<V.Change, Cause.Done>
  overflowed: boolean
}

const root = 1n

// Queue offers run inside the commit listener. Schedule their wakeups on a microtask before invoking consumer code.
const wakeScheduler = new Scheduler.MixedScheduler("sync")

// Object numbers identify scope across renames. Only namespace bindings are needed to project events to byte paths.
export const make = (initial: State.VolumeState | undefined, capacity: number) => {
  const names = new Map<bigint, Array<Link>>()
  const subscriptions = new Set<Subscription>()

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

  const path = (link: Link) => {
    const components = [link.name]
    let parent = link.parent

    while (parent !== root) {
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

    return Paths.ownedPath(bytes)
  }

  const rootPath = Paths.ownedPath(Paths.ROOT_PATH)

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
    const removed = new Map<bigint, V.BytePath>()
    const watching = subscriptions.size !== 0

    for (const action of batch) {
      if (Predicate.isTagged(action, "Update")) {
        if (!watching) continue

        if (action.object === root) {
          events.push({ object: root, parent: root, change: Change.cases.Update.make({ path: rootPath }) })
        }

        for (const link of names.get(action.object) ?? []) {
          const current = path(link)

          if (current !== undefined) {
            events.push({
              object: action.object,
              parent: link.parent,
              change: Change.cases.Update.make({ path: current })
            })
          }
        }

        continue
      }

      const link = { parent: action.parent, name: BytePath.toBytes(action.name) }
      const current = watching ? path(link) : undefined

      if (Predicate.isTagged(action, "Remove")) {
        remove(action.object, link)

        if (current !== undefined) removed.set(action.object, current)
      } else {
        if (action.previous !== undefined) {
          remove(action.previous, link)

          if (current !== undefined) removed.set(action.previous, current)
        }

        add(action.object, link)
      }

      if (current !== undefined) {
        const tag = Predicate.isTagged(action, "Replace") ? "Update" : action._tag
        const change = Change.cases[tag].make({ path: current })

        events.push({ object: action.object, parent: link.parent, change })
      }
    }

    for (const subscriber of subscriptions) {
      const terminal = names.has(subscriber.root) ? undefined : removed.get(subscriber.root)

      for (const event of events) {
        if (terminal !== undefined && event.object === subscriber.root && Predicate.isTagged(event.change, "Remove")) {
          continue
        }

        if (!includes(subscriber, event)) continue
        const size = Queue.sizeUnsafe(subscriber.queue)

        if (subscriber.overflowed && size > 0) continue
        subscriber.overflowed = size >= capacity - 1

        if (subscriber.overflowed) {
          const link = names.get(subscriber.root)?.[0]
          const current = link === undefined ? terminal : path(link)
          Queue.offerUnsafe(subscriber.queue, Change.cases.Rescan.make({ path: current ?? rootPath }))
        } else Queue.offerUnsafe(subscriber.queue, event.change)
      }

      if (terminal !== undefined) {
        // The extra queue slot preserves final removal even when a rescan marker is pending.
        Queue.offerUnsafe(subscriber.queue, Change.cases.Remove.make({ path: terminal }))
        Queue.endUnsafe(subscriber.queue)
        subscriptions.delete(subscriber)
      }
    }
  }

  const subscribe = Effect.fnUntraced(function*(object: bigint, recursive: boolean) {
    if (object !== root && !names.has(object)) return yield* Errors.fsFailure("StaleReference", "watch")
    const scope = yield* Scope.fork(yield* Effect.scope)

    if (Predicate.isTagged(scope.state, "Closed")) return Stream.empty

    const subscriber: Subscription = {
      root: object,
      recursive,
      queue: yield* Queue.bounded<V.Change, Cause.Done>(capacity + 1).pipe(
        Effect.provideService(Scheduler.Scheduler, wakeScheduler)
      ),
      overflowed: false
    }

    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        subscriptions.delete(subscriber)
        Queue.shutdownUnsafe(subscriber.queue)
      })
    )

    const seams = yield* VolumeTestSeams
    yield* Effect.suspend(() => {
      if (Predicate.isTagged(scope.state, "Closed")) return Effect.void
      subscriptions.add(subscriber)

      return seams.afterSubscribe
    }).pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))))

    return Predicate.isTagged(scope.state, "Closed")
      ? Stream.empty
      : Stream.fromEffectRepeat(Queue.take(subscriber.queue))
  })

  return { publish, subscribe }
}
