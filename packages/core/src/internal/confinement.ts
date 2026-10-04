import * as Effect from "effect/Effect"
import type { FsFailure } from "../VfsError.js"
import type { OpContext } from "./errors.js"
import { type Ino, type Node, ROOT_INO } from "./volumeState.js"

/** @internal */
export const make = (get: (ino: Ino) => Effect.Effect<Node | undefined>, roots: ReadonlyArray<Ino>) => {
  const descends = Effect.fnUntraced(function*(ino: Ino, root: Ino) {
    let node = yield* get(ino)

    while (node?.kind === "directory" && node.metadata.nlink > 0) {
      if (node.ino === root) return true

      if (node.ino === ROOT_INO) return false
      const parent = yield* get(node.parent)

      if (parent?.kind !== "directory" || parent.entries.get(node.name) !== node.ino) return false
      node = parent
    }

    return false
  })

  const alive = Effect.fnUntraced(function*(op: OpContext, handle: boolean = false) {
    for (let index = 0; index < roots.length; index++) {
      const root = roots[index]!
      const node = yield* get(root)

      if (node?.kind !== "directory" || node.metadata.nlink === 0) {
        return yield* op.fail(handle ? "InvalidHandle" : "ClosedCaller")
      }

      if (index > 0 && !(yield* descends(root, roots[index - 1]!))) return yield* op.fail("AccessDenied")
    }
  })

  const contains = Effect.fnUntraced(function*(node: Node) {
    const root = roots.at(-1)

    if (root === undefined) return true

    if (node.kind === "directory") return yield* descends(node.ino, root)

    for (const link of node.links) {
      const parent = yield* get(link.parent)

      if (
        parent?.kind === "directory" && parent.entries.get(link.name) === node.ino &&
        (yield* descends(parent.ino, root))
      ) return true
    }

    return false
  })

  const check = Effect.fnUntraced(
    function*(node: Node, op: OpContext, handle: boolean = false): Effect.fn.Return<void, FsFailure> {
      yield* alive(op, handle)

      if (!(yield* contains(node))) return yield* op.fail("AccessDenied")
    }
  )

  const path = Effect.fnUntraced(function*(ino: Ino) {
    const names: Array<string> = []
    let node = yield* get(ino)

    if (node?.kind !== "directory" || node.metadata.nlink === 0) return undefined
    const root = roots.at(-1) ?? ROOT_INO

    while (node.ino !== root) {
      if (node.ino === ROOT_INO) return undefined
      names.push(node.name)
      const parent: Node | undefined = yield* get(node.parent)

      if (parent?.kind !== "directory" || parent.metadata.nlink === 0 || parent.entries.get(node.name) !== node.ino) {
        return undefined
      }

      node = parent
    }

    return "2f" + names.reverse().join("2f")
  })

  return { roots, root: roots.at(-1) ?? ROOT_INO, alive, contains, check, path }
}

/** @internal */
export type Confinement = ReturnType<typeof make>
