// A snapshot's tree read straight from its value, without restoring a volume: the entries under a root in sorted
// pre-order, with paths rooted at the root, as fixture entries a volume can be built from again.
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import { decodeOption } from "../BytePath.js"
import type { FixtureEntry } from "../Fixture.js"
import type { Snapshot } from "../Snapshot.js"
import type { FsFailure, ImageFailure } from "../VfsError.js"
import type { PathInput } from "../VirtualFileSystem.js"
import { make as makeBytePath } from "./bytePath.js"
import { fsFailure } from "./errors.js"
import * as Image from "./image.js"
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
import { byEntryName, getNode, type Ino, type Node, ROOT_INO, storedMetadata, type VolumeState } from "./volumeState.js"

const OPERATION = "snapshotEntries"

const encoder = new TextEncoder()

// The node `input` names, resolved as a privileged caller at the root of a volume restored from the snapshot with
// default options would resolve it without following a final symbolic link: intermediate links are followed, a
// trailing slash asks for a directory, and no path byte limit applies. This repeats the engine's lookup without its
// permission checks and creation hooks; a test compares the two over a table of roots, so a drift between them
// fails it.
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

// A path stays a string while every name on it is UTF-8, and is a byte path from the first name that is not.
type WalkPath = string | Uint8Array

const childPath = (parent: WalkPath, name: Uint8Array): WalkPath => {
  const named = text(name)

  if (Predicate.isString(parent) && named !== undefined) return parent === "/" ? `/${named}` : `${parent}/${named}`

  return joinPath(Predicate.isString(parent) ? encoder.encode(parent) : parent, name)
}

const pathInput = (path: WalkPath): PathInput => (Predicate.isString(path) ? path : makeBytePath(path))

// The entries under `node`, each built when the stream pulls it, so a file's bytes are copied only then. The first
// path of a node more than one name reaches carries it; its later paths are hard links to that path.
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

    if (current.kind === "file") yield { kind: "file", path, bytes: current.data.bytes.slice(), metadata }
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
    const value = yield* Image.valueOf(snapshot)
    const node = yield* Effect.fromResult(resolve(value, root))

    // One entry to a chunk: a pulled chunk holds at most one file's copied bytes.
    return Stream.fromIterable({ [Symbol.iterator]: () => walk(value, node) }, { chunkSize: 1 })
  }))
