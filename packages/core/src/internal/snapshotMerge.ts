import * as Arr from "effect/Array"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Order from "effect/Order"
import * as Result from "effect/Result"
import type { Snapshot } from "../Snapshot.js"
import {
  type MergeConflict,
  type MergeConflictReason,
  type MergeResolution,
  MergeSideChange,
  type MergeTake,
  type SnapshotDelta,
  type SnapshotDifference,
  type SnapshotNodeKind
} from "../SnapshotDelta.js"
import type { DeltaBudget } from "./budget.js"
import { getBytes, make as makeBytePath } from "./bytePath.js"
import { bytesOrder, sameBytes } from "./bytes.js"
import { CanonicalBase64 } from "./canonicalBase64.js"
import { argumentFailure, imageFailure } from "./errors.js"
import * as Image from "./image.js"
import * as Merkle from "./merkle.js"
import type { StoredMetadata } from "./metadata.js"
import * as Delta from "./snapshotDelta.js"
import * as SnapshotDeltaModel from "./snapshotDeltaModel.js"
import { UNCHECKED } from "./tree.js"
import { getNode, type Ino, type Node, payloadOf, storedMetadata, type VolumeState } from "./volumeState.js"

const OPERATION = "mergeSnapshotDeltas"

type Change = Delta.Change

type Take = MergeTake

type Side = "ours" | "theirs"

const SIDES: ReadonlyArray<Side> = ["ours", "theirs"]

const other = (side: Side): Side => (side === "ours" ? "theirs" : "ours")

// Path keys are the hex of the raw path bytes, so their lexicographic order is the byte order of the paths and every
// path beneath a directory shares the directory's key followed by the hex of "/".
const SLASH_HEX = "2f"
const ROOT_KEY = SLASH_HEX
const AFTER_SLASH_HEX = "2g"

const METADATA_FIELDS = ["mode", "uid", "gid"] as const
const TIME_FIELDS = ["atimeNs", "mtimeNs", "ctimeNs", "birthtimeNs"] as const

type TimeField = (typeof TIME_FIELDS)[number]

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const isTimeField = (field: SnapshotDifference): field is TimeField => Delta.timestampFields.has(field)

// A node as a side leaves it, without the names that reach it.
interface Resolved {
  readonly kind: SnapshotNodeKind
  readonly metadata: StoredMetadata
  // Undefined for directories.
  readonly payload: Uint8Array | undefined
}

const resolve = (node: Node): Resolved => ({
  kind: node.kind,
  metadata: storedMetadata(node.metadata),
  payload: payloadOf(node)
})

const sameMetadata = (left: Resolved, right: Resolved) =>
  METADATA_FIELDS.every((field) => left.metadata[field] === right.metadata[field])

// Equal apart from timestamps, which never dispute anything.
const sameNode = (left: Resolved, right: Resolved) =>
  left.kind === right.kind && sameMetadata(left, right) && sameBytes(left.payload, right.payload)

const maxTime = (left: bigint, right: bigint) => (left > right ? left : right)

// The names of one node in a side's final tree, with the node itself. Side-local inode numbers identify classes.
interface Class {
  readonly ino: Ino
  readonly names: ReadonlyArray<string>
  readonly node: Resolved
}

interface Input {
  readonly side: Side
  readonly state: VolumeState
  readonly changes: ReadonlyMap<string, Change>
  readonly paths: ReadonlyMap<string, Uint8Array>
  readonly sorted: ReadonlyArray<string>
  // Side-local inode of every changed path that is present in the side's tree.
  readonly inoAt: ReadonlyMap<string, Ino>
  readonly classes: ReadonlyMap<Ino, Class>
  // Directories the side removed or replaced by another kind, as path keys.
  readonly eliminated: ReadonlyArray<string>
}

interface Base {
  readonly value: VolumeState
  readonly identity: Merkle.Identity
  readonly side: Delta.Side
  readonly paths: ReadonlyMap<string, Uint8Array>
  readonly nodeAt: (pathKey: string) => Node | undefined
  // Every base name of an inode either side touched, as sorted path keys.
  readonly namesOf: ReadonlyMap<Ino, ReadonlyArray<string>>
}

interface ConflictRecord {
  readonly pathKey: string
  readonly reason: MergeConflictReason
  // What to report for a side that acted at another path, such as the directory it removed above this one.
  readonly sides?: { readonly [K in Side]?: Change }
}

interface Scope {
  readonly paths: Set<string>
  readonly records: Array<ConflictRecord>
  // The record paths, for constant-time deduplication when scopes merge.
  readonly recorded: Set<string>
}

// What a path finally holds when nothing disputes it.
type Decision = Data.TaggedEnum<{
  // A node shared by every path of one lineage; the lineage id groups them at emission.
  Node: { readonly lineage: string; readonly node: Resolved }
  Removed: {}
}>

const Decision = Data.taggedEnum<Decision>()

const { Unchanged, Added, Removed, Updated } = MergeSideChange.cases

const sideChange = (change: Change | undefined): MergeSideChange => {
  if (change === undefined) return Unchanged.make({}, UNCHECKED)

  return Delta.Change.match(change, {
    Added: ({ kind }): MergeSideChange => Added.make({ kind }, UNCHECKED),
    Removed: ({ kind }): MergeSideChange => Removed.make({ kind }, UNCHECKED),
    Updated: ({ beforeKind, afterKind, differences }): MergeSideChange => {
      const meaningful = differences.filter((field) => !isTimeField(field))

      return meaningful.length === 0
        ? Unchanged.make({}, UNCHECKED)
        : Updated.make({ beforeKind, afterKind, differences: meaningful }, UNCHECKED)
    }
  })
}

const isTimestampsOnly = (change: Change) =>
  Delta.Change.guards.Updated(change) && change.differences.every(isTimeField)

const hasKindChange = (change: Change) => Delta.Change.guards.Updated(change) && change.differences.includes("kind")

const bisect = (sorted: ReadonlyArray<string>, key: string) => {
  let low = 0
  let high = sorted.length

  while (low < high) {
    const middle = (low + high) >>> 1

    if (sorted[middle]! < key) low = middle + 1
    else high = middle
  }

  return low
}

// The keys strictly beneath a directory, as a contiguous slice of a sorted key list.
const beneath = (sorted: ReadonlyArray<string>, root: string): ReadonlyArray<string> => {
  if (root === ROOT_KEY) return sorted.filter((key) => key !== ROOT_KEY)
  const prefix = root + SLASH_HEX

  return sorted.slice(bisect(sorted, prefix), bisect(sorted, root + AFTER_SLASH_HEX))
}

const isBeneath = (pathKey: string, root: string) =>
  root === ROOT_KEY ? pathKey !== ROOT_KEY : pathKey.startsWith(root + SLASH_HEX)

const lookupNode = (value: VolumeState, path: Uint8Array): Node | undefined =>
  Delta.lookup((ino) => getNode(value, ino), Delta.valueEntries, path)?.node

const indexSide = (side: Side, document: Delta.Document, state: VolumeState, base: VolumeState): Input => {
  const changes = new Map<string, Change>()
  const paths = new Map<string, Uint8Array>()
  const inoAt = new Map<string, Ino>()
  const members = new Map<Ino, { names: Array<string>; node: Node }>()
  const eliminated: Array<string> = []

  for (const change of document.changes) {
    const path = CanonicalBase64.toBytes(change.path)
    const pathKey = Delta.key(path)
    changes.set(pathKey, change)
    paths.set(pathKey, path)
    const before = lookupNode(base, path)
    const after = Delta.Change.guards.Removed(change) ? undefined : lookupNode(state, path)

    if (before?.kind === "directory" && after?.kind !== "directory") eliminated.push(pathKey)

    if (after === undefined || after.kind === "directory") continue
    inoAt.set(pathKey, after.ino)
    const group = members.get(after.ino) ?? { names: [], node: after }
    group.names.push(pathKey)
    members.set(after.ino, group)
  }

  const sorted = Arr.sort(paths.keys(), Order.String)
  const classes = new Map<Ino, Class>()

  for (const [ino, group] of members) {
    classes.set(ino, { ino, names: Arr.sort(group.names, Order.String), node: resolve(group.node) })
  }

  return { side, state, changes, paths, sorted, inoAt, classes, eliminated: Arr.sort(eliminated, Order.String) }
}

const indexBase = (value: VolumeState, identity: Merkle.Identity, inputs: ReadonlyArray<Input>): Base => {
  const nodes = new Map<string, Node | undefined>()
  const paths = new Map<string, Uint8Array>()

  for (const input of inputs) for (const [pathKey, path] of input.paths) paths.set(pathKey, path)

  for (const group of identity.groups.values()) for (const path of group) paths.set(Delta.key(path), path)

  const nodeAt = (pathKey: string) => {
    if (nodes.has(pathKey)) return nodes.get(pathKey)
    const path = paths.get(pathKey)
    const node = path === undefined ? undefined : lookupNode(value, path)
    nodes.set(pathKey, node)

    return node
  }

  const namesOf = new Map<Ino, ReadonlyArray<string>>()

  for (const [ino, group] of identity.groups) namesOf.set(ino, Arr.sort(group.map(Delta.key), Order.String))

  for (const input of inputs) {
    for (const pathKey of input.sorted) {
      const node = nodeAt(pathKey)

      if (node !== undefined && node.kind !== "directory" && !namesOf.has(node.ino)) namesOf.set(node.ino, [pathKey])
    }
  }

  return { value, identity, side: Delta.side(value, identity), paths, nodeAt, namesOf }
}

interface Combined {
  readonly node: Resolved
  readonly clashes: ReadonlyArray<SnapshotDifference>
}

// Combine what two sides made of one base node, field by field. A field both sides set to different values is a
// clash; timestamps never clash and take the later value. A side that left the node alone passes the base.
const combine = (before: Resolved, ours: Resolved, theirs: Resolved): Combined => {
  const clashes: Array<SnapshotDifference> = []
  const metadata: Mutable<StoredMetadata> = { ...before.metadata }

  for (const field of METADATA_FIELDS) {
    const inO = ours.metadata[field] !== before.metadata[field]
    const inT = theirs.metadata[field] !== before.metadata[field]

    if (inO && inT && ours.metadata[field] !== theirs.metadata[field]) clashes.push(field)
    metadata[field] = inO ? ours.metadata[field] : inT ? theirs.metadata[field] : before.metadata[field]
  }

  for (const field of TIME_FIELDS) {
    const inO = ours.metadata[field] !== before.metadata[field]
    const inT = theirs.metadata[field] !== before.metadata[field]
    metadata[field] = inO && inT
      ? maxTime(ours.metadata[field], theirs.metadata[field])
      : inO
      ? ours.metadata[field]
      : inT
      ? theirs.metadata[field]
      : before.metadata[field]
  }

  const inO = !sameBytes(ours.payload, before.payload)
  const inT = !sameBytes(theirs.payload, before.payload)

  if (inO && inT && !sameBytes(ours.payload, theirs.payload)) clashes.push(Delta.payloadDifference(before.kind))
  const payload = inO ? ours.payload : inT ? theirs.payload : before.payload

  return { node: { kind: before.kind, metadata, payload }, clashes }
}

// Two nodes both sides wrote afresh agree when everything but their timestamps matches.
const combineFresh = (ours: Resolved, theirs: Resolved): Resolved | undefined => {
  if (!sameNode(ours, theirs)) return undefined
  const metadata: Mutable<StoredMetadata> = { ...ours.metadata }

  for (const field of TIME_FIELDS) metadata[field] = maxTime(ours.metadata[field], theirs.metadata[field])

  return { ...ours, metadata }
}

// How one side left a base node: untouched, gone, split so that no class can claim it, or one class of names.
type View = Data.TaggedEnum<{
  Untouched: {}
  Removed: {}
  Ambiguous: {}
  Kept: { readonly class: Class }
}>

const View = Data.taggedEnum<View>()

const sameNames = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((name, index) => name === right[index])

const isSubset = (left: ReadonlyArray<string>, right: ReadonlySet<string>) => left.every((name) => right.has(name))

const mergeNames = (
  base: ReadonlyArray<string>,
  ours: ReadonlyArray<string>,
  theirs: ReadonlyArray<string>
): Result.Result<ReadonlyArray<string>, "HardLinkGroupDiverged"> => {
  if (sameNames(ours, base)) return Result.succeed(theirs)

  if (sameNames(theirs, base) || sameNames(ours, theirs)) return Result.succeed(ours)

  const baseSet = new Set(base)

  // Both sides only unlinked names; the removals add up.
  return isSubset(ours, baseSet) && isSubset(theirs, baseSet)
    ? Result.succeed(ours.filter((name) => theirs.includes(name)))
    : Result.fail("HardLinkGroupDiverged")
}

// Union-find over base inodes that any side's class ties together.
const components = (base: Base, inputs: ReadonlyArray<Input>, touched: ReadonlySet<Ino>) => {
  const parent = new Map<Ino, Ino>()

  const find = (ino: Ino): Ino => {
    let root = ino

    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!

    return root
  }

  const union = (left: Ino, right: Ino) => {
    const a = find(left)
    const b = find(right)

    if (a !== b) parent.set(a, b)
  }

  for (const ino of touched) parent.set(ino, ino)

  // Every name a class holds ties that class's base nodes together, and a name two sides give to different nodes
  // ties those nodes too, so a conflict on any of them keeps all of them at base.
  const byName = new Map<string, Ino>()

  for (const input of inputs) {
    for (const cls of input.classes.values()) {
      const inodes = cls.names.flatMap((name) => {
        const before = base.nodeAt(name)

        return before === undefined || before.kind === "directory" ? [] : [before.ino]
      })

      if (!Arr.isArrayNonEmpty(inodes)) continue
      const first = inodes[0]

      for (const ino of inodes) union(first, ino)

      for (const name of cls.names) {
        const known = byName.get(name)

        if (known === undefined) byName.set(name, first)
        else union(known, first)
      }
    }
  }

  return find
}

interface Classified {
  readonly decisions: Map<string, Decision>
  readonly scopes: Array<Scope>
}

const classify = (base: Base, ours: Input, theirs: Input): Classified => {
  const inputs = { ours, theirs }
  const paths = new Map<string, Uint8Array>([...ours.paths, ...theirs.paths])
  const union = Arr.sort(paths.keys(), Order.String)
  const decisions = new Map<string, Decision>()
  const scopes: Array<Scope> = []

  const changeAt = (side: Side, pathKey: string) => inputs[side].changes.get(pathKey)

  const open = (affected: Iterable<string>, records: ReadonlyArray<ConflictRecord>) => {
    scopes.push({
      paths: new Set(affected),
      records: [...records],
      recorded: new Set(records.map((record) => record.pathKey))
    })
  }

  // Base inodes either side touched, and how each side left them.
  const touched = new Set<Ino>()

  for (const input of [ours, theirs]) {
    for (const pathKey of input.sorted) {
      const before = base.nodeAt(pathKey)

      if (before !== undefined && before.kind !== "directory") touched.add(before.ino)
    }
  }

  // Which base node a side's class is: the node whose name still carries its bytes, else the only node whose kept
  // names it holds. A class holding kept names of several nodes and none of their bytes is contested.
  const CONTESTED = Symbol("contested")
  const ownerOf = new Map<Input, Map<Ino, Ino | typeof CONTESTED | undefined>>()

  for (const input of [ours, theirs]) {
    const owners = new Map<Ino, Ino | typeof CONTESTED | undefined>()
    const kepts = new Map<Ino, ReadonlySet<Ino>>()

    for (const cls of input.classes.values()) {
      const keptOf = new Set<Ino>()
      const inheriting = new Set<Ino>()

      for (const name of cls.names) {
        const before = base.nodeAt(name)
        const change = input.changes.get(name)

        if (before === undefined || before.kind === "directory" || change === undefined || hasKindChange(change)) {
          continue
        }

        keptOf.add(before.ino)

        if (sameBytes(payloadOf(before), cls.node.payload)) inheriting.add(before.ino)
      }

      owners.set(
        cls.ino,
        inheriting.size === 1
          ? [...inheriting][0]
          : keptOf.size === 1
          ? [...keptOf][0]
          : keptOf.size === 0
          ? undefined
          : CONTESTED
      )
      kepts.set(cls.ino, keptOf)
    }

    // A contested class whose other candidate nodes are already owned by sibling classes belongs to the one left.
    const owned = new Set<Ino | typeof CONTESTED | undefined>(owners.values())
    owned.delete(CONTESTED)
    owned.delete(undefined)

    for (const [ino, owner] of owners) {
      if (owner !== CONTESTED) continue
      const free = [...kepts.get(ino)!].filter((candidate) => !owned.has(candidate))

      if (free.length === 1) owners.set(ino, free[0])
    }

    ownerOf.set(input, owners)
  }

  const view = (input: Input, ino: Ino): View => {
    const names = base.namesOf.get(ino)!
    const untouched = names.filter((name) => !input.changes.has(name))

    if (untouched.length === names.length) return View.Untouched()

    const kept = names.filter((name) => {
      const change = input.changes.get(name)

      return change !== undefined && !Delta.Change.guards.Removed(change) && !hasKindChange(change)
    })

    // A side that touched this node lists every name of it, so names it left alone still hold the base node.
    if (untouched.length > 0) {
      if (kept.length > 0) return View.Ambiguous()
      const node = lookupNode(input.state, base.paths.get(untouched[0]!)!)!

      return View.Kept({ class: { ino: node.ino, names: untouched, node: resolve(node) } })
    }

    if (kept.length === 0) return View.Removed()
    const candidates = new Map<Ino, Class>()
    let contested = false

    for (const name of kept) {
      const cls = input.classes.get(input.inoAt.get(name)!)!
      const owner = ownerOf.get(input)!.get(cls.ino)

      if (owner === CONTESTED) contested = true
      else if (owner === ino) candidates.set(cls.ino, cls)
    }

    if (contested) return View.Ambiguous()

    if (candidates.size > 1) {
      // Several classes carry this node's names; the one still holding its bytes is the node, the rest are replacements.
      const inheriting = [...candidates.values()].filter((cls) =>
        cls.names.some((name) => kept.includes(name) && sameBytes(payloadOf(base.nodeAt(name)!), cls.node.payload))
      )

      return inheriting.length === 1 ? View.Kept({ class: inheriting[0]! }) : View.Ambiguous()
    }

    return candidates.size === 1 ? View.Kept({ class: [...candidates.values()][0]! }) : View.Removed()
  }

  // Two sides that left a node in exactly the same classes agree, however those classes relate to the node.
  const identicalClasses = (ino: Ino) =>
    base.namesOf.get(ino)!.every((name) => {
      const o = ours.inoAt.get(name)
      const t = theirs.inoAt.get(name)

      if (o === undefined || t === undefined) return o === t && ours.changes.has(name) === theirs.changes.has(name)
      const cO = ours.classes.get(o)!
      const cT = theirs.classes.get(t)!

      return sameNames(cO.names, cT.names) && sameNode(cO.node, cT.node)
    })

  const find = components(base, [ours, theirs], touched)
  const componentPaths = new Map<Ino, Set<string>>()
  const componentOf = new Map<string, Ino>()

  const place = (root: Ino, pathKey: string) => {
    const set = componentPaths.get(root) ?? new Set<string>()
    set.add(pathKey)
    componentPaths.set(root, set)
    componentOf.set(pathKey, root)
  }

  const classesAt = new Map<Ino, Array<Class>>()

  for (const input of [ours, theirs]) {
    for (const cls of input.classes.values()) {
      const seen = new Set<Ino>()

      for (const name of cls.names) {
        const before = base.nodeAt(name)

        if (before === undefined || before.kind === "directory" || seen.has(before.ino)) continue
        seen.add(before.ino)
        const list = classesAt.get(before.ino) ?? []
        list.push(cls)
        classesAt.set(before.ino, list)
      }
    }
  }

  for (const ino of touched) {
    const root = find(ino)

    for (const name of base.namesOf.get(ino)!) place(root, name)

    for (const cls of classesAt.get(ino) ?? []) for (const name of cls.names) place(root, name)
  }

  const eliminatedAbove = (side: Side, pathKey: string) =>
    inputs[side].eliminated.find((root) => root !== pathKey && isBeneath(pathKey, root))

  // How a side that no longer holds a name gave it up: with the directory above it, by changing its kind, or alone.
  const removalRecord = (removing: Side, pathKey: string, fallback: MergeConflictReason): ConflictRecord => {
    const change = inputs[removing].changes.get(pathKey)

    if (change !== undefined && hasKindChange(change)) return { pathKey, reason: "KindDiverged" }
    const root = eliminatedAbove(removing, pathKey)

    if (root !== undefined && (change === undefined || Delta.Change.guards.Removed(change))) {
      return { pathKey, reason: "ParentRemoved", sides: { [removing]: inputs[removing].changes.get(root)! } }
    }

    return { pathKey, reason: fallback }
  }

  // Which classes the inode decisions claimed; the rest are fresh nodes a side wrote.
  const claimed = { ours: new Set<Ino>(), theirs: new Set<Ino>() }

  const inodeRecords = (names: ReadonlyArray<string>, reason: MergeConflictReason): ReadonlyArray<ConflictRecord> =>
    names.map((pathKey) => ({ pathKey, reason }))

  // Base names a node no longer holds; they are removed unless another node or a fresh node takes the name.
  const vacated = new Set<string>()

  for (const ino of touched) {
    const names = base.namesOf.get(ino)!
    const before = resolve(base.nodeAt(names[0]!)!)
    const vO = view(ours, ino)
    const vT = view(theirs, ino)

    if (View.$is("Kept")(vO)) claimed.ours.add(vO.class.ino)

    if (View.$is("Kept")(vT)) claimed.theirs.add(vT.class.ino)

    if (View.$is("Untouched")(vO) && View.$is("Untouched")(vT)) continue
    const component = componentPaths.get(find(ino))!
    const lineage = `m:${ino}`

    // A name two nodes both end up holding was re-pointed differently by the two sides.
    const settle = (finalNames: ReadonlyArray<string>, node: Resolved) => {
      const contested = finalNames.filter((name) => {
        const existing = decisions.get(name)

        return existing !== undefined && Decision.$is("Node")(existing) && existing.lineage !== lineage
      })

      if (contested.length > 0) {
        open(
          component,
          contested.map((name): ConflictRecord => {
            const reason: MergeConflictReason = base.nodeAt(name) === undefined ? "BothAddedDifferent" : "BothChanged"

            return { pathKey: name, reason }
          })
        )

        return
      }

      for (const name of finalNames) decisions.set(name, Decision.Node({ lineage, node }))

      for (const name of names) if (!finalNames.includes(name)) vacated.add(name)
    }

    if (View.$is("Ambiguous")(vO) || View.$is("Ambiguous")(vT)) {
      const unopposed = View.$is("Untouched")(vO) || View.$is("Untouched")(vT) || identicalClasses(ino)

      if (!unopposed) {
        open(component, inodeRecords(Arr.sort(component, Order.String), "HardLinkGroupDiverged"))
        continue
      }

      // A side split the node in ways no class can claim and nothing opposes it: its classes stand as fresh nodes.
      for (const name of names) vacated.add(name)
      continue
    }

    const sideOf = (v: View) => View.$is("Kept")(v) ? v.class : undefined
    const cO = sideOf(vO)
    const cT = sideOf(vT)

    if (cO === undefined && cT === undefined) {
      settle([], before)
      continue
    }

    if (cO === undefined || cT === undefined) {
      const kept = (cO ?? cT)!
      const removing: Side = cO === undefined ? "ours" : "theirs"
      const removedView = removing === "ours" ? vO : vT

      if (View.$is("Untouched")(removedView)) {
        settle(kept.names, kept.node)
        continue
      }

      const added = kept.names.filter((name) => !names.includes(name))
      const nodeChanged = !sameNode(before, kept.node)

      if (added.length > 0) {
        open(component, inodeRecords(added, "ChangedRemoved"))
        continue
      }

      if (nodeChanged) {
        open(component, kept.names.map((name) => removalRecord(removing, name, "ChangedRemoved")))
        continue
      }

      // The other side only unlinked some names; removing them all agrees with that.
      settle([], before)
      continue
    }

    const mergedNames = mergeNames(names, cO.names, cT.names)

    if (Result.isFailure(mergedNames)) {
      open(component, inodeRecords(Arr.sort(component, Order.String), mergedNames.failure))
      continue
    }

    const finalNames = mergedNames.success

    const { clashes, node } = combine(before, cO.node, cT.node)

    if (clashes.length > 0) {
      open(component, inodeRecords(finalNames, "BothChanged"))
      continue
    }

    settle(finalNames, node)
  }

  // Fresh nodes: classes no inode decision claimed, decided name by name against the other side.
  const fresh = (input: Input) => [...input.classes.values()].filter((cls) => !claimed[input.side].has(cls.ino))

  const freshOurs = fresh(ours)
  const freshTheirs = fresh(theirs)
  const freshClassAt = new Map<Side, Map<string, Class>>([["ours", new Map()], ["theirs", new Map()]])

  for (const cls of freshOurs) for (const name of cls.names) freshClassAt.get("ours")!.set(name, cls)

  for (const cls of freshTheirs) for (const name of cls.names) freshClassAt.get("theirs")!.set(name, cls)

  const isDirectoryPath = (pathKey: string) =>
    base.nodeAt(pathKey)?.kind === "directory" ||
    SIDES.some((side) => {
      const change = inputs[side].changes.get(pathKey)

      return change !== undefined && !Delta.Change.guards.Removed(change) && Delta.kindOf(change) === "directory"
    })

  const freshNames = new Set([...freshClassAt.get("ours")!.keys(), ...freshClassAt.get("theirs")!.keys()])
  const freshDecided = new Set<string>()

  // Names both sides wrote afresh first, so a shared node gathers every name either side gave it.
  for (const name of freshNames) {
    const cO = freshClassAt.get("ours")!.get(name)
    const cT = freshClassAt.get("theirs")!.get(name)

    if (cO === undefined || cT === undefined || freshDecided.has(name) || isDirectoryPath(name)) continue
    const shared = new Set([...cO.names, ...cT.names])

    for (const member of shared) freshDecided.add(member)
    const combined = combineFresh(cO.node, cT.node)

    if (combined === undefined) {
      const reason: MergeConflictReason = base.nodeAt(name) === undefined ? "BothAddedDifferent" : "KindDiverged"
      open(shared, [{ pathKey: name, reason }])
      continue
    }

    const lineage = `m:${Arr.sort(shared, Order.String)[0]!}`

    for (const member of shared) decisions.set(member, Decision.Node({ lineage, node: combined }))
  }

  for (const [side, classAt] of freshClassAt) {
    for (const [name, cls] of classAt) {
      if (freshDecided.has(name) || isDirectoryPath(name)) continue
      freshDecided.add(name)
      const existing = decisions.get(name)

      // A fresh node at a name the other side's node still holds: two different nodes for one name.
      if (existing !== undefined && Decision.$is("Node")(existing)) {
        const root = componentOf.get(name)
        const affected = new Set([...cls.names, ...(root === undefined ? [] : componentPaths.get(root)!)])
        const before = base.nodeAt(name)

        const reason: MergeConflictReason = before === undefined
          ? "BothAddedDifferent"
          : before.kind !== cls.node.kind
          ? "KindDiverged"
          : "BothChanged"

        open(affected, [{ pathKey: name, reason }])
        continue
      }

      decisions.set(name, Decision.Node({ lineage: `${side}:${cls.ino}`, node: cls.node }))
    }
  }

  for (const name of vacated) if (!decisions.has(name)) decisions.set(name, Decision.Removed())

  // Directories, top down. A change beneath a removed directory disputes the removal unless it is a removal too, a
  // timestamp-only touch, or a name the node decisions already gave up.
  const survivesBeneath = (side: Side, root: string) =>
    beneath(inputs[side].sorted, root).filter((candidate) => {
      const change = inputs[side].changes.get(candidate)!
      const decision = decisions.get(candidate)

      return !Delta.Change.guards.Removed(change) && !isTimestampsOnly(change) &&
        !(decision !== undefined && Decision.$is("Removed")(decision))
    })

  // A node decision from the node pass stands; a vacated name is free for what the directory pass finds there.
  const holdsNode = (pathKey: string) => {
    const existing = decisions.get(pathKey)

    return existing !== undefined && Decision.$is("Node")(existing)
  }

  const sideLineage = (side: Side, pathKey: string) => {
    const ino = inputs[side].inoAt.get(pathKey)

    return ino === undefined ? `${side}:dir:${pathKey}` : `${side}:${ino}`
  }

  const eliminate = (side: Side, pathKey: string, change: Change) => {
    const disputed = survivesBeneath(other(side), pathKey)

    if (disputed.length > 0) {
      const affected = [pathKey, ...beneath(union, pathKey)]
      open(
        affected,
        disputed.map((candidate) => ({
          pathKey: candidate,
          reason: "ParentRemoved" as const,
          sides: { [side]: change }
        }))
      )

      return
    }

    if (holdsNode(pathKey)) return
    const after = lookupNode(inputs[side].state, paths.get(pathKey)!)
    decisions.set(
      pathKey,
      after === undefined
        ? Decision.Removed()
        : Decision.Node({ lineage: sideLineage(side, pathKey), node: resolve(after) })
    )
  }

  const directoryNode = (side: Side, pathKey: string) => {
    const node = lookupNode(inputs[side].state, paths.get(pathKey)!)

    return node === undefined ? undefined : resolve(node)
  }

  for (const pathKey of union) {
    if (!isDirectoryPath(pathKey)) continue
    const o = ours.changes.get(pathKey)
    const t = theirs.changes.get(pathKey)
    const before = base.nodeAt(pathKey)

    const oneSide = (side: Side, change: Change) => {
      if (before?.kind === "directory" && (Delta.Change.guards.Removed(change) || hasKindChange(change))) {
        eliminate(side, pathKey, change)

        return
      }

      if (holdsNode(pathKey)) return
      const node = directoryNode(side, pathKey)!
      decisions.set(pathKey, Decision.Node({ lineage: sideLineage(side, pathKey), node }))
    }

    if (o === undefined || t === undefined) {
      const side: Side = o === undefined ? "theirs" : "ours"
      oneSide(side, (o ?? t)!)
      continue
    }

    const oReal = !isTimestampsOnly(o)
    const tReal = !isTimestampsOnly(t)

    if (Delta.Change.guards.Removed(o) && Delta.Change.guards.Removed(t)) {
      decisions.set(pathKey, Decision.Removed())
      continue
    }

    if (!oReal || !tReal) {
      const real = oReal ? o : t
      const side: Side = oReal ? "ours" : "theirs"

      if (Delta.Change.guards.Removed(real) || hasKindChange(real)) {
        oneSide(side, real)
        continue
      }
    }

    if (Delta.Change.guards.Removed(o) || Delta.Change.guards.Removed(t)) {
      const removing: Side = Delta.Change.guards.Removed(o) ? "ours" : "theirs"
      const change = changeAt(other(removing), pathKey)!
      const fallback: MergeConflictReason = hasKindChange(change) ? "KindDiverged" : "ChangedRemoved"
      open([pathKey, ...beneath(union, pathKey)], [removalRecord(removing, pathKey, fallback)])
      continue
    }

    const nO = directoryNode("ours", pathKey)!
    const nT = directoryNode("theirs", pathKey)!

    if (before === undefined || hasKindChange(o) || hasKindChange(t)) {
      // Both sides wrote a directory here, or at least one replaced what was here.
      const bothWrote = before === undefined || (hasKindChange(o) && hasKindChange(t))
      const combined = bothWrote ? combineFresh(nO, nT) : undefined

      if (combined === undefined) {
        const reason: MergeConflictReason = before === undefined ? "BothAddedDifferent" : "KindDiverged"
        open([pathKey, ...beneath(union, pathKey)], [{ pathKey, reason }])
        continue
      }

      if (!holdsNode(pathKey)) {
        decisions.set(pathKey, Decision.Node({ lineage: `m:dir:${pathKey}`, node: combined }))
      }

      continue
    }

    const { clashes, node } = combine(resolve(before), nO, nT)

    if (clashes.length > 0) {
      open([pathKey], [{ pathKey, reason: "BothChanged" }])
      continue
    }

    if (!holdsNode(pathKey)) decisions.set(pathKey, Decision.Node({ lineage: `m:dir:${pathKey}`, node }))
  }

  // A conflict keeps its paths at base, and base must stay consistent: every name of a node tied to a conflicted
  // path stays too, and so does the subtree of any directory a side removed above one.
  const eliminatedAround = (pathKey: string) =>
    SIDES.flatMap((side) => inputs[side].eliminated.filter((root) => root === pathKey || isBeneath(pathKey, root)))

  const subtreeOf = new Map<string, ReadonlyArray<string>>()

  const subtree = (dir: string) => {
    const known = subtreeOf.get(dir)

    if (known !== undefined) return known
    const members = [dir, ...beneath(union, dir)]
    subtreeOf.set(dir, members)

    return members
  }

  // Names that joined a scope only because they share a node with a conflicted name.
  const pulledByNode = new Set<string>()
  let grew = true
  let expanded = false

  // Scopes first grow by node and by the directories removed above their paths and merge, so each removed directory's
  // subtree is added once per merged scope; a subtree that brings new nodes in starts the round again.
  while (grew || !expanded) {
    if (!grew) {
      expanded = true

      for (const scope of scopes) {
        for (const dir of Array.from(scope.paths)) {
          if (!eliminatedAround(dir).includes(dir)) continue

          for (const candidate of subtree(dir)) {
            if (!scope.paths.has(candidate)) {
              scope.paths.add(candidate)
              grew = true
            }
          }
        }
      }

      if (!grew) break
      expanded = false
    }

    grew = false

    for (const scope of scopes) {
      const current = Array.from(scope.paths)
      const absorbed = new Set<string>()

      for (const pathKey of current) {
        const root = componentOf.get(pathKey)
        const shared: ReadonlyArray<string> = root === undefined ? [] : [...componentPaths.get(root)!]
        const beneathDirs: Array<string> = []

        for (const dir of eliminatedAround(pathKey)) {
          if (absorbed.has(dir)) continue
          absorbed.add(dir)
          beneathDirs.push(dir)
        }

        for (const candidate of shared) {
          if (!scope.paths.has(candidate)) {
            scope.paths.add(candidate)
            pulledByNode.add(candidate)
            grew = true
          }
        }

        for (const candidate of beneathDirs) {
          if (!scope.paths.has(candidate)) {
            scope.paths.add(candidate)
            grew = true
          }
        }
      }
    }

    // Overlapping scopes resolve as one.
    const owner = new Map<string, Scope>()
    const merged: Array<Scope> = []
    const dead = new Set<Scope>()

    const absorb = (target: Scope, source: Scope) => {
      for (const pathKey of source.paths) {
        target.paths.add(pathKey)
        owner.set(pathKey, target)
      }

      for (const record of source.records) {
        if (target.recorded.has(record.pathKey)) continue
        target.recorded.add(record.pathKey)
        target.records.push(record)
      }
    }

    for (const scope of scopes) {
      let target: Scope | undefined

      for (const pathKey of scope.paths) {
        const existing = owner.get(pathKey)

        if (existing === undefined || existing === target) continue

        if (target === undefined) target = existing
        else {
          absorb(target, existing)
          dead.add(existing)
        }
      }

      if (target === undefined) {
        merged.push(scope)

        for (const pathKey of scope.paths) owner.set(pathKey, scope)
        continue
      }

      absorb(target, scope)
      grew = true
    }

    scopes.splice(0, scopes.length, ...merged.filter((scope) => !dead.has(scope)))
  }

  // A changed name that stays at base only because it shares a node with a conflicted name is reported too,
  // otherwise its change would vanish without a record. Paths beneath a conflicted directory are not: the
  // directory's record covers them.
  for (const scope of scopes) {
    const known = new Set(scope.records.map((record) => record.pathKey))

    for (const pathKey of scope.paths) {
      const decision = decisions.get(pathKey)

      if (known.has(pathKey) || !pulledByNode.has(pathKey) || decision === undefined) continue

      if (Decision.$is("Node")(decision) && SIDES.some((side) => inputs[side].changes.has(pathKey))) {
        scope.records.push({ pathKey, reason: "HardLinkGroupDiverged" })
      }
    }
  }

  for (const scope of scopes) for (const pathKey of scope.paths) decisions.delete(pathKey)

  return { decisions, scopes }
}

interface Settled {
  readonly decisions: ReadonlyMap<string, Decision>
  readonly conflicts: ReadonlyArray<MergeConflict>
}

// Apply resolutions: a scope taken from one side holds exactly what that side left at each of its paths.
const settle = Effect.fnUntraced(function*(
  classified: Classified,
  inputs: { readonly ours: Input; readonly theirs: Input },
  resolutions: ReadonlyArray<MergeResolution>
) {
  const takes = new Map<string, Take>()

  for (const resolution of resolutions) {
    const bytes = getBytes(resolution.path)

    if (bytes === undefined) return yield* argumentFailure(OPERATION, "resolutions")
    const pathKey = Delta.key(bytes)

    if (takes.has(pathKey) && takes.get(pathKey) !== resolution.take) {
      return yield* argumentFailure(OPERATION, "resolutions")
    }

    takes.set(pathKey, resolution.take)
  }

  const reported = new Set(classified.scopes.flatMap((scope) => scope.records.map((record) => record.pathKey)))

  for (const pathKey of takes.keys()) {
    if (!reported.has(pathKey)) return yield* argumentFailure(OPERATION, "resolutions")
  }

  const decisions = new Map(classified.decisions)
  const conflicts: Array<MergeConflict> = []
  const paths = new Map<string, Uint8Array>([...inputs.ours.paths, ...inputs.theirs.paths])

  for (const scope of classified.scopes) {
    // A scope takes one side as a whole: every reported path resolved the same way, or none of them.
    const chosen = new Set(scope.records.map((record) => takes.get(record.pathKey)))

    if (chosen.size > 1) return yield* argumentFailure(OPERATION, "resolutions")
    const [take] = chosen

    if (take === undefined) {
      for (const record of scope.records) {
        conflicts.push({
          path: makeBytePath(paths.get(record.pathKey)!),
          reason: record.reason,
          ours: sideChange(record.sides?.ours ?? inputs.ours.changes.get(record.pathKey)),
          theirs: sideChange(record.sides?.theirs ?? inputs.theirs.changes.get(record.pathKey))
        })
      }

      continue
    }

    if (take === "base") continue
    const input = inputs[take]

    for (const pathKey of scope.paths) {
      const change = input.changes.get(pathKey)

      if (change === undefined) continue

      if (Delta.Change.guards.Removed(change)) {
        decisions.set(pathKey, Decision.Removed())
        continue
      }

      const ino = input.inoAt.get(pathKey)

      if (ino !== undefined) {
        decisions.set(pathKey, Decision.Node({ lineage: `${take}:${ino}`, node: input.classes.get(ino)!.node }))
        continue
      }

      const node = lookupNode(input.state, paths.get(pathKey)!)!
      decisions.set(pathKey, Decision.Node({ lineage: `${take}:dir:${pathKey}`, node: resolve(node) }))
    }
  }

  return {
    decisions,
    conflicts: Arr.sortWith(conflicts, (conflict) => getBytes(conflict.path)!, bytesOrder)
  } satisfies Settled
})

const differencesBetween = (before: Node, after: Resolved, hardLinks: boolean): ReadonlyArray<SnapshotDifference> =>
  Delta.differenceOrder.filter((field) => {
    if (field === "kind") return before.kind !== after.kind

    if (field === "content" || field === "target") {
      return before.kind === after.kind && after.kind !== "directory" &&
        Delta.payloadDifference(after.kind) === field &&
        !sameBytes(payloadOf(before), after.payload)
    }

    if (field === "hardLinks") return hardLinks

    return before.metadata[field] !== after.metadata[field]
  })

// Lay the decisions out as one change list: removals as they are, and every lineage with its first name in byte order
// carrying the node and the other names linking to it.
const emit = (base: Base, decisions: ReadonlyMap<string, Decision>, paths: ReadonlyMap<string, Uint8Array>) => {
  const changes: Array<{ readonly path: Uint8Array; readonly change: Change }> = []
  const encode = CanonicalBase64.encode
  const lineages = new Map<string, { readonly names: Array<string>; readonly node: Resolved }>()
  const pathOf = (pathKey: string) => paths.get(pathKey)!

  for (const [pathKey, decision] of decisions) {
    Decision.$match(decision, {
      Removed: () => {
        const before = base.nodeAt(pathKey)!
        changes.push({
          path: pathOf(pathKey),
          change: Delta.Change.cases.Removed.make({ path: encode(pathOf(pathKey)), kind: before.kind }, UNCHECKED)
        })
      },
      Node: ({ lineage, node }) => {
        const group = lineages.get(lineage) ?? { names: [], node }
        group.names.push(pathKey)
        lineages.set(lineage, group)
      }
    })
  }

  for (const { names, node } of lineages.values()) {
    const sorted = Arr.sort(names, Order.String)
    const headKey = sorted[0]!
    const groupKey = sorted.length > 1 ? sorted.join("/") : undefined
    const headPath = encode(pathOf(headKey))

    const deltaNode = (pathKey: string, withPayload: boolean): Delta.DeltaNode => {
      if (pathKey !== headKey) return Delta.DeltaNode.cases.link.make({ to: headPath }, UNCHECKED)

      if (node.kind === "directory") return Delta.DeltaNode.cases.directory.make({ metadata: node.metadata }, UNCHECKED)

      if (node.kind === "file") {
        return Delta.DeltaNode.cases.file.make(
          withPayload
            ? {
              metadata: node.metadata,
              content: Delta.InlineContent.make({ bytes: encode(node.payload!) }, UNCHECKED)
            }
            : { metadata: node.metadata },
          UNCHECKED
        )
      }

      return Delta.DeltaNode.cases.symlink.make(
        withPayload ? { metadata: node.metadata, target: encode(node.payload!) } : { metadata: node.metadata },
        UNCHECKED
      )
    }

    const emitted: Array<{ readonly path: Uint8Array; readonly change: Change }> = []
    let headEmitted = false

    for (const pathKey of sorted) {
      const path = pathOf(pathKey)
      const before = base.nodeAt(pathKey)
      const baseGroup = base.side.groupOf.get(pathKey) ?? pathKey
      const hardLinks = (groupKey ?? pathKey) !== baseGroup

      if (before === undefined) {
        headEmitted ||= pathKey === headKey
        emitted.push({
          path,
          change: Delta.Change.cases.Added.make(
            { path: encode(path), kind: node.kind, node: deltaNode(pathKey, true) },
            UNCHECKED
          )
        })
        continue
      }

      const differences = differencesBetween(before, node, hardLinks)

      if (differences.length === 0) continue
      const withPayload = differences.includes("kind") || differences.includes(Delta.payloadDifference(node.kind))
      headEmitted ||= pathKey === headKey

      emitted.push({
        path,
        change: Delta.Change.cases.Updated.make({
          path: encode(path),
          beforeKind: before.kind,
          afterKind: node.kind,
          differences,
          node: deltaNode(pathKey, withPayload)
        }, UNCHECKED)
      })
    }

    // Every name of a lineage shares its node and group, so a member with differences implies the head has them too.
    if (emitted.length > 0 && !headEmitted) return Result.fail("a hard-link group was emitted without its head")

    changes.push(...emitted)
  }

  return Result.succeed(Arr.sortWith(changes, (entry) => entry.path, bytesOrder).map(({ change }) => change))
}

/** @internal */
export const mergeSnapshotDeltas = Effect.fnUntraced(function*(
  base: Snapshot,
  ours: SnapshotDelta,
  theirs: SnapshotDelta,
  resolutions: ReadonlyArray<MergeResolution>,
  limits: DeltaBudget
) {
  const documents = { ours: yield* Delta.getDocument(ours), theirs: yield* Delta.getDocument(theirs) }

  const value = yield* Image.valueOf(base)
  const identity = yield* Merkle.identify(value, Delta.baseBudget(limits))

  const states = {
    ours: yield* Delta.verifyWith(value, identity, documents.ours, limits),
    theirs: yield* Delta.verifyWith(value, identity, documents.theirs, limits)
  }

  const inputs = {
    ours: indexSide("ours", documents.ours, states.ours, value),
    theirs: indexSide("theirs", documents.theirs, states.theirs, value)
  }

  const indexed = indexBase(value, identity, [inputs.ours, inputs.theirs])
  const classified = classify(indexed, inputs.ours, inputs.theirs)
  const settled = yield* settle(classified, inputs, resolutions)

  const changes = yield* Result.match(emit(indexed, settled.decisions, indexed.paths), {
    onFailure: (reason) => Effect.die(new Error(`mergeSnapshotDeltas: ${reason}`)),
    onSuccess: Effect.succeed
  })

  if (changes.length > limits.records) {
    return yield* imageFailure(OPERATION, "LimitExceeded", { field: "deltaRecords" })
  }

  const draft: Delta.Document = {
    format: Delta.FORMAT,
    version: 1,
    base: CanonicalBase64.encode(identity.digest),
    target: CanonicalBase64.encode(identity.digest),
    changes
  }

  const folded = yield* Effect.fromResult(Delta.fold(value, identity, draft))
  yield* Effect.fromResult(Delta.outputIssue(limits, folded))
  const target = yield* Delta.foldedIdentity(value, folded, identity, limits)
  const document: Delta.Document = { ...draft, target: CanonicalBase64.encode(target) }
  yield* Effect.fromResult(Delta.validate(document, limits))

  return { delta: SnapshotDeltaModel.make(document), conflicts: settled.conflicts }
})
