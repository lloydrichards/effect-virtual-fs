// Snapshot deltas: the path changes that turn a base snapshot into a target, each carrying only the node it
// leaves behind. A delta names both snapshots by their Merkle identities. Diffing skips every subtree whose digests
// agree, and applying folds the changes over the base value, so beyond the walk that identifies the base both do
// work in proportion to what changed.
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type { Snapshot } from "../Snapshot.js"
import {
  SnapshotChange,
  type SnapshotChangesOptions,
  type SnapshotDelta,
  SnapshotDifference,
  SnapshotNodeKind
} from "../SnapshotDelta.js"
import type { ImageFailure } from "../VfsError.js"
import type { DeltaBudget } from "./budget.js"
import { make as makeBytePath } from "./bytePath.js"
import { bytesOrder, decodeUtf8, sameBytes } from "./bytes.js"
import { CanonicalBase64 } from "./canonicalBase64.js"
import { imageFailure, isEncodingIssue, issueSite, VfsError } from "./errors.js"
import * as Image from "./image.js"
import * as InodeTable from "./inodeTable.js"
import * as Merkle from "./merkle.js"
import { StoredMetadata } from "./metadata.js"
import * as Content from "./overlayContent.js"
import { isAttachedBytes, isNameBytes, joinPath, nameBytes, NUL_BYTE, ROOT_PATH, SLASH_BYTE } from "./path.js"
import * as SnapshotDeltaModel from "./snapshotDeltaModel.js"
import {
  byEntryName,
  getNode,
  Ino,
  type Link,
  MAX_INO,
  type Node,
  payloadOf,
  ROOT_INO,
  storedMetadata,
  type VolumeState
} from "./volumeState.js"

const FORMAT = "effect-vfs-delta"

const OPERATION = "snapshotDelta"

// Marks the check holding a delta's rules, whose failures name the change that broke one.
const RULE_CHECK = "@effect-vfs/core/deltaRuleCheck"

const Path = CanonicalBase64.Encoded

type Path = typeof Path.Type

// The node a change leaves at its path. A file or symbolic link carries its payload only when the change alters
// it, and otherwise keeps the payload its path held in the base. A name that joins a hard-link group names the
// group's first path instead, whose change carries the node.
const InlineContent = Schema.TaggedStruct("Inline", { bytes: CanonicalBase64.Encoded })

const DeltaNode = Schema.TaggedUnion({
  directory: { metadata: StoredMetadata },
  file: { metadata: StoredMetadata, content: Schema.optionalKey(InlineContent) },
  symlink: { metadata: StoredMetadata, target: Schema.optionalKey(CanonicalBase64.Encoded) },
  link: { to: Path }
})

type DeltaNode = typeof DeltaNode.Type

const Change = Schema.TaggedUnion({
  Added: { path: Path, kind: SnapshotNodeKind, node: DeltaNode },
  Removed: { path: Path, kind: SnapshotNodeKind },
  Updated: {
    path: Path,
    beforeKind: SnapshotNodeKind,
    afterKind: SnapshotNodeKind,
    differences: Schema.Array(SnapshotDifference).check(Schema.isMinLength(1)),
    node: DeltaNode
  }
})

type Change = typeof Change.Type

const Document = Schema.Struct({
  format: Schema.Literal(FORMAT),
  version: Schema.Literal(1),
  base: CanonicalBase64.Encoded,
  target: CanonicalBase64.Encoded,
  changes: Schema.Array(Change)
})

type Document = typeof Document.Type

const VersionProbe = Schema.Struct({
  format: Schema.Literal(FORMAT),
  version: Schema.Unknown
})

const differenceOrder = SnapshotDifference.literals

const timestampFields = new Set<SnapshotDifference>(["atimeNs", "mtimeNs", "ctimeNs", "birthtimeNs"])

const key = Encoding.encodeHex

// An absolute path of valid names: the root alone, or a slash before each name and none after the last.
const validPath = (path: Uint8Array) => {
  if (path[0] !== SLASH_BYTE) return false
  let start = 1

  for (let i = 1; i <= path.length && path.length > 1; i++) {
    if (i === path.length || path[i] === SLASH_BYTE) {
      if (!isNameBytes(path.subarray(start, i))) return false
      start = i + 1
    }
  }

  return true
}

// A valid path's names, hex-encoded as directories key them; the root has none.
const splitNames = (path: Uint8Array): ReadonlyArray<string> => {
  const names: Array<string> = []

  if (path.length === 1) return names
  let start = 1

  for (let i = 1; i <= path.length; i++) {
    if (i === path.length || path[i] === SLASH_BYTE) {
      names.push(key(path.subarray(start, i)))
      start = i + 1
    }
  }

  return names
}

const kindOf = (change: Change): SnapshotNodeKind => Change.guards.Updated(change) ? change.afterKind : change.kind

const payloadDifference = (kind: SnapshotNodeKind) => (kind === "file" ? "content" : "target")

// Whether a change must carry the payload of the node it leaves: always for an addition, and for an update that
// changes the node's kind or its payload.
const carriesPayload = (change: Change) =>
  Change.guards.Added(change) ||
  (Change.guards.Updated(change) &&
    (change.differences.includes("kind") || change.differences.includes(payloadDifference(change.afterKind))))

const carriedPayload = (node: DeltaNode): Path | undefined =>
  DeltaNode.guards.file(node) ? node.content?.bytes : DeltaNode.guards.symlink(node) ? node.target : undefined

// The rules a delta keeps whatever its base: changes ascend by path bytes, each path valid and listed once; the
// root is only ever updated as a directory; an update lists its differences once each in their canonical order,
// with `kind` exactly when the kind changes; each node matches the change's kind and carries its payload exactly
// when the change alters it; a link names an earlier change's file or symbolic link of its kind; and no symbolic
// link target holds a NUL.
const changesIssue = (changes: ReadonlyArray<Change>): Schema.FilterIssue | undefined => {
  const at = (path: ReadonlyArray<PropertyKey>, issue: string) => ({ path: ["changes", ...path], issue })
  const heads = new Map<Path, SnapshotNodeKind>()
  let previous: Uint8Array | undefined

  for (const [index, change] of changes.entries()) {
    const path = CanonicalBase64.toBytes(change.path)

    if (!validPath(path) || (previous !== undefined && bytesOrder(previous, path) >= 0)) {
      return at([], "changes ascend by path bytes, each a valid path")
    }

    previous = path
    const root = path.length === 1

    if (Change.guards.Removed(change)) {
      if (root) return at([index], "the root is never removed")
      continue
    }

    if (Change.guards.Added(change) && root) return at([index], "the root is never added")

    if (Change.guards.Updated(change)) {
      const positions = change.differences.map((field) => differenceOrder.indexOf(field))

      if (positions.some((position, place) => place > 0 && position <= positions[place - 1]!)) {
        return at([index, "differences"], "differences are listed once each in their canonical order")
      }

      if (change.differences.includes("kind") !== (change.beforeKind !== change.afterKind)) {
        return at([index, "differences"], "an update lists kind exactly when the kind changes")
      }

      if (root && (change.beforeKind !== "directory" || change.afterKind !== "directory")) {
        return at([index], "the root stays a directory")
      }
    }

    const kind = kindOf(change)
    const node = change.node

    if (DeltaNode.guards.link(node)) {
      if (heads.get(node.to) !== kind) {
        return at([index, "node", "to"], "a link names an earlier change's file or symbolic link of its kind")
      }

      continue
    }

    if (node._tag !== kind) return at([index, "node"], "a node matches its change's kind")

    if (DeltaNode.guards.directory(node)) continue

    if ((carriedPayload(node) !== undefined) !== carriesPayload(change)) {
      return at([index, "node"], "a node carries its payload exactly when the change alters it")
    }

    if (
      DeltaNode.guards.symlink(node) && node.target !== undefined &&
      CanonicalBase64.toBytes(node.target).includes(NUL_BYTE)
    ) {
      return at([index, "node", "target"], "a symbolic link's target holds no NUL")
    }

    heads.set(change.path, kind)
  }
}

const ValidDocument = Document.check(
  Schema.makeFilter((document) => changesIssue(document.changes) ?? true, {
    identifier: "ValidSnapshotDelta",
    [RULE_CHECK]: true
  })
)

const JsonDocument = Schema.fromJsonString(Document)

const Json = Schema.fromJsonString(Schema.Unknown)

const decodeDocument = Schema.decodeUnknownEffect(ValidDocument, { onExcessProperty: "error" })

// Names the site of a document of the wrong shape or spelling as the codec's errors always have: a digest, a
// change's path or a payload, and otherwise the issue's path. A broken rule names the change from its issue path.
const failureField = (path: ReadonlyArray<PropertyKey>): string => {
  const [head, , field] = path

  if (head === "base" || head === "target") return "digest"

  if (head === "changes" && path.length === 3 && field === "path") return "changePath"

  if (head === "changes" && field === "node" && (path[3] === "target" || path.at(-1) === "bytes")) return "payload"

  return path.length === 0 ? "document" : path.map(String).join(".")
}

const decodeFailure = (error: Schema.SchemaError) => {
  const site = issueSite(error.issue)
  const rule = site.checks.some((check) => check.annotations?.[RULE_CHECK] === true)

  return rule
    ? imageFailure(OPERATION, "InvalidStructure", { field: site.path.map(String).join("."), cause: error })
    : imageFailure(OPERATION, isEncodingIssue(site) ? "InvalidEncoding" : "InvalidStructure", {
      field: failureField(site.path),
      cause: error
    })
}

const exceeds = (value: number, limit: ByteSize.ByteSize) => ByteSize.isGreaterThan(ByteSize.bytes(value), limit)

// The budget a delta keeps whatever its base, counted from the base64 lengths alone.
const validate = (document: Document, limits: DeltaBudget): Result.Result<void, ImageFailure> => {
  const fail = (code: "LimitExceeded" | "InvalidEncoding", field: string) =>
    Result.fail(imageFailure(OPERATION, code, { field }))

  if (document.changes.length > limits.records) return fail("LimitExceeded", "deltaRecords")

  for (const digest of [document.base, document.target]) {
    if (CanonicalBase64.decodedLength(digest) !== Merkle.DIGEST_BYTES) return fail("InvalidEncoding", "digest")
  }

  let decoded = 2 * Merkle.DIGEST_BYTES
  let entries = 0
  let payloadBytes = 0

  for (const change of document.changes) {
    const pathBytes = CanonicalBase64.decodedLength(change.path)
    decoded += pathBytes

    if (Change.guards.Removed(change)) continue

    // Every path but the root's is a name the change writes.
    if (pathBytes > 1) entries++

    if (DeltaNode.guards.link(change.node)) decoded += CanonicalBase64.decodedLength(change.node.to)
    else {
      const payload = carriedPayload(change.node)
      const length = payload === undefined ? 0 : CanonicalBase64.decodedLength(payload)
      decoded += length
      payloadBytes += length
    }
  }

  if (exceeds(decoded, limits.decodedBytes)) return fail("LimitExceeded", "decodedDeltaBytes")

  if (entries > limits.entries) return fail("LimitExceeded", "entries")

  if (exceeds(payloadBytes, limits.outputBytes)) return fail("LimitExceeded", "outputBytes")

  return Result.void
}

const baseBudget = (limits: DeltaBudget): Merkle.WalkBudget => ({
  operation: OPERATION,
  records: limits.baseRecords,
  recordsField: "baseRecords",
  entries: limits.entries,
  identityBytes: limits.identityBytes
})

const targetBudget = (limits: DeltaBudget): Merkle.WalkBudget => ({
  operation: OPERATION,
  records: limits.targetRecords,
  recordsField: "targetRecords",
  entries: limits.entries,
  identityBytes: limits.identityBytes,
  payloadBytes: { limit: limits.outputBytes, field: "outputBytes" }
})

interface Output {
  readonly records: number
  readonly entries: number
  readonly payloadBytes: number
  // The nodes the delta itself carries; the rest of the target is inherited from the base.
  readonly written: number
}

// What a delta's target holds and inherits, against the budget it runs under. The target's own bounds come first,
// so an applied target fails where a diff to it would.
const outputIssue = (limits: DeltaBudget, output: Output): Result.Result<void, ImageFailure> => {
  const fail = (field: string) => Result.fail(imageFailure(OPERATION, "LimitExceeded", { field }))

  if (output.records > limits.targetRecords) return fail("targetRecords")

  if (output.entries > limits.entries) return fail("entries")

  if (output.records > limits.outputRecords) return fail("outputRecords")

  if (exceeds(output.payloadBytes, limits.outputBytes)) return fail("outputBytes")

  if (output.records - output.written > limits.inheritedRecords) return fail("inheritedRecords")

  return Result.void
}

// A snapshot's identity together with, for every path in a hard-link group, the group it belongs to.
interface Side {
  readonly value: VolumeState
  readonly identity: Merkle.Identity
  readonly groupOf: ReadonlyMap<string, string>
  // The first path of the group each hard-linked node belongs to.
  readonly firstOf: ReadonlyMap<Ino, Uint8Array>
}

const groupKey = (paths: ReadonlyArray<Uint8Array>) => paths.map(key).join("/")

const side = (value: VolumeState, identity: Merkle.Identity): Side => {
  const groupOf = new Map<string, string>()
  const firstOf = new Map<Ino, Uint8Array>()

  for (const [ino, paths] of identity.groups) {
    const group = groupKey(paths)
    firstOf.set(ino, paths[0]!)

    for (const path of paths) groupOf.set(key(path), group)
  }

  return { value, identity, groupOf, firstOf }
}

// The group a path's node belongs to, as the joined keys of its paths; a node with one name is its own group.
const groupAt = (side: Side, pathKey: string) => side.groupOf.get(pathKey) ?? pathKey

const differencesOf = (before: Node, after: Node, hardLinks: boolean): ReadonlyArray<SnapshotDifference> =>
  differenceOrder.filter((field) => {
    if (field === "kind") return before.kind !== after.kind

    if (field === "content" || field === "target") {
      return before.kind === after.kind && after.kind !== "directory" && payloadDifference(after.kind) === field &&
        !sameBytes(payloadOf(before), payloadOf(after))
    }

    if (field === "hardLinks") return hardLinks

    return before.metadata[field] !== after.metadata[field]
  })

// A node built from a value is valid by construction, so building it skips the schema's checks.
const UNCHECKED = { disableChecks: true }

const deltaNode = (target: Side, path: Uint8Array, node: Node, withPayload: boolean): DeltaNode => {
  const first = target.firstOf.get(node.ino)

  if (node.kind !== "directory" && first !== undefined && !sameBytes(first, path)) {
    return DeltaNode.cases.link.make({ to: CanonicalBase64.encode(first) }, UNCHECKED)
  }

  const metadata = storedMetadata(node.metadata)

  if (node.kind === "directory") return DeltaNode.cases.directory.make({ metadata }, UNCHECKED)

  if (!withPayload) {
    return node.kind === "file"
      ? DeltaNode.cases.file.make({ metadata }, UNCHECKED)
      : DeltaNode.cases.symlink.make({ metadata }, UNCHECKED)
  }

  const bytes = CanonicalBase64.encode(payloadOf(node)!)

  return node.kind === "file"
    ? DeltaNode.cases.file.make({ metadata, content: InlineContent.make({ bytes }, UNCHECKED) }, UNCHECKED)
    : DeltaNode.cases.symlink.make({ metadata, target: bytes }, UNCHECKED)
}

interface Found {
  readonly parent: Ino
  readonly name: string
  readonly node: Node
}

type DirectoryNode = Node & { readonly kind: "directory" }

// The node a path names, walking directories from the root.
const lookup = (
  get: (ino: Ino) => Node | undefined,
  entriesOf: (directory: DirectoryNode) => ReadonlyMap<string, Ino>,
  path: Uint8Array
): Found | undefined => {
  let parent = ROOT_INO
  let node = get(ROOT_INO)
  let name = ""

  for (const component of splitNames(path)) {
    if (node?.kind !== "directory") return undefined
    const ino = entriesOf(node).get(component)

    if (ino === undefined) return undefined
    parent = node.ino
    name = component
    node = get(ino)
  }

  return node === undefined ? undefined : { parent, name, node }
}

const valueEntries = (directory: DirectoryNode) => directory.entries

// Compares two identified snapshots, descending only where digests differ. A subtree whose digests agree holds
// the same nodes, so only its hard-link groups can differ; the grouped paths the walk skipped are compared on
// their own afterwards.
const compare = (base: Side, target: Side): ReadonlyArray<Change> => {
  const changes: Array<{ readonly path: Uint8Array; readonly change: Change }> = []
  const listed = new Set<string>()
  const pending: Array<readonly [Uint8Array, Node | undefined, Node | undefined]> = []
  const encode = CanonicalBase64.encode

  const children = (path: Uint8Array, before: Node | undefined, after: Node | undefined) => {
    const names = new Set<string>([
      ...(before?.kind === "directory" ? before.entries.keys() : []),
      ...(after?.kind === "directory" ? after.entries.keys() : [])
    ])

    for (const name of names) {
      const b = before?.kind === "directory" ? before.entries.get(name) : undefined
      const a = after?.kind === "directory" ? after.entries.get(name) : undefined

      pending.push([
        joinPath(path, nameBytes(name)),
        b === undefined ? undefined : getNode(base.value, b),
        a === undefined ? undefined : getNode(target.value, a)
      ])
    }
  }

  const updated = (path: Uint8Array, before: Node, after: Node, differences: ReadonlyArray<SnapshotDifference>) =>
    changes.push({
      path,
      change: Change.cases.Updated.make({
        path: encode(path),
        beforeKind: before.kind,
        afterKind: after.kind,
        differences,
        node: deltaNode(
          target,
          path,
          after,
          differences.includes("kind") || differences.includes(payloadDifference(after.kind))
        )
      }, UNCHECKED)
    })

  pending.push([ROOT_PATH, getNode(base.value, ROOT_INO), getNode(target.value, ROOT_INO)])

  while (pending.length > 0) {
    const [path, before, after] = pending.pop()!
    const pathKey = key(path)

    if (base.groupOf.has(pathKey) || target.groupOf.has(pathKey)) listed.add(pathKey)

    if (before === undefined && after !== undefined) {
      changes.push({
        path,
        change: Change.cases.Added.make(
          { path: encode(path), kind: after.kind, node: deltaNode(target, path, after, true) },
          UNCHECKED
        )
      })
      children(path, undefined, after)
    } else if (before !== undefined && after === undefined) {
      changes.push({ path, change: Change.cases.Removed.make({ path: encode(path), kind: before.kind }, UNCHECKED) })
      children(path, before, undefined)
    } else if (before !== undefined && after !== undefined) {
      const same = sameBytes(base.identity.digests.get(before.ino), target.identity.digests.get(after.ino))
      const hardLinks = groupAt(base, pathKey) !== groupAt(target, pathKey)

      // Equal digests leave nothing to compare under a directory, and nothing but the group at a file.
      if (same && !hardLinks) continue
      const differences = differencesOf(before, after, hardLinks)

      if (differences.length > 0) updated(path, before, after, differences)

      if (!same) children(path, before, after)
    }
  }

  // Grouped paths under a subtree the walk skipped: the node is the same, so only its group can differ.
  for (const s of [base, target]) {
    for (const paths of s.identity.groups.values()) {
      for (const path of paths) {
        const pathKey = key(path)

        if (listed.has(pathKey)) continue
        listed.add(pathKey)

        if (groupAt(base, pathKey) === groupAt(target, pathKey)) continue
        const before = lookup((ino) => getNode(base.value, ino), valueEntries, path)!.node
        const after = lookup((ino) => getNode(target.value, ino), valueEntries, path)!.node
        updated(path, before, after, ["hardLinks"])
      }
    }
  }

  return changes.sort((a, b) => bytesOrder(a.path, b.path)).map(({ change }) => change)
}

const getDocument = (delta: SnapshotDelta): Effect.Effect<Document, ImageFailure> =>
  Effect.suspend(() => {
    const value = SnapshotDeltaModel.value(delta)

    return value !== undefined && Schema.is(Document)(value)
      ? Effect.succeed(value)
      : Effect.fail(imageFailure(OPERATION, "InvalidStructure", { field: "delta" }))
  })

interface Folded extends Output {
  readonly value: VolumeState
  // The nodes the fold wrote and every directory above them, whose digests the base's walk does not cover.
  readonly dirty: ReadonlySet<Ino>
  // The base's nodes the fold removed.
  readonly removed: ReadonlySet<Ino>
  // The target's hard-link groups, each as the paths of one node in byte order.
  readonly groups: ReadonlyMap<Ino, ReadonlyArray<Uint8Array>>
}

interface Placed {
  // The change's position in the delta, which a failure it causes names.
  readonly index: number
  readonly change: Change
  readonly path: Uint8Array
  readonly pathKey: string
}

// Folds a delta's changes over its base value. Removals and rewritten names detach from the deepest path up, then
// additions and rewrites attach from the root down; a directory that stays a directory updates in place. Each step
// checks that the base agrees with what the change claims, and a disagreement fails at the change, as
// `changes.<index>`. The target identity cannot stand in for these checks: a directory folded away without its
// entries leaves them unreachable, so the identity of what remains still matches, and a node that keeps a name the
// delta left alone keeps a stale hard-link group, whose digest a forged target could name. A delta that folds, and
// whose target identity then matches, describes its base and target exactly.
const fold = (
  base: VolumeState,
  identity: Merkle.Identity,
  document: Document
): Result.Result<Folded, ImageFailure> => {
  const fail = (index: number, field?: string) =>
    Result.fail(
      imageFailure(OPERATION, "InvalidStructure", {
        field: field === undefined ? `changes.${index}` : `changes.${index}.${field}`
      })
    )

  const owner = Symbol()
  const revision = base.revision + 1n
  let inodes = base.inodes
  let nextInode = base.nextInode
  let entries = base.entries
  let usedBytes = base.usedBytes
  let records = identity.records
  let payloadBytes = identity.payloadBytes
  let written = 0
  const drafts = new Map<Ino, Map<string, Ino>>()
  const dirty = new Set<Ino>()
  const removed = new Set<Ino>()
  // The paths of each node the fold created.
  const created = new Map<Ino, Array<Uint8Array>>()

  const get = (ino: Ino) => InodeTable.get(inodes, ino)

  const put = (ino: Ino, node: Node | undefined) => {
    inodes = InodeTable.set(inodes, ino, node, owner)
  }

  const entriesOf = (directory: DirectoryNode) => drafts.get(directory.ino) ?? directory.entries

  const editable = (directory: Ino) => {
    let draft = drafts.get(directory)

    if (draft === undefined) {
      const node = get(directory)
      draft = new Map(node?.kind === "directory" ? node.entries : [])
      drafts.set(directory, draft)
    }

    dirty.add(directory)

    return draft
  }

  const placed: ReadonlyArray<Placed> = document.changes.map((change, index) => {
    const path = CanonicalBase64.toBytes(change.path)

    return { index, change, path, pathKey: key(path) }
  })

  const changed = new Map(placed.map(({ change, pathKey }) => [pathKey, change]))
  const before = new Map<string, Found>()

  for (const { change, index, path, pathKey } of placed) {
    // An addition's path is checked free when it attaches, after the removals have detached theirs.
    if (Change.guards.Added(change)) continue
    const found = lookup((ino) => getNode(base, ino), valueEntries, path)

    if (found?.node.kind !== (Change.guards.Updated(change) ? change.beforeKind : change.kind)) return fail(index)
    before.set(pathKey, found)

    // A node leaves only with every name it had, and a directory only with everything under it.
    for (const member of identity.groups.get(found.node.ino) ?? []) {
      const other = changed.get(key(member))

      if (other === undefined || Change.guards.Added(other)) return fail(index)
    }

    if (found.node.kind === "directory" && (Change.guards.Removed(change) || kindOf(change) !== "directory")) {
      for (const name of found.node.entries.keys()) {
        const child = changed.get(key(joinPath(path, nameBytes(name))))

        if (child === undefined || !Change.guards.Removed(child)) return fail(index)
      }
    }
  }

  const inPlace = (change: Change) =>
    Change.guards.Updated(change) && change.beforeKind === "directory" && change.afterKind === "directory"

  for (let index = placed.length - 1; index >= 0; index--) {
    const { change, pathKey } = placed[index]!

    if (Change.guards.Added(change) || inPlace(change)) continue
    const { name, node, parent } = before.get(pathKey)!
    editable(parent).delete(name)
    entries--
    const current = get(node.ino)

    if (current === undefined) continue

    if (current.kind === "directory") {
      put(current.ino, undefined)
      removed.add(current.ino)
      records--
      continue
    }

    const links = current.links.filter((link) => !(link.parent === parent && link.name === name))

    if (links.length > 0) {
      put(current.ino, { ...current, links, metadata: { ...current.metadata, nlink: links.length } })
      continue
    }

    const size = payloadOf(current)!.length
    put(current.ino, undefined)
    removed.add(current.ino)
    records--
    payloadBytes -= size
    usedBytes -= BigInt(size)
  }

  const after = new Map<string, Ino>()

  for (const { change, index, path, pathKey } of placed) {
    if (Change.guards.Removed(change)) continue
    const node = change.node

    if (!DeltaNode.guards.link(node)) written++

    if (inPlace(change)) {
      const current = get(before.get(pathKey)!.node.ino)

      if (current?.kind !== "directory" || !DeltaNode.guards.directory(node)) return fail(index)
      put(current.ino, { ...current, metadata: { ...current.metadata, ...node.metadata }, revision })
      dirty.add(current.ino)
      after.set(pathKey, current.ino)
      continue
    }

    const name = splitNames(path).at(-1)!
    const parentPath = path.subarray(0, Math.max(1, path.length - name.length / 2 - 1))
    const parent = lookup(get, entriesOf, parentPath)?.node

    if (parent?.kind !== "directory") {
      return Result.fail(imageFailure(OPERATION, "InvalidStructure", { field: "parent" }))
    }

    const draft = editable(parent.ino)

    if (draft.has(name)) return fail(index)
    const link: Link = { parent: parent.ino, name }
    let ino: Ino

    if (DeltaNode.guards.link(node)) {
      const head = after.get(key(CanonicalBase64.toBytes(node.to)))
      const target = head === undefined ? undefined : get(head)

      if (target === undefined || target.kind === "directory") return fail(index)
      ino = target.ino
      const links = [...target.links, link]
      put(ino, { ...target, links, metadata: { ...target.metadata, nlink: links.length } })
      created.get(ino)?.push(path)
    } else {
      if (nextInode > MAX_INO) return Result.fail(imageFailure(OPERATION, "LimitExceeded", { field: "inodes" }))
      ino = nextInode
      nextInode = Ino(nextInode + 1)
      const numbered = { ...node.metadata, ino: BigInt(ino) }

      if (DeltaNode.guards.directory(node)) {
        const metadata = { ...numbered, kind: "directory" as const, nlink: 2, size: 0n }
        put(ino, { kind: "directory", ino, parent: parent.ino, name, entries: new Map(), metadata, revision })
      } else {
        const carried = carriedPayload(node)
        const kept = before.get(pathKey)?.node

        const bytes = carried !== undefined
          ? CanonicalBase64.toBytes(carried)
          : kept === undefined
          ? undefined
          : payloadOf(kept)

        if (bytes === undefined) return fail(index)
        const counted = { ...numbered, kind: node._tag, nlink: 1, size: BigInt(bytes.length) }

        put(
          ino,
          DeltaNode.guards.file(node)
            ? { kind: "file", ino, data: Content.make(bytes), links: [link], metadata: counted, revision }
            : { kind: "symlink", ino, target: bytes, links: [link], metadata: counted, revision }
        )
        payloadBytes += bytes.length
        usedBytes += BigInt(bytes.length)
      }

      records++
      created.set(ino, [path])
      dirty.add(ino)
    }

    draft.set(name, ino)
    entries++
    after.set(pathKey, ino)
  }

  // Every update lists exactly the differences between the node its path named and the one it names now.
  const baseGroup = (ino: Ino, pathKey: string) => {
    const paths = identity.groups.get(ino)

    return paths === undefined ? pathKey : groupKey(paths)
  }

  const targetGroup = (ino: Ino, pathKey: string) => {
    const paths = created.get(ino)

    return paths === undefined || paths.length < 2 ? pathKey : groupKey([...paths].sort(bytesOrder))
  }

  for (const { change, index, pathKey } of placed) {
    if (!Change.guards.Updated(change)) continue
    const was = before.get(pathKey)!.node
    const now = get(after.get(pathKey)!)!
    const found = differencesOf(was, now, baseGroup(was.ino, pathKey) !== targetGroup(now.ino, pathKey))

    if (found.length !== change.differences.length || found.some((field, at) => field !== change.differences[at])) {
      return fail(index, "differences")
    }
  }

  // Each directory whose entries changed lists them in name-byte order and counts its subdirectories again.
  for (const [ino, draft] of drafts) {
    const node = get(ino)

    if (node?.kind !== "directory") continue
    const sorted = [...draft].sort(byEntryName)
    const subdirectories = sorted.filter(([, child]) => get(child)?.kind === "directory").length
    const metadata = { ...node.metadata, nlink: 2 + subdirectories }
    put(ino, { ...node, entries: new Map(sorted), metadata, revision })
  }

  // A rewritten node changes the digest of every directory above it.
  for (const ino of dirty) {
    let node = get(ino)

    if (node === undefined) dirty.delete(ino)

    while (node !== undefined && node.ino !== ROOT_INO) {
      const parent: Ino = node.kind === "directory" ? node.parent : node.links[0]!.parent
      dirty.add(node.ino)

      if (dirty.has(parent)) break
      dirty.add(parent)
      node = get(parent)
    }
  }

  const groups = new Map<Ino, ReadonlyArray<Uint8Array>>()

  for (const [ino, paths] of identity.groups) if (get(ino) !== undefined) groups.set(ino, paths)

  for (const [ino, paths] of created) if (paths.length > 1) groups.set(ino, [...paths].sort(bytesOrder))

  const value: VolumeState = {
    inodes,
    open: new Map(),
    nextInode,
    revision: placed.length === 0 ? base.revision : revision,
    entries,
    usedBytes
  }

  return Result.succeed({ value, dirty, removed, groups, records, entries, payloadBytes, written })
}

// The identity of a folded value: only what the fold wrote is digested again, and the base's digests serve the
// rest. The meter still charges the whole target, as a walk of it would: the base's node bytes, less those of the
// nodes the fold replaced or removed, then what it digests again and the identity frame.
const foldedIdentity = Effect.fnUntraced(function*(
  base: VolumeState,
  folded: Folded,
  identity: Merkle.Identity,
  limits: DeltaBudget
) {
  const digests = new Map<Ino, Uint8Array>()
  const measure = Merkle.meter(targetBudget(limits))
  let inherited = identity.nodeBytes

  for (const ino of new Set([...folded.dirty, ...folded.removed])) {
    const was = identity.digests.has(ino) ? getNode(base, ino) : undefined

    if (was !== undefined) inherited -= Merkle.nodeBytes(was)
  }

  yield* measure.charge(inherited)
  const digestOf = (ino: Ino) => digests.get(ino) ?? identity.digests.get(ino)!
  const nodes = [...folded.dirty].map((ino) => getNode(folded.value, ino)!)
  const depths = new Map<Ino, number>([[ROOT_INO, 0]])

  // Walks up to the nearest directory of known depth, then numbers the directories it passed on the way.
  const depth = (node: DirectoryNode): number => {
    const chain: Array<Ino> = []
    let current: Node | undefined = node

    while (current?.kind === "directory" && !depths.has(current.ino)) {
      chain.push(current.ino)
      current = getNode(folded.value, current.parent)
    }

    let found = current === undefined ? -1 : depths.get(current.ino) ?? -1

    for (const ino of chain.reverse()) depths.set(ino, ++found)

    return depths.get(node.ino)!
  }

  const directories = nodes.filter((node): node is DirectoryNode => node.kind === "directory")

  // Files and symbolic links first, then directories from the deepest up, so each child is digested before its
  // directory.
  const ordered = [
    ...nodes.filter((node) => node.kind !== "directory"),
    ...directories.sort((a, b) => depth(b) - depth(a))
  ]

  for (const node of ordered) digests.set(node.ino, yield* Merkle.nodeDigest(node, digestOf, measure))

  return yield* Merkle.identityDigest(digestOf(ROOT_INO), folded.groups.values(), measure)
})

const verify = Effect.fnUntraced(function*(base: Snapshot, document: Document, limits: DeltaBudget) {
  yield* Effect.fromResult(validate(document, limits))
  const value = yield* Image.valueOf(base)
  const identity = yield* Merkle.identify(value, baseBudget(limits))

  if (!sameBytes(identity.digest, CanonicalBase64.toBytes(document.base))) {
    return yield* new VfsError({ code: "BaseMismatch", operation: OPERATION })
  }

  const folded = yield* Effect.fromResult(fold(value, identity, document))
  yield* Effect.fromResult(outputIssue(limits, folded))

  if (!sameBytes(yield* foldedIdentity(value, folded, identity, limits), CanonicalBase64.toBytes(document.target))) {
    return yield* imageFailure(OPERATION, "InvalidStructure", { field: "changes" })
  }

  return folded.value
})

/** @internal */
export const diffSnapshots = Effect.fnUntraced(function*(base: Snapshot, target: Snapshot, limits: DeltaBudget) {
  const baseValue = yield* Image.valueOf(base)
  const targetValue = yield* Image.valueOf(target)
  const before = side(baseValue, yield* Merkle.identify(baseValue, baseBudget(limits)))
  const after = side(targetValue, yield* Merkle.identify(targetValue, targetBudget(limits)))
  const changes = compare(before, after)

  if (changes.length > limits.records) {
    return yield* imageFailure(OPERATION, "LimitExceeded", { field: "deltaRecords" })
  }

  const written = changes.filter((change) => !Change.guards.Removed(change) && !DeltaNode.guards.link(change.node))
  yield* Effect.fromResult(
    outputIssue(limits, { ...after.identity, entries: targetValue.entries, written: written.length })
  )

  const document: Document = {
    format: FORMAT,
    version: 1,
    base: CanonicalBase64.encode(before.identity.digest),
    target: CanonicalBase64.encode(after.identity.digest),
    changes
  }

  yield* Effect.fromResult(validate(document, limits))

  return SnapshotDeltaModel.make(document)
})

const [AddedSummary, RemovedSummary, UpdatedSummary] = SnapshotChange.members

// The public summary of a change: its path as an owned byte path, without the node it carries.
const publicChange = (change: Change, options: SnapshotChangesOptions): SnapshotChange | undefined => {
  const path = makeBytePath(CanonicalBase64.toBytes(change.path))

  if (Change.guards.Added(change)) return Object.freeze(AddedSummary.make({ path, kind: change.kind }, UNCHECKED))

  if (Change.guards.Removed(change)) {
    return Object.freeze(RemovedSummary.make({ path, kind: change.kind }, UNCHECKED))
  }

  const differences = change.differences.filter((field) =>
    options.includeTimestamps === true || !timestampFields.has(field)
  )

  if (differences.length === 0) return undefined

  return Object.freeze(UpdatedSummary.make({
    path,
    beforeKind: change.beforeKind,
    afterKind: change.afterKind,
    differences: Object.freeze(differences)
  }, UNCHECKED))
}

/** @internal */
export const inspectSnapshotDelta = Effect.fnUntraced(
  function*(base: Snapshot, delta: SnapshotDelta, options: SnapshotChangesOptions, limits: DeltaBudget) {
    const document = yield* getDocument(delta)
    yield* verify(base, document, limits)
    const output: Array<SnapshotChange> = []

    for (const change of document.changes) {
      const shown = publicChange(change, options)

      if (shown !== undefined) output.push(shown)
    }

    return Object.freeze(output)
  }
)

/** @internal */
export const applySnapshotDelta = Effect.fnUntraced(
  function*(base: Snapshot, delta: SnapshotDelta, limits: DeltaBudget) {
    return Image.make(yield* verify(base, yield* getDocument(delta), limits))
  }
)

const encoder = new TextEncoder()

/** @internal */
export const encodeSnapshotDelta = Effect.fnUntraced(function*(delta: SnapshotDelta, limits: DeltaBudget) {
  const document = yield* getDocument(delta)
  yield* Effect.fromResult(validate(document, limits))

  const text = yield* Schema.encodeEffect(JsonDocument)(document).pipe(
    Effect.mapError((cause) => imageFailure(OPERATION, "InvalidStructure", { cause }))
  )

  const bytes = encoder.encode(text)

  if (exceeds(bytes.length, limits.encodedBytes)) {
    return yield* imageFailure(OPERATION, "LimitExceeded", { field: "encodedBytes" })
  }

  return bytes
})

/** @internal */
export const decodeSnapshotDelta = Effect.fnUntraced(function*(input: Uint8Array, limits: DeltaBudget) {
  if (!isAttachedBytes(input)) {
    return yield* imageFailure(OPERATION, "InvalidEncoding")
  }

  if (exceeds(input.byteLength, limits.encodedBytes)) {
    return yield* imageFailure(OPERATION, "LimitExceeded", { field: "encodedBytes" })
  }

  const text = yield* decodeUtf8(input, (cause) => imageFailure(OPERATION, "InvalidEncoding", { cause }))

  const value = yield* Schema.decodeEffect(Json)(text).pipe(
    Effect.mapError((cause) => imageFailure(OPERATION, "InvalidEncoding", { cause }))
  )

  const version = Schema.decodeUnknownResult(VersionProbe)(value)

  if (Result.isSuccess(version) && version.success.version !== 1) {
    return yield* imageFailure(OPERATION, "UnsupportedVersion")
  }

  const document = yield* Effect.mapError(decodeDocument(value), decodeFailure)
  yield* Effect.fromResult(validate(document, limits))

  return SnapshotDeltaModel.make(document)
})
