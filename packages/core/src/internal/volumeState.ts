import * as Brand from "effect/Brand"
import * as Effect from "effect/Effect"
import * as Match from "effect/Match"
import * as Order from "effect/Order"
import type { Metadata } from "../Metadata.js"
import * as InodeTable from "./inodeTable.js"
import type { StoredMetadata } from "./metadata.js"

// An inode number: monotonic within a volume, never reused, and persisted by the snapshot and the live image. A
// number keys the inode table more cheaply than a bigint; the public metadata still reports it as one.
/** @internal */
export type Ino = number & Brand.Brand<"@effect-vfs/core/Ino">

/** @internal */
export const Ino = Brand.nominal<Ino>()

/** @internal */
export const ROOT_INO = Ino(1)

// The largest inode number a value holds. The allocator resumes one above it and must stay exactly representable,
// since the inode table is keyed by a number.
/** @internal */
export const MAX_INO = Number.MAX_SAFE_INTEGER - 1

// File sizes fit an unsigned 32-bit count in the volume and its public options.
/** @internal */
export const MAX_FILE_BYTES = 0xffffffff

// Nodes walked between yields. Whole-tree reads are one synchronous tick otherwise, which
// starves the event loop and leaves nothing for interruption to act on.
/** @internal */
export const WALK_YIELD_INTERVAL = 128

/** @internal */
export interface Link {
  readonly parent: Ino
  readonly name: string
}

/** @internal */
export type NodeMetadata = Omit<Metadata, "revision">

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
  readonly data: Uint8Array
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
export const byIno = Order.mapInput(Order.Number, (node: Node) => node.ino)

/** @internal */
export const byEntryName = Order.mapInput(Order.String, ([name]: readonly [string, Ino]) => name)

const inNameOrder = (entries: ReadonlyMap<string, Ino>) => {
  let previous: string | undefined

  for (const name of entries.keys()) {
    if (previous !== undefined && previous > name) return false
    previous = name
  }

  return true
}

const inEntryOrder = (directory: Directory): Directory =>
  inNameOrder(directory.entries)
    ? directory
    : { ...directory, entries: new Map([...directory.entries].sort(byEntryName)) }

/** @internal */
export const payloadOf = (node: Node): Uint8Array | undefined =>
  node.kind === "file" ? node.data : node.kind === "symlink" ? node.target : undefined

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
      usedBytes += BigInt(node.data.length)
      largestFile = Math.max(largestFile, node.data.length)
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

/** @internal */
export type NodeSpec =
  | {
    readonly kind: "directory"
    readonly ino: Ino
    readonly parent: Ino
    readonly name: string
    readonly metadata: StoredMetadata
    readonly revision: bigint
  }
  | {
    readonly kind: "file"
    readonly ino: Ino
    readonly links: ReadonlyArray<Link>
    readonly data: Uint8Array
    readonly metadata: StoredMetadata
    readonly revision: bigint
  }
  | {
    readonly kind: "symlink"
    readonly ino: Ino
    readonly links: ReadonlyArray<Link>
    readonly target: Uint8Array
    readonly metadata: StoredMetadata
    readonly revision: bigint
  }

// Builds the value a set of nodes describes. The caller has checked that the nodes form a tree under the root:
// every parent is a directory among them, no directory holds a name twice, and every directory reaches the root.
// Each directory lists its entries in the byte order of their names, so the value does not depend on the order
// the nodes arrive in. Link counts and sizes come from the nodes, and the allocator resumes past the largest inode.
/** @internal */
export const assemble = (specs: ReadonlyArray<NodeSpec>): VolumeState => {
  const edges = new Map<Ino, Array<readonly [string, Ino]>>()
  const subdirectories = new Map<Ino, number>()
  let entries = 0
  let usedBytes = 0n
  let nextInode = Ino(ROOT_INO + 1)
  let revision = 1n

  const attach = (parent: Ino, name: string, child: Ino) => {
    const listed = edges.get(parent)

    if (listed === undefined) edges.set(parent, [[name, child]])
    else listed.push([name, child])
    entries++
  }

  for (const spec of specs) {
    if (spec.ino >= nextInode) nextInode = Ino(spec.ino + 1)

    if (spec.revision > revision) revision = spec.revision

    if (spec.kind === "directory") {
      if (spec.ino === ROOT_INO) continue
      attach(spec.parent, spec.name, spec.ino)
      subdirectories.set(spec.parent, (subdirectories.get(spec.parent) ?? 0) + 1)
    } else {
      usedBytes += BigInt(spec.kind === "file" ? spec.data.length : spec.target.length)

      for (const link of spec.links) attach(link.parent, link.name, spec.ino)
    }
  }

  const owner = Symbol()
  let inodes = InodeTable.empty<Node>()

  for (const spec of specs) {
    const base = { ...spec.metadata, ino: BigInt(spec.ino) }

    const node: Node = Match.value(spec).pipe(
      Match.discriminator("kind")("directory", (directory): Directory => ({
        kind: "directory",
        ino: directory.ino,
        parent: directory.parent,
        name: directory.name,
        entries: new Map((edges.get(directory.ino) ?? []).sort(byEntryName)),
        metadata: { ...base, kind: "directory", nlink: 2 + (subdirectories.get(directory.ino) ?? 0), size: 0n },
        revision: directory.revision
      })),
      Match.discriminator("kind")("file", (file): RegularFile => ({
        kind: "file",
        ino: file.ino,
        data: file.data,
        links: file.links,
        metadata: { ...base, kind: "file", nlink: file.links.length, size: BigInt(file.data.length) },
        revision: file.revision
      })),
      Match.discriminator("kind")("symlink", (symlink): SymbolicLink => ({
        kind: "symlink",
        ino: symlink.ino,
        target: symlink.target,
        links: symlink.links,
        metadata: { ...base, kind: "symlink", nlink: symlink.links.length, size: BigInt(symlink.target.length) },
        revision: symlink.revision
      })),
      Match.exhaustive
    )

    inodes = InodeTable.set(inodes, spec.ino, node, owner)
  }

  return { inodes, open: new Map(), nextInode, revision, entries, usedBytes }
}
