import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import { decodeOption } from "../BytePath.js"
import type { FixtureEntry } from "../Fixture.js"
import { type Snapshot, SnapshotTypeId } from "../Snapshot.js"
import type { FsFailure, ImageFailure } from "../VfsError.js"
import type { PathInput } from "../VirtualFileSystem.js"
import type { Budget } from "./budget.js"
import { make as makeBytePath } from "./bytePath.js"
import { fsFailure, imageFailure } from "./errors.js"
import * as Lines from "./lines.js"
import {
  DOT_DOT_HEX,
  DOT_HEX,
  joinPath,
  MAX_SYMLINK_TRAVERSALS,
  nameBytes,
  ownedPath,
  type PreparedPath,
  preparePath
} from "./path.js"
import * as Tree from "./tree.js"
import {
  assemble,
  byEntryName,
  getNode,
  type Ino,
  type Node,
  ROOT_INO,
  storedMetadata,
  type VolumeState
} from "./volumeState.js"

// Volume values are immutable, so snapshots share them without exposing their state.
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

const HEADER = JSON.stringify(Tree.SnapshotHeader.make({ format: "effect-vfs", version: 1 }))

const nodeText = Schema.encodeResult(Schema.fromJsonString(Tree.TreeNode))

// Charge encoded lines by decoder rules so any successful output fits the same budget.
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

const OPERATION = "snapshotEntries"

const encoder = new TextEncoder()

// Match privileged lookup: follow intermediate links, honor trailing slashes, and leave the final link intact.
const resolve = (value: VolumeState, input: PathInput): Result.Result<Node, FsFailure> => {
  const fail = (code: FsFailure["code"]) => Result.fail(fsFailure(code, OPERATION, { path: input }))
  const prepared = preparePath(input, OPERATION, undefined)

  if (Result.isFailure(prepared)) return Result.fail(prepared.failure)
  const root = getNode(value, ROOT_INO)!
  let work: PreparedPath = prepared.success
  let current = root
  let traversals = 0

  for (let index = 0; index < work.components.length; index++) {
    if (current.kind !== "directory") return fail("NotDirectory")
    const component = work.components[index]!

    if (component === DOT_HEX) continue

    if (component === DOT_DOT_HEX) {
      current = getNode(value, current.parent)!
      continue
    }

    const ino = current.entries.get(component)
    const child = ino === undefined ? undefined : getNode(value, ino)

    if (child === undefined) return fail("NotFound")

    if (child.kind !== "symlink" || (index === work.components.length - 1 && !work.trailingSlash)) {
      current = child
      continue
    }

    if (child.target.length === 0) return fail("NotFound")

    if (++traversals > MAX_SYMLINK_TRAVERSALS) return fail("SymlinkLoop")
    const suffix = work.suffixes[index] ?? new Uint8Array(0)
    const expansion = new Uint8Array(child.target.length + suffix.length)
    expansion.set(child.target)
    expansion.set(suffix, child.target.length)
    const expanded = preparePath(ownedPath(expansion), OPERATION, undefined)

    if (Result.isFailure(expanded)) return fail(expanded.failure.code)
    work = expanded.success

    if (work.absolute) current = root
    index = -1
  }

  return work.trailingSlash && current.kind !== "directory" ? fail("NotDirectory") : Result.succeed(current)
}

const text = (bytes: Uint8Array): string | undefined => Option.getOrUndefined(decodeOption(bytes))

type WalkPath = string | Uint8Array

const childPath = (parent: WalkPath, name: Uint8Array): WalkPath => {
  const named = text(name)

  if (Predicate.isString(parent) && named !== undefined) return parent === "/" ? `/${named}` : `${parent}/${named}`

  return joinPath(Predicate.isString(parent) ? encoder.encode(parent) : parent, name)
}

const pathInput = (path: WalkPath): PathInput => (Predicate.isString(path) ? path : makeBytePath(path))

// Emit the first hard-link path as content and later paths as links; copy file bytes only on pull.
function* walk(value: VolumeState, node: Node): Generator<FixtureEntry> {
  const pending: Array<readonly [Node, WalkPath]> = [[node, "/"]]
  const first = new Map<Ino, PathInput>()

  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [current, walked] = next
    const path = pathInput(walked)
    const metadata = storedMetadata(current.metadata)

    if (current.kind === "directory") {
      yield { kind: "directory", path, metadata }
      const children = [...current.entries].sort(byEntryName).reverse()

      for (const [name, ino] of children) pending.push([getNode(value, ino)!, childPath(walked, nameBytes(name))])
      continue
    }

    const alias = current.links.length > 1 ? first.get(current.ino) : undefined

    if (alias !== undefined) {
      yield { kind: "hardLink", path, target: alias }
      continue
    }

    if (current.links.length > 1) first.set(current.ino, path)

    if (current.kind === "file") yield { kind: "file", path, bytes: current.data.slice(), metadata }
    else {
      const target = text(current.target)
      yield { kind: "symlink", path, target: target ?? makeBytePath(current.target.slice()), metadata }
    }
  }
}

/** @internal */
export const snapshotEntries = (
  snapshot: Snapshot,
  root: PathInput
): Stream.Stream<FixtureEntry, FsFailure | ImageFailure> =>
  Stream.unwrap(Effect.gen(function*() {
    const value = yield* valueOf(snapshot)
    const node = yield* Effect.fromResult(resolve(value, root))

    // Bound each pulled chunk to one file's copied bytes.
    return Stream.fromIterable({ [Symbol.iterator]: () => walk(value, node) }, { chunkSize: 1 })
  }))
