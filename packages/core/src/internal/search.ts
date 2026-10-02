import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { decodeOption } from "../BytePath.js"
import type { Snapshot } from "../Snapshot.js"
import type { FsFailure, ImageFailure } from "../VfsError.js"
import type { PathInput } from "../VirtualFileSystem.js"
import { fsFailure } from "./errors.js"
import * as Image from "./image.js"
import { nameBytes } from "./path.js"
import { BudgetExceeded, type Kind, type Meter } from "./searchModel.js"
import { byEntryName, type Directory, getNode, type Ino, type Node } from "./volumeState.js"

/** @internal */
export interface Entry {
  readonly path: string
  readonly pathBytes: number
  readonly parts: ReadonlyArray<string>
  readonly kind: Kind
  readonly node: Node
}

/** @internal */
export interface Visitor {
  readonly next: (
    select: (entry: Entry) => Effect.Effect<{ readonly selected: boolean; readonly prune: boolean }, BudgetExceeded>
  ) => Effect.Effect<Entry | undefined, BudgetExceeded>
}

interface DirectoryPath {
  readonly node: Directory
  readonly path: string
  readonly pathBytes: number
  readonly parts: ReadonlyArray<string>
  readonly depth: number
}

interface Frame extends DirectoryPath {
  readonly children: ReadonlyArray<readonly [string, Ino]>
  index: number
}

/** @internal */
export const makeVisitor = Effect.fnUntraced(function*(
  snapshot: Snapshot,
  root: PathInput,
  meter: Meter
): Effect.fn.Return<Visitor, FsFailure | ImageFailure> {
  const value = yield* Image.valueOf(snapshot)
  const node = yield* Effect.fromResult(Image.resolve(value, root, { operation: "search", followFinalSymlink: true }))

  if (node.kind !== "directory") return yield* fsFailure("NotDirectory", "search", { path: root })

  const frames: Array<Frame> = []
  let deferred: DirectoryPath | undefined = { node, path: "", pathBytes: 0, parts: [], depth: 0 }
  let pending = 0

  const prepare = Effect.fnUntraced(function*(directory: DirectoryPath) {
    const width = directory.node.entries.size

    // Reserve prepared siblings too, before allocating this directory's sorted list.
    if (width > meter.limits.maxEntries - meter.work.entries - pending) {
      return yield* new BudgetExceeded({ limit: "maxEntries", path: directory.path })
    }

    if (width === 0) return

    const children = [...directory.node.entries].sort(byEntryName)
    frames.push({ ...directory, children, index: 0 })
    pending += width
  })

  const next = Effect.fnUntraced(function*(select: Parameters<Visitor["next"]>[0]) {
    while (true) {
      if (deferred !== undefined) {
        const directory = deferred
        deferred = undefined
        yield* prepare(directory)
      }

      let frame = frames[frames.length - 1]

      while (frame !== undefined && frame.index === frame.children.length) {
        frames.pop()
        frame = frames[frames.length - 1]
      }

      if (frame === undefined) return undefined

      const [hex, ino] = frame.children[frame.index++]!
      pending--
      meter.work.entries++

      if (meter.work.entries % 128 === 0) yield* Effect.yieldNow

      const depth = frame.depth + 1

      if (depth > meter.limits.maxDepth) {
        return yield* new BudgetExceeded({ limit: "maxDepth", path: frame.path })
      }

      const pathBytes = frame.pathBytes + (frame.depth === 0 ? 0 : 1) + hex.length / 2

      if (BigInt(pathBytes) > meter.limits.maxPathBytes) {
        return yield* new BudgetExceeded({ limit: "maxPathBytes", path: frame.path })
      }

      const child = getNode(value, ino)!
      const name = decodeOption(nameBytes(hex))

      if (Option.isNone(name)) {
        meter.skips.invalidNames++

        if (child.kind === "directory") meter.skips.invalidNameSubtrees++
        continue
      }

      const path = frame.depth === 0 ? name.value : `${frame.path}/${name.value}`
      const parts = [...frame.parts, name.value]
      const entry: Entry = { path, pathBytes, parts, kind: child.kind, node: child }
      const selection = yield* select(entry)

      // Delay children until the following pull, so a row cap needs no lookahead work.
      if (child.kind === "directory" && !selection.prune) {
        deferred = { node: child, path, pathBytes, parts, depth }
      }

      if (selection.selected) return entry
    }
  })

  return { next }
})
