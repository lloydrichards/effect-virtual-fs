// The volume value: an immutable inode table and the counters a transition carries forward. Snapshots, overlays,
// restored volumes and the codecs all read this one value, so none of them needs a copy of their own.
import * as Brand from "effect/Brand"
import * as Effect from "effect/Effect"
import type { Metadata } from "../Metadata.js"
import * as InodeTable from "./inodeTable.js"
import type { StoredMetadata } from "./metadata.js"
import type * as Content from "./overlayContent.js"

// An inode number: monotonic within a volume, never reused, and persisted by the snapshot and the live image. A
// number keys the inode table more cheaply than a bigint; the public metadata still reports it as one.
/** @internal */
export type Ino = number & Brand.Brand<"@effect-vfs/core/Ino">

/** @internal */
export const Ino = Brand.nominal<Ino>()

/** @internal */
export const ROOT_INO = Ino(1)

// Nodes walked between yields. Whole-tree reads are one synchronous tick otherwise, which
// starves the event loop and leaves nothing for interruption to act on.
/** @internal */
export const WALK_YIELD_INTERVAL = 128

// One name that reaches an inode: the directory holding it and the hex-encoded name bytes.
/** @internal */
export interface Link {
  readonly parent: Ino
  readonly name: string
}

// What a node stores; the public Metadata adds the node's revision.
/** @internal */
export type NodeMetadata = Omit<Metadata, "revision">

// Inodes are immutable values: every change replaces the value in the state's inode table.
/** @internal */
export interface Directory {
  readonly kind: "directory"
  readonly ino: Ino
  // Directories have one name; a detached directory keeps its last one and reads as unnamed through nlink 0.
  readonly parent: Ino
  readonly name: string
  readonly entries: ReadonlyMap<string, Ino>
  readonly metadata: NodeMetadata
  readonly revision: bigint
}

/** @internal */
export interface RegularFile {
  readonly kind: "file"
  readonly ino: Ino
  readonly data: Content.Content
  readonly links: ReadonlyArray<Link>
  readonly metadata: NodeMetadata
  readonly revision: bigint
}

/** @internal */
export interface SymbolicLink {
  readonly kind: "symlink"
  readonly ino: Ino
  readonly target: Uint8Array
  readonly links: ReadonlyArray<Link>
  readonly metadata: NodeMetadata
  readonly revision: bigint
}

/** @internal */
export type Node = Directory | RegularFile | SymbolicLink

// The whole volume as one value. A transition builds the next value; nothing is published until it is installed.
/** @internal */
export interface VolumeState {
  readonly inodes: InodeTable.InodeTable<Node>
  // Handles holding a file open; an unlinked file stays in the table, and in the live image, while any does.
  readonly open: ReadonlyMap<Ino, number>
  readonly nextInode: Ino
  readonly revision: bigint
  readonly entries: number
  readonly usedBytes: bigint
}

/** @internal */
export const getNode = (state: VolumeState, ino: Ino): Node | undefined => InodeTable.get(state.inodes, ino)

/** @internal */
export const byIno = (a: Node, b: Node) => a.ino - b.ino

// Orders a directory's entries by the bytes of their names; the hex spelling keeps that order.
/** @internal */
export const byEntryName = ([a]: readonly [string, Ino], [b]: readonly [string, Ino]) => (a < b ? -1 : a > b ? 1 : 0)

const inNameOrder = (entries: ReadonlyMap<string, Ino>) => {
  let previous: string | undefined

  for (const name of entries.keys()) {
    if (previous !== undefined && previous > name) return false
    previous = name
  }

  return true
}

// A directory listing its entries in the byte order of their names, as every restored or decoded volume lists them.
const inEntryOrder = (directory: Directory): Directory =>
  inNameOrder(directory.entries)
    ? directory
    : { ...directory, entries: new Map([...directory.entries].sort(byEntryName)) }

/** @internal */
export const directoryMetadata = (
  ino: bigint,
  uid: number,
  gid: number,
  mode: number,
  now: bigint
): NodeMetadata => ({
  kind: "directory",
  ino,
  uid,
  gid,
  mode,
  nlink: 2,
  size: 0n,
  atimeNs: now,
  mtimeNs: now,
  ctimeNs: now,
  birthtimeNs: now
})

// The root of a volume that starts empty.
/** @internal */
export const emptyRoot = (now: bigint): Directory => ({
  kind: "directory",
  ino: ROOT_INO,
  parent: ROOT_INO,
  name: "",
  entries: new Map(),
  metadata: directoryMetadata(BigInt(ROOT_INO), 0, 0, 0o755, now),
  revision: 1n
})

/** @internal */
export const storedMetadata = (metadata: NodeMetadata): StoredMetadata => ({
  uid: metadata.uid,
  gid: metadata.gid,
  mode: metadata.mode,
  atimeNs: metadata.atimeNs,
  mtimeNs: metadata.mtimeNs,
  ctimeNs: metadata.ctimeNs,
  birthtimeNs: metadata.birthtimeNs
})

// Every node a name reaches, the root first and each once. The value is immutable, so the walk needs no permit.
/** @internal */
export const reachableNodes = Effect.fnUntraced(function*(state: VolumeState) {
  const nodes: Array<Node> = []
  const seen = new Set<Ino>([ROOT_INO])
  const pending: Array<Ino> = [ROOT_INO]

  for (let index = 0; index < pending.length; index++) {
    if (index % WALK_YIELD_INTERVAL === 0) yield* Effect.yieldNow
    const ino = pending[index]
    const node = ino === undefined ? undefined : getNode(state, ino)

    if (node === undefined) continue
    nodes.push(node)

    if (node.kind !== "directory") continue

    for (const child of node.entries.values()) {
      if (seen.has(child)) continue
      seen.add(child)
      pending.push(child)
    }
  }

  return nodes
})

// A node at the first revision, copied only when it is at another.
const atFirstRevision = (node: Node): Node => node.revision === 1n ? node : { ...node, revision: 1n }

// A value holding only what a name reaches, and the size of its largest file. A captured value keeps unlinked
// open files and detached directories a handle holds; a volume started from it has neither handle, so it starts
// without them. Each directory lists its entries in the byte order of their names, as a decoded tree's do, so a
// volume lists the same whether it was restored from a snapshot or from that snapshot's bytes. Its revisions start
// afresh at the first one, as a decoded tree's do, since a snapshot holds none. Every payload stays shared with the
// source; only a node whose revision is not the first, or a directory whose entries were in another order, is copied.
/** @internal */
export const reachableValue = Effect.fnUntraced(function*(source: VolumeState) {
  const nodes = yield* reachableNodes(source)
  const owner = Symbol()
  let inodes = InodeTable.empty<Node>()
  let entries = 0
  let usedBytes = 0n
  let largestFile = 0

  for (const node of nodes) {
    inodes = InodeTable.set(
      inodes,
      node.ino,
      atFirstRevision(node.kind === "directory" ? inEntryOrder(node) : node),
      owner
    )

    if (node.kind === "directory") entries += node.entries.size
    else if (node.kind === "symlink") usedBytes += BigInt(node.target.length)
    else {
      usedBytes += BigInt(node.data.bytes.length)
      largestFile = Math.max(largestFile, node.data.bytes.length)
    }
  }

  const state: VolumeState = {
    inodes,
    open: new Map(),
    nextInode: source.nextInode,
    revision: 1n,
    entries,
    usedBytes
  }

  return { state, largestFile }
})
