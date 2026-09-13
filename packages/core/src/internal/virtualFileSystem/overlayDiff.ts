import * as Encoding from "effect/Encoding"
import * as Equal from "effect/Equal"

/** @internal */
export interface ObservationMetadata {
  readonly uid: number
  readonly gid: number
  readonly mode: number
  readonly atimeNs: string
  readonly mtimeNs: string
  readonly ctimeNs: string
  readonly birthtimeNs: string
}

/** @internal */
export interface ObservationEntry {
  readonly path: Uint8Array
  readonly lineage: string | undefined
  readonly kind: "directory" | "file" | "symlink"
  readonly content: Uint8Array | undefined
  readonly metadata: ObservationMetadata
}

/** @internal */
export type OverlayDifference = "content" | "mode" | "uid" | "gid" | "atimeNs" | "mtimeNs" | "ctimeNs" | "birthtimeNs"

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

const comparePaths = (left: Uint8Array, right: Uint8Array): number => {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const difference = left[index]! - right[index]!
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

const sameBytes = (left: Uint8Array | undefined, right: Uint8Array | undefined): boolean => {
  return Equal.equals(left, right)
}

const differences = (before: ObservationEntry, after: ObservationEntry, includeTimestamps: boolean) =>
  differenceOrder.filter((field) => {
    if (!includeTimestamps && timestampFields.has(field)) return false
    if (field === "content") return before.kind !== after.kind || !sameBytes(before.content, after.content)
    return before.metadata[field] !== after.metadata[field]
  })

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

const copyChange = (change: RawOverlayChange): RawOverlayChange => {
  switch (change._tag) {
    case "Added":
    case "Removed":
      return Object.freeze({ ...change, path: change.path.slice() })
    case "Replaced":
    case "Updated":
      return Object.freeze({
        ...change,
        path: change.path.slice(),
        differences: Object.freeze([...change.differences])
      })
    case "Renamed":
      return Object.freeze({
        ...change,
        from: change.from.slice(),
        to: change.to.slice(),
        differences: Object.freeze([...change.differences])
      })
  }
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
  const consumedBase = new Set<string>()
  const consumedCurrent = new Set<string>()
  const changes: Array<RawOverlayChange> = []

  for (const [lineage, beforeEntries] of baseLineages) {
    const afterEntries = currentLineages.get(lineage)
    if (afterEntries === undefined) continue
    const removed = [...beforeEntries].filter(([pathKey]) => !afterEntries.has(pathKey)).map(([, entry]) => entry)
    const added = [...afterEntries].filter(([pathKey]) => !beforeEntries.has(pathKey)).map(([, entry]) => entry)
    if (removed.length !== 1 || added.length !== 1) continue
    const before = removed[0]!
    const after = added[0]!
    consumedBase.add(key(before.path))
    consumedCurrent.add(key(after.path))
    changes.push({
      _tag: "Renamed",
      from: before.path,
      to: after.path,
      kind: after.kind,
      differences: differences(before, after, includeTimestamps)
    })
  }

  for (const before of base) {
    const pathKey = key(before.path)
    if (consumedBase.has(pathKey)) continue
    const after = currentPaths.get(pathKey)
    if (after === undefined || consumedCurrent.has(pathKey)) {
      changes.push({ _tag: "Removed", path: before.path, kind: before.kind })
      continue
    }
    consumedCurrent.add(pathKey)
    if (before.lineage === undefined || before.lineage !== after.lineage) {
      changes.push({
        _tag: "Replaced",
        path: before.path,
        beforeKind: before.kind,
        afterKind: after.kind,
        differences: differences(before, after, includeTimestamps)
      })
      continue
    }
    const changed = differences(before, after, includeTimestamps)
    if (changed.length > 0) changes.push({ _tag: "Updated", path: before.path, kind: after.kind, differences: changed })
  }

  for (const after of current) {
    const pathKey = key(after.path)
    if (!consumedCurrent.has(pathKey) && (!basePaths.has(pathKey) || consumedBase.has(pathKey))) {
      changes.push({ _tag: "Added", path: after.path, kind: after.kind })
    }
  }

  changes.sort((left, right) => {
    const leftPath = left._tag === "Renamed" ? left.from : left.path
    const rightPath = right._tag === "Renamed" ? right.from : right.path
    const pathOrder = comparePaths(leftPath, rightPath)
    if (pathOrder !== 0) return pathOrder
    const typeOrder = tagOrder[left._tag] - tagOrder[right._tag]
    if (typeOrder !== 0) return typeOrder
    return left._tag === "Renamed" && right._tag === "Renamed" ? comparePaths(left.to, right.to) : 0
  })
  return Object.freeze(changes.map(copyChange))
}
