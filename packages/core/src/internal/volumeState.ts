import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as Match from "effect/Match"
import { State } from "./engine.js"
import type { StoredMetadata } from "./metadata.js"

const { Ino, ROOT_INO, WALK_YIELD_INTERVAL, getNode, setNode, byEntryName, inEntryOrder } = State

type Ino = State.Ino

type Link = State.Link

type NodeMetadata = State.NodeMetadata

type Directory = State.Directory

type RegularFile = State.RegularFile

type SymbolicLink = State.SymbolicLink

type Node = State.Node

type VolumeState = State.VolumeState

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
  const inodes = HashMap.beginMutation(HashMap.empty<Ino, Node>())
  let entries = 0
  let usedBytes = 0n
  let largestFile = 0

  for (const node of nodes) {
    setNode(inodes, atFirstRevision(node.kind === "directory" ? inEntryOrder(node) : node))

    if (node.kind === "directory") entries += node.entries.size
    else if (node.kind === "symlink") usedBytes += BigInt(node.target.length)
    else {
      usedBytes += BigInt(node.data.length)
      largestFile = Math.max(largestFile, node.data.length)
    }
  }

  const state: VolumeState = {
    inodes: HashMap.endMutation(inodes),
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

  const inodes = HashMap.beginMutation(HashMap.empty<Ino, Node>())

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

    setNode(inodes, node)
  }

  return { inodes: HashMap.endMutation(inodes), open: new Map(), nextInode, revision, entries, usedBytes }
}
