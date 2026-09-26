import * as Data from "effect/Data"
import * as Encoding from "effect/Encoding"
import * as Order from "effect/Order"
import * as Predicate from "effect/Predicate"
import { bytesOrder, sameBytes } from "./bytes.js"
import type { StoredMetadata } from "./metadata.js"

/** @internal */
export interface ObservationEntry {
  readonly path: Uint8Array
  readonly lineage: string | undefined
  readonly kind: "directory" | "file" | "symlink"
  readonly content: Uint8Array | undefined
  readonly metadata: StoredMetadata
}

type OverlayDifference = "content" | "mode" | "uid" | "gid" | "atimeNs" | "mtimeNs" | "ctimeNs" | "birthtimeNs"

/** @internal */
export type RawOverlayChange =
  | { readonly _tag: "Added"; readonly path: Uint8Array; readonly kind: ObservationEntry["kind"] }
  | { readonly _tag: "Removed"; readonly path: Uint8Array; readonly kind: ObservationEntry["kind"] }
  | {
    readonly _tag: "Replaced"
    readonly path: Uint8Array
    readonly beforeKind: ObservationEntry["kind"]
    readonly afterKind: ObservationEntry["kind"]
    readonly differences: ReadonlyArray<OverlayDifference>
  }
  | {
    readonly _tag: "Renamed"
    readonly from: Uint8Array
    readonly to: Uint8Array
    readonly kind: ObservationEntry["kind"]
    readonly differences: ReadonlyArray<OverlayDifference>
  }
  | {
    readonly _tag: "Updated"
    readonly path: Uint8Array
    readonly kind: ObservationEntry["kind"]
    readonly differences: ReadonlyArray<OverlayDifference>
  }

const RawOverlayChange = Data.taggedEnum<RawOverlayChange>()

const timestampFields = new Set<OverlayDifference>(["atimeNs", "mtimeNs", "ctimeNs", "birthtimeNs"])

const differenceOrder = [
  "content",
  "mode",
  "uid",
  "gid",
  "atimeNs",
  "mtimeNs",
  "ctimeNs",
  "birthtimeNs"
] as const

const tagOrder: Record<RawOverlayChange["_tag"], number> = {
  Added: 0,
  Removed: 1,
  Replaced: 2,
  Renamed: 3,
  Updated: 4
}

const key = Encoding.encodeHex

const sourcePath = (change: RawOverlayChange): Uint8Array =>
  Predicate.isTagged("Renamed")(change) ? change.from : change.path

const changeOrder = Order.combine(
  Order.mapInput(bytesOrder, sourcePath),
  Order.mapInput(Order.Number, (change: RawOverlayChange) => tagOrder[change._tag])
)

const differences = (before: ObservationEntry, after: ObservationEntry, includeTimestamps: boolean) =>
  Object.freeze(differenceOrder.filter((field) => {
    if (!includeTimestamps && timestampFields.has(field)) return false

    // A kind change always counts as a content change, even when the bytes happen to match.
    if (field === "content") return before.kind !== after.kind || !sameBytes(before.content, after.content)

    return before.metadata[field] !== after.metadata[field]
  }))

const byLineage = (entries: ReadonlyArray<ObservationEntry>): Map<string, Map<string, ObservationEntry>> => {
  const result = new Map<string, Map<string, ObservationEntry>>()

  for (const entry of entries) {
    if (entry.lineage === undefined) continue
    const group = result.get(entry.lineage)

    if (group === undefined) result.set(entry.lineage, new Map([[key(entry.path), entry]]))
    else group.set(key(entry.path), entry)
  }

  return result
}

/** @internal */
export const compareOverlay = (
  base: ReadonlyArray<ObservationEntry>,
  current: ReadonlyArray<ObservationEntry>,
  includeTimestamps = false
): ReadonlyArray<RawOverlayChange> => {
  const basePaths = new Map(base.map((entry) => [key(entry.path), entry]))
  const currentPaths = new Map(current.map((entry) => [key(entry.path), entry]))
  const baseLineages = byLineage(base)
  const currentLineages = byLineage(current)
  const renameSources = new Set<string>()
  const renameTargets = new Set<string>()
  const changes: Array<RawOverlayChange> = []

  for (const [lineage, beforeEntries] of baseLineages) {
    const afterEntries = currentLineages.get(lineage)

    if (afterEntries === undefined) continue
    const removed: Array<ObservationEntry> = []

    for (const [pathKey, entry] of beforeEntries) {
      if (!afterEntries.has(pathKey)) removed.push(entry)
    }

    const added: Array<ObservationEntry> = []

    for (const [pathKey, entry] of afterEntries) {
      if (!beforeEntries.has(pathKey)) added.push(entry)
    }

    if (removed.length !== 1 || added.length !== 1) continue
    const before = removed[0]!
    const after = added[0]!
    renameSources.add(key(before.path))
    renameTargets.add(key(after.path))
    changes.push(RawOverlayChange.Renamed({
      from: before.path.slice(),
      to: after.path.slice(),
      kind: after.kind,
      differences: differences(before, after, includeTimestamps)
    }))
  }

  for (const before of base) {
    const pathKey = key(before.path)

    if (renameSources.has(pathKey)) continue
    const after = currentPaths.get(pathKey)

    if (after === undefined || renameTargets.has(pathKey)) {
      changes.push(RawOverlayChange.Removed({ path: before.path.slice(), kind: before.kind }))
      continue
    }

    if (before.lineage === undefined || before.lineage !== after.lineage) {
      changes.push(RawOverlayChange.Replaced({
        path: before.path.slice(),
        beforeKind: before.kind,
        afterKind: after.kind,
        differences: differences(before, after, includeTimestamps)
      }))
      continue
    }

    const changed = differences(before, after, includeTimestamps)

    if (changed.length > 0) {
      changes.push(RawOverlayChange.Updated({ path: before.path.slice(), kind: after.kind, differences: changed }))
    }
  }

  for (const after of current) {
    const pathKey = key(after.path)

    if (!renameTargets.has(pathKey) && (!basePaths.has(pathKey) || renameSources.has(pathKey))) {
      changes.push(RawOverlayChange.Added({ path: after.path.slice(), kind: after.kind }))
    }
  }

  changes.sort(changeOrder)

  // Every record owns its byte buffers and is frozen, so callers may wrap paths without copying.
  return Object.freeze(changes.map((change) => Object.freeze(change)))
}
