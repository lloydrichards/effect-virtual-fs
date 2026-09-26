// The private image of a live volume: the snapshot's tree with every node's revision and the unlinked files still
// held open, after a first line that holds the header and the runtime block with the volume's identity, epoch, key
// secret, counters, limits and usage. It is one document, so a store keeps it as one blob.
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { VolumeLimits } from "../VirtualFileSystem.js"
import type { VolumeIdentity } from "../Volume.js"
import type { KeySecret, VolumeEpoch } from "./hex128.js"
import * as Lines from "./lines.js"
import * as Tree from "./tree.js"
import { assemble, getNode, Ino, type Node, type RegularFile, type VolumeState } from "./volumeState.js"

const OPERATION = "openImage"

const DOCUMENT_FIELD = "liveImage"

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

type StoredLimits = Tree.Runtime["limits"]

// What names a volume's objects outside the process: its identity, the epoch of its inode numbers, and the secret
// its reference-key tags are computed under. One record, so no two of them can swap places at a call.
/** @internal */
export interface Naming {
  readonly identity: VolumeIdentity
  readonly epoch: VolumeEpoch
  readonly keySecret: KeySecret
}

// What a reopened volume starts from: its value, its naming, and the limits it was opened with.
/** @internal */
export interface Restored extends Naming {
  readonly value: VolumeState
  readonly limits: StoredLimits
}

const headerText = Schema.encodeResult(Schema.fromJsonString(Tree.LiveHeader))

const nodeText = Schema.encodeResult(Schema.fromJsonString(Tree.LiveTreeNode))

const liveNode = (node: Node): Tree.LiveTreeNode => ({ ...Tree.treeNode(node), rev: node.revision })

/** @internal */
export const encode = Effect.fnUntraced(function*(
  state: VolumeState,
  { epoch, identity, keySecret }: Naming,
  limits: VolumeLimits
) {
  const nodes = yield* Tree.treeNodes(state, retainedFiles(state))
  const stored: { -readonly [K in keyof StoredLimits]: StoredLimits[K] } = {}

  if (limits.maxEntries !== undefined) stored.maxEntries = limits.maxEntries

  if (limits.maxBytes !== undefined) stored.maxBytes = ByteSize.toBigInt(limits.maxBytes)

  stored.maxFileBytes = ByteSize.toBigInt(limits.maxFileBytes)

  if (limits.maxPathBytes !== undefined) stored.maxPathBytes = ByteSize.toBigInt(limits.maxPathBytes)

  const header = yield* Effect.fromResult(headerText({
    format: "effect-vfs-live",
    version: 1,
    runtime: {
      identity,
      epoch,
      keySecret,
      nextInode: state.nextInode,
      revision: state.revision,
      limits: stored,
      usage: { entries: state.entries, usedBytes: state.usedBytes }
    }
  })).pipe(
    Effect.mapError((cause) => Tree.encodeFailure(OPERATION, DOCUMENT_FIELD, cause))
  )

  return yield* Lines.collect(Tree.writeTree({
    operation: OPERATION,
    documentField: DOCUMENT_FIELD,
    header,
    node: liveNode,
    text: nodeText,
    meter: undefined
  }, nodes))
})

// A live image holds no more than its bytes, and its runtime block bounds the rest, so the store's byte bound is
// the only budget a reader applies to it.
const imageBudget = (maxEncodedBytes: ByteSize.ByteSize) => ({
  encodedBytes: maxEncodedBytes,
  lineBytes: maxEncodedBytes,
  decodedBytes: maxEncodedBytes,
  records: Number.MAX_SAFE_INTEGER,
  entries: Number.MAX_SAFE_INTEGER
})

/** @internal */
export const decode = (bytes: Uint8Array, maxEncodedBytes: ByteSize.ByteSize) =>
  Stream.run(
    Stream.succeed(bytes),
    Lines.sink({ operation: OPERATION, inputField: DOCUMENT_FIELD, textField: DOCUMENT_FIELD }, () => {
      const reader = Tree.liveReader({ operation: OPERATION, documentField: DOCUMENT_FIELD })

      return {
        meter: Tree.meter(imageBudget(maxEncodedBytes), OPERATION),
        fold: {
          line: reader.line,
          end: () =>
            Result.map(reader.end(), ({ header: { runtime }, specs }): Restored => {
              const value = assemble(specs)

              return {
                value: { ...value, nextInode: Ino(runtime.nextInode), revision: runtime.revision },
                identity: runtime.identity,
                epoch: runtime.epoch,
                keySecret: runtime.keySecret,
                limits: runtime.limits
              }
            })
        }
      }
    })
  )
