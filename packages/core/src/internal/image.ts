// Snapshots: the opaque handle over a volume value, and its encoding as the lines of a tree.
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import { type Snapshot, SnapshotTypeId } from "../Snapshot.js"
import type { ImageFailure } from "../VfsError.js"
import type { Budget } from "./budget.js"
import { imageFailure } from "./errors.js"
import * as Lines from "./lines.js"
import * as Tree from "./tree.js"
import { assemble, type VolumeState } from "./volumeState.js"

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

// The header holds only literals, so its text is fixed.
const HEADER = JSON.stringify(Tree.SnapshotHeader.make({ format: "effect-vfs", version: 1 }))

const nodeText = Schema.encodeResult(Schema.fromJsonString(Tree.TreeNode))

// With a budget, the encoder charges every line as a decoder under that budget would, and fails where the decoder
// would refuse, so the bytes it produces decode under the budget without being decoded to find out.
/** @internal */
export const encodeSnapshotStream = (
  snapshot: Snapshot,
  budget?: Budget
): Stream.Stream<Uint8Array, ImageFailure> =>
  Stream.unwrap(Effect.gen(function*() {
    const nodes = yield* Tree.treeNodes(yield* valueOf(snapshot))
    const operation = "encodeSnapshot"

    return Tree.writeTree({
      operation,
      documentField: "text",
      header: HEADER,
      node: Tree.treeNode,
      text: nodeText,
      meter: budget === undefined ? undefined : Tree.meter(budget, operation)
    }, nodes)
  }))

/** @internal */
export const encodeSnapshot = (snapshot: Snapshot, budget?: Budget): Effect.Effect<Uint8Array, ImageFailure> =>
  Lines.collect(encodeSnapshotStream(snapshot, budget))

/** @internal */
export const decodeSnapshotSink = (budget: Budget): Sink.Sink<Snapshot, Uint8Array, never, ImageFailure> => {
  const operation = "decodeSnapshot"

  return Lines.sink({ operation, inputField: "input", textField: "text" }, () => {
    const meter = Tree.meter(budget, operation)
    const reader = Tree.snapshotReader({ operation, documentField: "document", meter })

    return {
      meter,
      fold: { line: reader.line, end: () => Result.map(reader.end(), (read) => make(assemble(read.specs))) }
    }
  })
}

/** @internal */
export const decodeSnapshot = (input: Uint8Array, budget: Budget): Effect.Effect<Snapshot, ImageFailure> =>
  Stream.run(Stream.succeed(input), decodeSnapshotSink(budget))
