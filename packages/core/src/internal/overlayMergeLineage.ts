import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import type { Snapshot } from "../Snapshot.js"
import { VfsError } from "../VfsError.js"
import type { DeltaBudget } from "./budget.js"
import { make as makeBytePath } from "./bytePath.js"
import { sameBytes } from "./bytes.js"
import { imageFailure } from "./errors.js"
import * as Image from "./image.js"
import * as Merkle from "./merkle.js"
import { Errors, Paths, State } from "./model.js"
import * as Delta from "./snapshotDelta.js"
import { getMergeCapture, type MergeCapture } from "./virtualFileSystem.js"

const { argumentFailure } = Errors

const { getNode } = State

type Node = State.Node

type VolumeState = State.VolumeState

type Side = "ours" | "theirs"

const SIDES: ReadonlyArray<Side> = ["ours", "theirs"]

/** @internal */
export const OVERLAY_OPERATION = "mergeOverlayCaptures"

const lookupNode = (value: VolumeState, path: Uint8Array): Node | undefined =>
  Delta.lookup((ino) => getNode(value, ino), Delta.valueEntries, path)?.node

/** @internal */
export interface RenameGroup {
  readonly source: Uint8Array
  ours?: Uint8Array
  theirs?: Uint8Array
}

const unsupportedMove = (reason: string, path: Uint8Array) =>
  new VfsError({
    code: "InvalidStructure",
    operation: OVERLAY_OPERATION,
    field: reason,
    path: makeBytePath(path.slice())
  })

const retainsParents = (before: VolumeState, after: VolumeState, path: Uint8Array) => {
  let dir = getNode(before, State.ROOT_INO)

  for (const component of Delta.splitNames(path).slice(0, -1)) {
    if (dir?.kind !== "directory") return false
    const ino = dir.entries.get(component)
    const current = getNode(after, dir.ino)

    if (ino === undefined || current?.kind !== "directory" || current.entries.get(component) !== ino) return false
    dir = getNode(before, ino)
  }

  return dir?.kind === "directory" && getNode(after, dir.ino)?.kind === "directory"
}

/** @internal */
export const prepareCapture = Effect.fnUntraced(function*(
  capture: MergeCapture,
  base: Snapshot,
  identity: Merkle.Identity,
  limits: DeltaBudget
) {
  const trusted = getMergeCapture(capture)

  if (trusted === undefined) return yield* argumentFailure(OVERLAY_OPERATION, "capture")

  const original = yield* Image.valueOf(trusted.base)

  const originalIdentity = trusted.base === base
    ? identity
    : yield* Merkle.identify(original, Delta.baseBudget(limits))

  if (!sameBytes(identity.digest, originalIdentity.digest)) {
    return yield* new VfsError({ code: "BaseMismatch", operation: OVERLAY_OPERATION })
  }

  const state = yield* Image.valueOf(trusted.target)
  const target = yield* Merkle.identify(state, Delta.targetBudget(limits))

  return { original, originalIdentity, state, target }
})

/** @internal */
export type PreparedCapture = Effect.Success<ReturnType<typeof prepareCapture>>

const nameOf = (state: VolumeState, link: State.Link) => {
  const components = [Paths.nameBytes(link.name)]
  let bytes = components[0]!.length + 1
  let parent = getNode(state, link.parent)

  while (parent?.kind === "directory" && parent.ino !== State.ROOT_INO) {
    const name = Paths.nameBytes(parent.name)
    bytes += name.length + 1
    components.push(name)
    parent = getNode(state, parent.parent)
  }

  const result = new Uint8Array(bytes)
  let offset = 0

  for (let index = components.length - 1; index >= 0; index--) {
    const component = components[index]!
    result[offset++] = Paths.SLASH_BYTE
    result.set(component, offset)
    offset += component.length
  }

  return result
}

const firstMissingLink = (links: ReadonlyArray<State.Link>, other: ReadonlyArray<State.Link>) => {
  if (links.length === 1 && other.length === 1) {
    return links[0]!.parent === other[0]!.parent && links[0]!.name === other[0]!.name ? undefined : links[0]
  }

  const keys = new Set(other.map(({ parent, name }) => `${parent}:${name}`))

  return links.find(({ parent, name }) => !keys.has(`${parent}:${name}`))
}

/** @internal */
export const collectGroups = Effect.fnUntraced(function*(
  ours: PreparedCapture,
  theirs: PreparedCapture,
  limits: DeltaBudget
) {
  const groups = new Map<string, RenameGroup>()
  const destinations = new Map<string, string>()
  let pathBytes = 0

  for (const side of SIDES) {
    const { original, originalIdentity, state } = side === "ours" ? ours : theirs
    let scanned = 0

    for (const ino of originalIdentity.digests.keys()) {
      if (scanned++ % State.WALK_YIELD_INTERVAL === 0) yield* Effect.yieldNow

      if (ino === State.ROOT_INO) continue
      const before = getNode(original, ino)!
      const after = getNode(state, ino)

      if (after === undefined) continue

      const links = before.kind === "directory" ? [before] : before.links
      const afterLinks = after.kind === "directory" ? [after] : after.links

      // Pure alias additions and removals keep ordinary delta semantics. Exchanging names
      // with more than one link on either side is ambiguous.
      const removedLink = firstMissingLink(links, afterLinks)
      const addedLink = firstMissingLink(afterLinks, links)

      if (removedLink === undefined || addedLink === undefined) continue

      const removed = nameOf(original, removedLink)

      if (links.length !== 1 || afterLinks.length !== 1 || before.kind !== "file" || after.kind !== "file") {
        return yield* unsupportedMove("renameLineage", removed)
      }

      const added = nameOf(state, addedLink)

      if (lookupNode(original, added) !== undefined || lookupNode(state, removed) !== undefined) {
        return yield* unsupportedMove("renameOverlap", removed)
      }

      const sourceKey = Delta.key(removed)
      const destinationKey = Delta.key(added)
      const group = groups.get(sourceKey)
      const owner = destinations.get(destinationKey)

      if (owner !== undefined && owner !== sourceKey) return yield* unsupportedMove("renameOverlap", added)

      if (group === undefined) {
        if (groups.size === limits.records) {
          return yield* imageFailure(OVERLAY_OPERATION, "LimitExceeded", { field: "renameGroups" })
        }

        pathBytes += removed.length
      }

      if (owner === undefined) pathBytes += added.length

      if (
        groups.size + Number(group === undefined) + destinations.size + Number(owner === undefined) > limits.entries
      ) {
        return yield* imageFailure(OVERLAY_OPERATION, "LimitExceeded", { field: "renamePaths" })
      }

      if (ByteSize.isGreaterThan(ByteSize.bytes(pathBytes), limits.decodedBytes)) {
        return yield* imageFailure(OVERLAY_OPERATION, "LimitExceeded", { field: "renamePathBytes" })
      }

      const next = group ?? { source: removed }
      next[side] = added
      groups.set(sourceKey, next)
      destinations.set(destinationKey, sourceKey)
    }
  }

  return groups
})

/** @internal */
export interface LocalNodes {
  readonly atSource: Node | undefined
  readonly node: Node | undefined
  readonly addition: { readonly path: Uint8Array; readonly node: Node } | undefined
}

/** @internal */
export const localNodes = (
  capture: PreparedCapture,
  group: RenameGroup,
  side: Side
): Result.Result<LocalNodes, VfsError> => {
  const destination = group[side]
  const atSource = lookupNode(capture.state, group.source)
  const base = lookupNode(capture.original, group.source)!
  const node = destination === undefined ? atSource : lookupNode(capture.state, destination)

  if (
    !retainsParents(capture.original, capture.state, group.source) ||
    (atSource !== undefined && atSource.ino !== base.ino) ||
    (node !== undefined && (node.kind !== "file" || node.links.length !== 1))
  ) return Result.fail(unsupportedMove("renameSource", group.source))

  let addition: LocalNodes["addition"]

  for (const path of [group.ours, group.theirs]) {
    if (path === undefined) continue

    if (!retainsParents(capture.original, capture.state, path)) {
      return Result.fail(unsupportedMove("renameParent", path))
    }

    if (destination !== undefined && sameBytes(destination, path)) continue
    const atPath = lookupNode(capture.state, path)

    if (atPath === undefined) continue

    if (
      atSource === undefined || atPath.kind !== "file" || atPath.links.length !== 1 ||
      getNode(capture.original, atPath.ino) !== undefined
    ) return Result.fail(unsupportedMove("renameDestination", path))

    addition = { path, node: atPath }
  }

  return Result.succeed({ atSource, node, addition })
}
