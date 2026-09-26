// Snapshots: the opaque handle over a volume value, and its encoding as a tree document.
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { DecodeLimits, type Snapshot, SnapshotTypeId } from "../Snapshot.js"
import type { ImageFailure } from "../VfsError.js"
import { decodeUtf8 } from "./bytes.js"
import { CanonicalBase64 } from "./canonicalBase64.js"
import { decodeConfiguration, imageFailure } from "./errors.js"
import * as Tree from "./tree.js"
import type { VolumeState } from "./volumeState.js"

// A snapshot is the volume value it was captured from. The value is immutable, so capture shares it rather than
// copying it, and the private field keeps it out of reach of anything but this module.
class SnapshotImpl implements Snapshot {
  readonly [SnapshotTypeId]: SnapshotTypeId = SnapshotTypeId
  readonly #value: VolumeState

  constructor(value: VolumeState) {
    this.#value = value
  }

  static valueOf(snapshot: Snapshot): VolumeState | undefined {
    return #value in snapshot ? snapshot.#value : undefined
  }
}

/** @internal */
export const make = (value: VolumeState): Snapshot => Object.freeze(new SnapshotImpl(value))

/** @internal */
export const valueOf = (snapshot: Snapshot): Effect.Effect<VolumeState, ImageFailure> =>
  Effect.suspend(() => {
    const value = SnapshotImpl.valueOf(snapshot)

    return value === undefined
      ? imageFailure("decodeSnapshot", "InvalidStructure", { field: "snapshot" })
      : Effect.succeed(value)
  })

const VersionProbe = Schema.Struct({
  format: Schema.Literal("effect-vfs"),
  version: Schema.Unknown
})

const JsonTree = Schema.fromJsonString(Tree.Tree)

// The tree's shape alone: its graph rules are checked once the budgets have accepted it.
const decodeTree = Schema.decodeUnknownEffect(Tree.Tree, { onExcessProperty: "error" })

const encoder = new TextEncoder()

// Counts what restoring a tree would hold against the budgets, from the base64 lengths alone.
const withinBudget = Effect.fnUntraced(function*(tree: Tree.Tree, limits: DecodeLimits) {
  if (tree.nodes.length > limits.maxRecords) {
    return yield* imageFailure("decodeSnapshot", "LimitExceeded", { field: "records" })
  }

  let entries = 0
  let decoded = ByteSize.zero

  const charge = (value: typeof CanonicalBase64.Encoded.Type) => {
    decoded = ByteSize.sum(decoded, ByteSize.bytes(CanonicalBase64.decodedLength(value)))
  }

  for (const [index, node] of tree.nodes.entries()) {
    const linkNames = (links: ReadonlyArray<{ readonly name: typeof CanonicalBase64.Encoded.Type }>) =>
      links.map((link) => link.name)

    const [names, payload] = Tree.TreeNode.match(node, {
      directory: (directory) => [index === 0 ? [] : [directory.name], undefined] as const,
      file: (file) => [linkNames(file.links), Tree.inlineBytes(file.content)] as const,
      symlink: (symlink) => [linkNames(symlink.links), symlink.target] as const
    })

    entries += names.length

    for (const name of names) charge(name)

    if (payload !== undefined) charge(payload)
  }

  if (entries > limits.maxEntries) return yield* imageFailure("decodeSnapshot", "LimitExceeded", { field: "entries" })

  if (ByteSize.isGreaterThan(decoded, limits.maxDecodedBytes)) {
    return yield* imageFailure("decodeSnapshot", "LimitExceeded", { field: "bytes" })
  }
})

/** @internal */
export const encodeSnapshot = Effect.fn("VirtualFileSystem.encodeSnapshot")(function*(snapshot: Snapshot) {
  const nodes = yield* Tree.treeNodes(yield* valueOf(snapshot))
  const tree: Tree.Tree = { format: "effect-vfs", version: 1, nodes: nodes.map(Tree.treeNode) }

  const text = yield* Schema.encodeEffect(JsonTree)(tree).pipe(
    Effect.mapError((cause) => imageFailure("decodeSnapshot", "InvalidStructure", { field: "text", cause }))
  )

  return encoder.encode(text)
})

/** @internal */
export const decodeSnapshot = Effect.fn("VirtualFileSystem.decodeSnapshot")(
  function*(input: Uint8Array, limits: DecodeLimits) {
    const checked = yield* Effect.fromResult(decodeConfiguration(DecodeLimits, limits, "decodeSnapshot"))

    if (!(input instanceof Uint8Array) || !(input.buffer instanceof ArrayBuffer)) {
      return yield* imageFailure("decodeSnapshot", "InvalidEncoding", { field: "input" })
    }

    if (ByteSize.isGreaterThan(ByteSize.bytes(input.byteLength), checked.maxEncodedBytes)) {
      return yield* imageFailure("decodeSnapshot", "LimitExceeded", { field: "encodedBytes" })
    }

    const text = yield* decodeUtf8(
      input,
      (cause) => imageFailure("decodeSnapshot", "InvalidEncoding", { field: "text", cause })
    )

    const value = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
      Effect.mapError((cause) => imageFailure("decodeSnapshot", "InvalidEncoding", { field: "text", cause }))
    )

    const version = Schema.decodeUnknownResult(VersionProbe)(value)

    if (Result.isSuccess(version) && version.success.version !== 1) {
      return yield* imageFailure("decodeSnapshot", "UnsupportedVersion", { field: "version" })
    }

    const tree = yield* Effect.mapError(decodeTree(value), Tree.decodeFailure("decodeSnapshot", "document"))
    yield* withinBudget(tree, checked)
    yield* Tree.checkGraph(tree, "decodeSnapshot")

    return make(yield* Tree.toValue(tree.nodes, "decodeSnapshot"))
  }
)
