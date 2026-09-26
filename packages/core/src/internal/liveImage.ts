// The private image of a live volume: the snapshot's tree with every node's revision, the unlinked files still
// held open, and a runtime block with the volume's identity, counters, limits and usage.
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { VolumeLimits } from "../VirtualFileSystem.js"
import type { VolumeIdentity } from "../Volume.js"
import { decodeUtf8 } from "./bytes.js"
import { imageFailure } from "./errors.js"
import * as Tree from "./tree.js"
import { getNode, Ino, type Node, type RegularFile, type VolumeState } from "./volumeState.js"

// Open files that no name reaches any more; the live image keeps them until their final close.
/** @internal */
export const retainedFiles = (state: VolumeState): Array<RegularFile> => {
  const retained: Array<RegularFile> = []

  for (const ino of state.open.keys()) {
    const node = getNode(state, ino)

    if (node?.kind === "file" && node.links.length === 0) retained.push(node)
  }

  return retained
}

/** @internal */
export type StoredLimits = Tree.LiveTree["runtime"]["limits"]

// What a reopened volume starts from: its value, its identity, and the limits it was opened with.
/** @internal */
export interface Restored {
  readonly value: VolumeState
  readonly identity: VolumeIdentity
  readonly limits: StoredLimits
}

const JsonLiveTree = Schema.fromJsonString(Tree.LiveTree)

const decodeTree = Schema.decodeUnknownEffect(Tree.ValidLiveTree, { onExcessProperty: "error" })

const encoder = new TextEncoder()

const liveNode = (node: Node): Tree.LiveTreeNode => ({ ...Tree.treeNode(node), rev: node.revision })

/** @internal */
export const encode = Effect.fnUntraced(function*(state: VolumeState, identity: VolumeIdentity, limits: VolumeLimits) {
  const nodes = yield* Tree.treeNodes(state, retainedFiles(state))
  const stored: { -readonly [K in keyof StoredLimits]: StoredLimits[K] } = {}

  if (limits.maxEntries !== undefined) stored.maxEntries = limits.maxEntries

  if (limits.maxBytes !== undefined) stored.maxBytes = ByteSize.toBigInt(limits.maxBytes)

  stored.maxFileBytes = ByteSize.toBigInt(limits.maxFileBytes)

  if (limits.maxPathBytes !== undefined) stored.maxPathBytes = ByteSize.toBigInt(limits.maxPathBytes)

  const tree: Tree.LiveTree = {
    format: "effect-vfs-live",
    version: 1,
    runtime: {
      identity,
      nextInode: state.nextInode,
      revision: state.revision,
      limits: stored,
      usage: { entries: state.entries, usedBytes: state.usedBytes }
    },
    nodes: nodes.map(liveNode)
  }

  const text = yield* Schema.encodeEffect(JsonLiveTree)(tree).pipe(
    Effect.mapError((cause) => imageFailure("openImage", "InvalidStructure", { field: "liveImage", cause }))
  )

  return encoder.encode(text)
})

/** @internal */
export const decode = Effect.fnUntraced(function*(bytes: Uint8Array, maxEncodedBytes: ByteSize.ByteSize) {
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)) {
    return yield* imageFailure("openImage", "InvalidEncoding", { field: "liveImage" })
  }

  if (ByteSize.isGreaterThan(ByteSize.bytes(bytes.byteLength), maxEncodedBytes)) {
    return yield* imageFailure("openImage", "LimitExceeded", { field: "encodedBytes" })
  }

  const text = yield* decodeUtf8(
    bytes,
    (cause) => imageFailure("openImage", "InvalidEncoding", { field: "liveImage", cause })
  )

  const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError((cause) => imageFailure("openImage", "InvalidEncoding", { field: "liveImage", cause }))
  )

  const tree = yield* Effect.mapError(decodeTree(parsed), Tree.decodeFailure("openImage", "liveImage"))
  const { runtime } = tree

  // A previous process's handles no longer exist, so the unlinked files they held are reclaimed on reopening.
  const linked = tree.nodes.filter((node) => !Tree.TreeNode.guards.file(node) || node.links.length > 0)
  const value = yield* Tree.toValue(linked, "openImage")

  const restored: Restored = {
    value: { ...value, nextInode: Ino(runtime.nextInode), revision: runtime.revision },
    identity: runtime.identity,
    limits: runtime.limits
  }

  return restored
})
