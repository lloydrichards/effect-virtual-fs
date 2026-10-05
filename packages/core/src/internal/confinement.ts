import * as Effect from "effect/Effect"
import type { FsFailure } from "../VfsError.js"
import type { OpContext } from "./errors.js"
import { type Ino, type Node, ROOT_INO, WALK_YIELD_INTERVAL } from "./volumeState.js"

/** @internal */
export const make = (view: Effect.Effect<(ino: Ino) => Node | undefined>, roots: ReadonlyArray<Ino>) => {
  const descends = Effect.fnUntraced(function*(get: (ino: Ino) => Node | undefined, ino: Ino, root: Ino) {
    let node = get(ino)
    let steps = 0

    while (node?.kind === "directory" && node.metadata.nlink > 0) {
      if (node.ino === root) return true

      if (node.ino === ROOT_INO) return false
      const parent = get(node.parent)

      if (parent?.kind !== "directory" || parent.entries.get(node.name) !== node.ino) return false
      node = parent

      if (++steps % WALK_YIELD_INTERVAL === 0) yield* Effect.yieldNow
    }

    return false
  })

  const aliveIn = Effect.fnUntraced(function*(get: (ino: Ino) => Node | undefined, op: OpContext, handle: boolean) {
    for (let index = 0; index < roots.length; index++) {
      const root = roots[index]!
      const node = get(root)

      if (node?.kind !== "directory" || node.metadata.nlink === 0) {
        return yield* op.fail(handle ? "InvalidHandle" : "ClosedCaller")
      }

      if (index > 0 && !(yield* descends(get, root, roots[index - 1]!))) return yield* op.fail("AccessDenied")
    }
  })

  const containsIn = Effect.fnUntraced(function*(get: (ino: Ino) => Node | undefined, node: Node) {
    const root = roots.at(-1)

    if (root === undefined) return true

    if (node.kind === "directory") return yield* descends(get, node.ino, root)

    for (const link of node.links) {
      const parent = get(link.parent)

      if (
        parent?.kind === "directory" && parent.entries.get(link.name) === node.ino &&
        (yield* descends(get, parent.ino, root))
      ) return true
    }

    return false
  })

  const alive = (op: OpContext, handle: boolean = false) => Effect.flatMap(view, (get) => aliveIn(get, op, handle))

  const contains = (node: Node) => Effect.flatMap(view, (get) => containsIn(get, node))

  const check = Effect.fnUntraced(
    function*(node: Node, op: OpContext, handle: boolean = false): Effect.fn.Return<void, FsFailure> {
      // Share the current lookup within authorization, never its result between operations.
      const get = yield* view
      yield* aliveIn(get, op, handle)

      if (!(yield* containsIn(get, node))) return yield* op.fail("AccessDenied")
    }
  )

  const path = Effect.fnUntraced(function*(ino: Ino) {
    const names: Array<string> = []
    const get = yield* view
    let node = get(ino)
    let steps = 0

    if (node?.kind !== "directory" || node.metadata.nlink === 0) return undefined
    const root = roots.at(-1) ?? ROOT_INO

    while (node.ino !== root) {
      if (node.ino === ROOT_INO) return undefined
      names.push(node.name)
      const parent: Node | undefined = get(node.parent)

      if (parent?.kind !== "directory" || parent.metadata.nlink === 0 || parent.entries.get(node.name) !== node.ino) {
        return undefined
      }

      node = parent

      if (++steps % WALK_YIELD_INTERVAL === 0) yield* Effect.yieldNow
    }

    return "2f" + names.reverse().join("2f")
  })

  return { roots, root: roots.at(-1) ?? ROOT_INO, alive, contains, check, path }
}

/** @internal */
export type Confinement = ReturnType<typeof make>
