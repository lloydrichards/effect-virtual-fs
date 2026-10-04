import * as Predicate from "effect/Predicate"
import type { FsFailure } from "../VfsError.js"
import { Change } from "../Watch.js"
import { getBytes } from "./bytePath.js"
import { fsFailure } from "./errors.js"
import { nameBytes, ownedPath, SLASH_HEX } from "./path.js"
import { getNode, type Ino, type Link, ROOT_INO, type VolumeState } from "./volumeState.js"
import type { Selection } from "./watchHub.js"

/** @internal */
export interface WatchEvent {
  readonly change: Change
  readonly parent: Ino
  readonly ino: Ino
  readonly name?: string
}

/** @internal */
export interface Rename {
  readonly ino: Ino
  readonly from: Link
  readonly to: Link
}

/** @internal */
export interface Installation {
  readonly before: VolumeState
  readonly after: VolumeState
  readonly renames?: ReadonlyArray<Rename>
}

const directoryPath = (state: VolumeState, ino: Ino): string | undefined => {
  const names: Array<string> = []
  const visited = new Set<Ino>()
  let at = ino

  for (;;) {
    if (visited.has(at)) return undefined
    visited.add(at)
    const directory = getNode(state, at)

    if (directory?.kind !== "directory" || directory.metadata.nlink === 0) return undefined

    if (at === ROOT_INO) return SLASH_HEX + names.reverse().join(SLASH_HEX)
    names.push(directory.name)
    at = directory.parent
  }
}

const below = (path: string, root: string): boolean =>
  root === SLASH_HEX || path === root || path.startsWith(root + SLASH_HEX)

const rebase = (path: string, root: string): string =>
  root === SLASH_HEX ? path : path === root ? SLASH_HEX : path.slice(root.length)

const entryPath = (state: VolumeState, link: Link): string | undefined => {
  const parent = directoryPath(state, link.parent)

  return parent === undefined ? undefined : parent + (parent === SLASH_HEX ? "" : SLASH_HEX) + link.name
}

const paths = (state: VolumeState, target: Ino): Array<string> => {
  const node = getNode(state, target)

  if (node === undefined || node.metadata.nlink === 0) return []

  if (node.kind === "directory") {
    const path = directoryPath(state, target)

    return path === undefined ? [] : [path]
  }

  return node.links.flatMap((link) => {
    const directory = getNode(state, link.parent)

    const path = directory?.kind === "directory" && directory.entries.get(link.name) === target
      ? entryPath(state, link)
      : undefined

    return path === undefined ? [] : [path]
  })
}

const rootPath = (state: VolumeState, roots: ReadonlyArray<Ino>): string | FsFailure => {
  let previous = SLASH_HEX

  for (const root of roots) {
    const path = directoryPath(state, root)

    if (path === undefined) return fsFailure("ClosedCaller", "watch")

    if (!below(path, previous)) return fsFailure("AccessDenied", "watch")
    previous = path
  }

  return previous
}

const eventName = (event: WatchEvent): string => {
  if (event.name !== undefined) return event.name
  const bytes = getBytes(event.change.path)!
  const last = bytes.lastIndexOf(47)

  return Array.from(bytes.subarray(last + 1), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** Select and rebase names while publication holds both installed namespace states. @internal */
export const make = (options: {
  readonly roots: ReadonlyArray<Ino>
  readonly additionalRoots?: ReadonlyArray<ReadonlyArray<Ino>>
  readonly target: Ino
  readonly recursive: boolean
  readonly selected?: Link
}): Selection<WatchEvent, Installation, FsFailure> => {
  let selected = options.selected
  let oldSelected = selected
  let failure: FsFailure | undefined
  let previousRoot = SLASH_HEX
  let currentRoot = SLASH_HEX
  let terminal: Array<string> | undefined
  let rescanPath = SLASH_HEX

  const visible = (state: VolumeState, root: string, selection: Link | undefined): Array<string> => {
    const aliases = paths(state, options.target)

    for (const chain of options.additionalRoots ?? []) {
      const boundary = rootPath(state, chain)

      if (!Predicate.isString(boundary) || !aliases.some((path) => below(path, boundary))) return []
    }

    return aliases.filter((path) =>
      below(path, root) && (selection === undefined || path === entryPath(state, selection))
    )
  }

  return {
    boundedTerminal: true,
    prepare: ({ before, after, renames }) => {
      terminal = undefined
      oldSelected = selected
      const beforeRoot = rootPath(before, options.roots)
      const afterRoot = rootPath(after, options.roots)

      for (const chain of options.additionalRoots ?? []) {
        const boundary = rootPath(after, chain)

        if (!Predicate.isString(boundary)) {
          failure = boundary

          return
        }
      }

      if (!Predicate.isString(afterRoot)) {
        failure = afterRoot

        return
      }

      if (!Predicate.isString(beforeRoot)) return
      previousRoot = beforeRoot
      currentRoot = afterRoot

      for (const rename of renames ?? []) {
        if (
          rename.ino === options.target && selected !== undefined && selected.parent === rename.from.parent &&
          selected.name === rename.from.name
        ) selected = rename.to
      }

      const oldPaths = visible(before, previousRoot, oldSelected)
      const nextPaths = visible(after, currentRoot, selected)
      rescanPath = rebase(nextPaths[0] ?? oldPaths[0] ?? currentRoot, nextPaths.length > 0 ? currentRoot : previousRoot)

      if (nextPaths.length === 0) terminal = oldPaths.map((path) => rebase(path, previousRoot))
    },
    includes: () => failure === undefined,
    project: (event, { before, after }) => {
      if (failure !== undefined) return undefined

      if (
        terminal === undefined && event.ino !== options.target && Predicate.isTagged(event.change, "Create")
      ) {
        const name = eventName(event)
        const parent = getNode(before, event.parent)
        const replacedPath = entryPath(before, { parent: event.parent, name })

        // Rename publishes the incoming object; its replaced alias needs the old target's removal.
        if (
          parent?.kind === "directory" && parent.entries.get(name) === options.target &&
          replacedPath !== undefined && visible(before, previousRoot, oldSelected).includes(replacedPath)
        ) {
          return {
            ...event,
            ino: options.target,
            change: Change.cases.Remove.make({ path: ownedPath(nameBytes(rebase(replacedPath, previousRoot))) })
          }
        }
      }

      const removed = Predicate.isTagged(event.change, "Remove")
      const installed = removed ? before : after
      const root = removed ? previousRoot : currentRoot
      const selection = removed ? oldSelected : selected
      let path: string | undefined
      const node = getNode(installed, event.ino)

      if (event.ino === options.target) {
        // Settlement emits the terminal removals once, behind already queued changes.
        if (removed && terminal !== undefined) return undefined
        path = node?.kind === "directory"
          ? directoryPath(installed, event.ino)
          : entryPath(installed, { parent: event.parent, name: eventName(event) })

        if (selection !== undefined && path !== entryPath(installed, selection)) return undefined
      } else {
        const scopes = visible(installed, root, selection)
        path = entryPath(installed, { parent: event.parent, name: eventName(event) })

        if (
          path === undefined || !scopes.some((scope) => {
            if (!below(path!, scope)) return false

            if (options.recursive) return true

            return directoryPath(installed, event.parent) === scope
          })
        ) return undefined
      }

      if (path === undefined || !below(path, root)) return undefined

      // A confinement root's outside parent is never reported as a rename.
      if (event.ino === options.roots.at(-1) && !Predicate.isTagged(event.change, "Update")) return undefined

      return {
        ...event,
        change: Change.cases[event.change._tag].make({ path: ownedPath(nameBytes(rebase(path, root))) })
      }
    },
    rescan: () => ({
      change: Change.cases.Rescan.make({ path: ownedPath(nameBytes(rescanPath)) }),
      parent: options.target,
      ino: options.target
    }),
    failure: () => failure,
    settle: () =>
      terminal?.map((path) => ({
        change: Change.cases.Remove.make({ path: ownedPath(nameBytes(path)) }),
        parent: options.target,
        ino: options.target
      }))
  }
}
