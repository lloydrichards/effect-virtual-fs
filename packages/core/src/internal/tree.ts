// The one tree codec: a volume value as a header line and then one line per node, the nodes in inode order, each
// naming the directory entries that reach it. A snapshot is this tree; the live image's header adds the runtime
// state a reopened volume resumes from. Names, payloads and targets are canonical base64 on the wire and become
// bytes as each line is read. A reader checks every line as it arrives, against the rules one node can break and
// against the budget, so input that breaks either is refused at that line; the rules that span nodes, such as a
// name's parent being a directory or every directory reaching the root, are checked once the last line is read.
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as Stream from "effect/Stream"
import type { ImageFailure } from "../VfsError.js"
import { VolumeIdentity } from "../Volume.js"
import type { Budget } from "./budget.js"
import { CanonicalBase64 } from "./canonicalBase64.js"
import { ENCODING_CHECK, imageFailure, isEncodingIssue, issueSite } from "./errors.js"
import { byteLimit, encodeLine, frame, type FrameMeter, type LineFold } from "./lines.js"
import { StoredMetadata } from "./metadata.js"
import { isNameBytes, MAX_NAME_BYTES, nameBytes, NUL_BYTE } from "./path.js"
import {
  byIno,
  Ino,
  type Link,
  MAX_INO,
  type Node,
  type NodeSpec,
  reachableNodes,
  ROOT_INO,
  storedMetadata,
  type VolumeState,
  WALK_YIELD_INTERVAL
} from "./volumeState.js"

/** @internal */
export const TreeIno = Schema.Int.check(Schema.isBetween({ minimum: ROOT_INO, maximum: MAX_INO }))

/** @internal */
export const NaturalBigInt = Schema.String.check(
  Schema.isPattern(/^(0|[1-9][0-9]{0,127})$/, { [ENCODING_CHECK]: true })
).pipe(Schema.decodeTo(Schema.BigInt, SchemaTransformation.bigintFromString))

const TreeLink = Schema.Struct({ parent: TreeIno, name: CanonicalBase64.Encoded })

// A file's bytes inline, or a reference to content stored elsewhere. The reference is reserved for
// content-addressed storage: the schema knows its shape so a line holding one is refused by name.
const TreeContent = Schema.TaggedUnion({
  Inline: { bytes: CanonicalBase64.Encoded },
  Ref: { hash: Schema.String, size: Schema.Natural }
})

const inlineBytes = (content: typeof TreeContent.Type): typeof CanonicalBase64.Encoded.Type | undefined =>
  Predicate.isTagged(content, "Inline") ? content.bytes : undefined

const directory = { ino: TreeIno, parent: TreeIno, name: CanonicalBase64.Encoded, metadata: StoredMetadata }

const file = { ino: TreeIno, links: Schema.Array(TreeLink), content: TreeContent, metadata: StoredMetadata }

const symlink = {
  ino: TreeIno,
  links: Schema.Array(TreeLink),
  target: CanonicalBase64.Encoded,
  metadata: StoredMetadata
}

// A snapshot holds no revisions: they are runtime state that restoring starts afresh.
/** @internal */
export const TreeNode = Schema.TaggedUnion({ directory, file, symlink })

/** @internal */
export type TreeNode = typeof TreeNode.Type

// The tag alone tells the kinds apart: a schema guard would validate the whole node again, once per line.
const isDirectory = Predicate.isTagged("directory")

const isFile = Predicate.isTagged("file")

const isSymlink = Predicate.isTagged("symlink")

// A live image keeps each node's revision, so a reopened volume's references and caches stay valid.
const rev = { rev: NaturalBigInt }

/** @internal */
export const LiveTreeNode = Schema.TaggedUnion({
  directory: { ...directory, ...rev },
  file: { ...file, ...rev },
  symlink: { ...symlink, ...rev }
})

/** @internal */
export type LiveTreeNode = typeof LiveTreeNode.Type

/** @internal */
export const SnapshotHeader = Schema.Struct({ format: Schema.Literal("effect-vfs"), version: Schema.Literal(1) })

// What a reopened volume resumes from besides its nodes: its identity, the allocator and revision counters, the
// limits it was opened with, and the usage those limits were checked against.
const Runtime = Schema.Struct({
  identity: VolumeIdentity,
  // The allocator must stay exactly representable, since the engine keys its inode table by a number.
  nextInode: Schema.Int.check(Schema.isBetween({ minimum: ROOT_INO + 1, maximum: Number.MAX_SAFE_INTEGER })),
  revision: NaturalBigInt,
  limits: Schema.Struct({
    maxEntries: Schema.optionalKey(Schema.Natural),
    maxBytes: Schema.optionalKey(NaturalBigInt),
    maxFileBytes: Schema.optionalKey(NaturalBigInt),
    maxPathBytes: Schema.optionalKey(NaturalBigInt)
  }),
  usage: Schema.Struct({ entries: Schema.Natural, usedBytes: NaturalBigInt })
})

/** @internal */
export type Runtime = typeof Runtime.Type

// The live image's first line is its header and runtime block together, so a reader knows every runtime bound
// before it reads a node.
/** @internal */
export const LiveHeader = Schema.Struct({
  format: Schema.Literal("effect-vfs-live"),
  version: Schema.Literal(1),
  runtime: Runtime
})

const VersionProbe = Schema.Struct({ format: Schema.Literal("effect-vfs"), version: Schema.Unknown })

const STRICT = { onExcessProperty: "error" } as const

// The budget a tree's lines are charged against: the one enforcer both directions share, so an encoder that meters
// what it writes refuses exactly what a reader under the same budget would.
/** @internal */
export interface Meter extends FrameMeter {
  // One node, counted from the base64 lengths of its names and payload before any of them is decoded.
  readonly node: (node: TreeNode) => Result.Result<void, ImageFailure>
}

/** @internal */
export const meter = (budget: Budget, operation: string): Meter => {
  const fail = (field: string) => Result.fail(imageFailure(operation, "LimitExceeded", { field }))
  const encodedBytes = byteLimit(budget.encodedBytes)
  const lineBytes = byteLimit(budget.lineBytes)
  const decodedBytes = byteLimit(budget.decodedBytes)
  let encoded = 0
  let records = 0
  let entries = 0
  let decoded = 0

  const charge = (value: typeof CanonicalBase64.Encoded.Type | undefined) => {
    if (value !== undefined) decoded += CanonicalBase64.decodedLength(value)
  }

  return {
    // A line is refused at the byte where it first crosses a bound, its own or the input's, so how the input was
    // chunked, and whether the line was written or read, does not change which bound it names. At the same byte the
    // input's bound is named, so a line bound left to default to the input's is never the one named.
    line: (bytes, ended) => {
      const read = encoded + bytes + (ended ? 1 : 0)
      // The byte of the line, counted from 1 and its newline included, at which each bound is crossed.
      const pastLine = bytes > lineBytes ? lineBytes + 1 : Number.POSITIVE_INFINITY
      const pastInput = read > encodedBytes ? encodedBytes - encoded + 1 : Number.POSITIVE_INFINITY

      if (pastInput !== Number.POSITIVE_INFINITY && pastInput <= pastLine) return fail("encodedBytes")

      if (pastLine !== Number.POSITIVE_INFINITY) return fail("lineBytes")

      if (ended) encoded = read

      return Result.void
    },
    node: (node) => {
      if (++records > budget.records) return fail("records")

      if (isDirectory(node)) {
        if (node.ino !== ROOT_INO) {
          entries++
          charge(node.name)
        }
      } else {
        entries += node.links.length

        for (const link of node.links) charge(link.name)
        charge(isFile(node) ? inlineBytes(node.content) : node.target)
      }

      if (entries > budget.entries) return fail("entries")

      return decoded > decodedBytes ? fail("bytes") : Result.void
    }
  }
}

// A name a reader has read, kept until the last line for the rules that span nodes.
interface Named {
  readonly parent: number
  readonly key: string
  readonly bytes: number
  // Where the name sits among the nodes, for the issue.
  readonly path: ReadonlyArray<PropertyKey>
  // The directory the name reaches, if it reaches one.
  readonly directory: number | undefined
}

interface Issue {
  readonly path: ReadonlyArray<PropertyKey>
  readonly issue: string
}

/** @internal */
export interface ReaderOptions {
  readonly operation: string
  // The field a line of the wrong shape or spelling names.
  readonly documentField: string
  // Charges a snapshot's budget; a live image is bounded by its runtime block instead.
  readonly meter?: Meter
}

// A read tree: its header, and the nodes to assemble into a value.
/** @internal */
export interface Read<H> {
  readonly header: H
  readonly specs: ReadonlyArray<NodeSpec>
}

const at = (path: ReadonlyArray<PropertyKey>, issue: string): Issue => ({ path: ["nodes", ...path], issue })

const ROOT_RULE = "the first node is the root directory, its own parent with an empty name"

// A line of the wrong shape or spelling names the codec's document field, as it always has.
const malformedLine = (options: ReaderOptions) => (error: Schema.SchemaError) =>
  imageFailure(options.operation, isEncodingIssue(issueSite(error.issue)) ? "InvalidEncoding" : "InvalidStructure", {
    field: options.documentField,
    cause: error
  })

// The rules every tree keeps, the first broken one reported at the node that broke it: the root directory comes
// first as its own parent with an empty name; inode numbers ascend without repeats; every name is a valid name held
// once by a directory in the tree; every directory reaches the root through its parents; every symbolic link, and
// every file unless the tree is a live image retaining unlinked files, has a name; no symbolic link target holds a
// NUL. A live image also keeps its runtime block: every inode lies below the allocator and every revision between
// 1 and the counter; the stored usage matches the nodes; and the nodes fit the limits the volume was opened with.
const makeReader = <H>(
  options: ReaderOptions,
  decodeHeader: (value: typeof Schema.Unknown.Type) => Result.Result<H, ImageFailure>,
  decodeNode: (
    value: typeof Schema.Unknown.Type
  ) => Result.Result<TreeNode & { readonly rev?: bigint }, Schema.SchemaError>,
  runtimeOf: (header: H) => Runtime | undefined
): LineFold<Read<H>> => {
  const { operation } = options
  const malformed = malformedLine(options)
  const specs: Array<NodeSpec> = []
  const names: Array<Named> = []
  // Each directory's parent and position, by inode number.
  const parents = new Map<number, number>()
  const positions = new Map<number, number>()
  let header: H | undefined
  let runtime: Runtime | undefined
  let count = 0
  let previous = 0
  let entries = 0
  let usedBytes = 0n

  const broken = (issue: Issue) =>
    Result.fail(
      imageFailure(operation, "InvalidStructure", { field: issue.path.map(String).join("."), cause: issue.issue })
    )

  // A name's hex key, once it is known to be a valid name.
  const named = (
    parent: number,
    name: typeof CanonicalBase64.Encoded.Type,
    path: ReadonlyArray<PropertyKey>,
    directory?: number
  ): Result.Result<string, ImageFailure> => {
    const length = CanonicalBase64.decodedLength(name)
    // The length is read from the base64 first, so an overlong name is refused without being decoded.
    const bytes = length < 1 || length > MAX_NAME_BYTES ? undefined : CanonicalBase64.toBytes(name)

    if (bytes === undefined || !isNameBytes(bytes)) {
      return broken(at([...path, "name"], "a name is 1 to 255 bytes without a NUL or a slash, and neither . nor .."))
    }

    const key = Encoding.encodeHex(bytes)
    names.push({ parent, key, bytes: bytes.length, path, directory })
    entries++

    return Result.succeed(key)
  }

  const read = (value: typeof Schema.Unknown.Type, index: number): Result.Result<void, ImageFailure> => {
    const decoded = decodeNode(value)

    if (Result.isFailure(decoded)) return Result.fail(malformed(decoded.failure))
    const node = decoded.success
    const charged = options.meter?.node(node) ?? Result.void

    if (Result.isFailure(charged)) return charged
    const revision = node.rev ?? 1n

    if (index === 0) {
      if (!isDirectory(node) || node.ino !== ROOT_INO || node.parent !== ROOT_INO || node.name !== "") {
        return broken(at([0], ROOT_RULE))
      }
    } else if (node.ino <= previous) return broken(at([index, "ino"], "nodes ascend by inode number without repeats"))

    if (runtime !== undefined && node.ino >= runtime.nextInode) {
      return broken(at([index, "ino"], "every inode lies below the allocator"))
    }

    if (runtime !== undefined && (revision < 1n || revision > runtime.revision)) {
      return broken(at([index, "rev"], "every revision lies between 1 and the counter"))
    }

    previous = node.ino
    count++
    const common = { ino: Ino(node.ino), metadata: node.metadata, revision }

    if (isDirectory(node)) {
      parents.set(node.ino, node.parent)
      positions.set(node.ino, index)
      const key = index === 0 ? Result.succeed("") : named(node.parent, node.name, [index], node.ino)

      return Result.map(key, (name) => {
        specs.push({ ...common, kind: "directory", parent: Ino(node.parent), name })
      })
    }

    // A live image keeps an unlinked file a handle held; reopening reclaims it, so it is counted and dropped.
    const retained = runtime !== undefined && isFile(node) && node.links.length === 0

    if (node.links.length === 0 && !retained) {
      return broken(at([index, "links"], "every file and symbolic link has a name"))
    }

    const links: Array<Link> = []

    for (const [position, link] of node.links.entries()) {
      const key = named(link.parent, link.name, [index, "links", position])

      if (Result.isFailure(key)) return Result.fail(key.failure)
      links.push({ parent: Ino(link.parent), name: key.success })
    }

    if (isSymlink(node)) {
      const target = CanonicalBase64.toBytes(node.target)

      if (target.includes(NUL_BYTE)) return broken(at([index, "target"], "a symbolic link's target holds no NUL"))
      usedBytes += BigInt(target.length)
      specs.push({ ...common, kind: "symlink", links, target })

      return Result.void
    }

    const bytes = inlineBytes(node.content)

    if (bytes === undefined) {
      return Result.fail(imageFailure(operation, "UnsupportedVersion", { field: `nodes.${index}.content` }))
    }

    const size = BigInt(CanonicalBase64.decodedLength(bytes))
    usedBytes += size

    if (runtime?.limits.maxFileBytes !== undefined && size > runtime.limits.maxFileBytes) {
      return broken(at([index, "content"], "every file fits maxFileBytes"))
    }

    if (!retained) specs.push({ ...common, kind: "file", links, data: CanonicalBase64.toBytes(bytes) })

    return Result.void
  }

  // The rules that span nodes: each name's parent is a directory, each directory holds a name once, and every
  // directory reaches the root.
  const graphIssue = (): Issue | undefined => {
    const held = new Set<string>()

    for (const name of names) {
      if (!parents.has(name.parent)) return at([...name.path, "parent"], "a name's parent is a directory in the tree")
      const key = `${name.parent}/${name.key}`

      if (held.has(key)) return at([...name.path, "name"], "a directory holds each name once")
      held.add(key)
    }

    // Parent chains end at the root; one that comes back to a directory it passed is a cycle nothing reaches.
    const reachesRoot = new Set<number>([ROOT_INO])

    for (const ino of parents.keys()) {
      const chain = new Set<number>()
      let current: number | undefined = ino

      while (current !== undefined && !reachesRoot.has(current)) {
        if (chain.has(current)) return at([positions.get(ino)!, "parent"], "every directory reaches the root")
        chain.add(current)
        current = parents.get(current)
      }

      for (const member of chain) reachesRoot.add(member)
    }
  }

  // Whether every path fits `maxPathBytes`, measured in one walk from the root: the root is "/", and each name below
  // it adds a slash and itself. The graph rules have already made the directories a tree under the root.
  const pathIssue = (maxPathBytes: bigint): Issue | undefined => {
    const below = new Map<number, Array<Named>>()

    for (const name of names) {
      const listed = below.get(name.parent)

      if (listed === undefined) below.set(name.parent, [name])
      else listed.push(name)
    }

    const pending: Array<readonly [number, bigint]> = [[ROOT_INO, 1n]]

    // Index loop: `pending` grows while it is being walked.
    for (let index = 0; index < pending.length; index++) {
      const [parent, parentBytes] = pending[index]!

      for (const name of below.get(parent) ?? []) {
        const bytes = (parent === ROOT_INO ? parentBytes : parentBytes + 1n) + BigInt(name.bytes)

        if (bytes > maxPathBytes) return at([...name.path, "name"], "every path fits maxPathBytes")

        if (name.directory !== undefined) pending.push([name.directory, bytes])
      }
    }
  }

  const runtimeIssue = ({ limits, usage }: Runtime): Issue | undefined => {
    const issue = (path: ReadonlyArray<PropertyKey>, issue: string): Issue => ({ path: ["runtime", ...path], issue })

    if (entries !== usage.entries) return issue(["usage", "entries"], "the stored entry count matches the nodes")

    if (usedBytes !== usage.usedBytes) return issue(["usage", "usedBytes"], "the stored byte count matches the nodes")

    if (limits.maxEntries !== undefined && entries > limits.maxEntries) {
      return issue(["limits", "maxEntries"], "the entries fit maxEntries")
    }

    if (limits.maxBytes !== undefined && usedBytes > limits.maxBytes) {
      return issue(["limits", "maxBytes"], "the bytes fit maxBytes")
    }

    if (limits.maxPathBytes !== undefined) {
      return limits.maxPathBytes < 1n
        ? issue(["limits", "maxPathBytes"], "the path limit admits the root")
        : pathIssue(limits.maxPathBytes)
    }
  }

  return {
    line: (value, index) => {
      if (index > 0) return read(value, index - 1)

      return Result.map(decodeHeader(value), (decoded) => {
        header = decoded
        runtime = runtimeOf(decoded)
      })
    },
    end: () => {
      if (header === undefined) {
        return Result.fail(imageFailure(operation, "InvalidStructure", { field: options.documentField }))
      }

      if (count === 0) return broken(at([0], ROOT_RULE))
      const issue = graphIssue() ?? (runtime === undefined ? undefined : runtimeIssue(runtime))

      return issue === undefined ? Result.succeed({ header, specs }) : broken(issue)
    }
  }
}

// A snapshot's header names its format and version. A header of this format with another version is refused as
// unsupported before its shape is checked, so a later version fails the same way whatever else it adds.
/** @internal */
export const snapshotReader = (options: ReaderOptions): LineFold<Read<typeof SnapshotHeader.Type>> =>
  makeReader(
    options,
    (value) => {
      const version = Schema.decodeUnknownResult(VersionProbe)(value)

      if (Result.isSuccess(version) && version.success.version !== 1) {
        return Result.fail(imageFailure(options.operation, "UnsupportedVersion", { field: "version" }))
      }

      return Result.mapError(Schema.decodeUnknownResult(SnapshotHeader, STRICT)(value), malformedLine(options))
    },
    Schema.decodeUnknownResult(TreeNode, STRICT),
    () => undefined
  )

// A live image is private, so any header but this version's is simply malformed.
/** @internal */
export const liveReader = (options: ReaderOptions): LineFold<Read<typeof LiveHeader.Type>> =>
  makeReader(
    options,
    (value) =>
      Result.flatMap(
        Result.mapError(Schema.decodeUnknownResult(LiveHeader, STRICT)(value), malformedLine(options)),
        (header) =>
          header.runtime.revision < 1n
            ? Result.fail(imageFailure(options.operation, "InvalidStructure", { field: "runtime.revision" }))
            : Result.succeed(header)
      ),
    Schema.decodeUnknownResult(LiveTreeNode, STRICT),
    (header) => header.runtime
  )

const encodeName = (name: string) => CanonicalBase64.encode(nameBytes(name))

// A node built from a value is valid by construction, so building it skips the schema's checks.
/** @internal */
export const UNCHECKED = { disableChecks: true }

/** @internal */
export const treeNode = (node: Node): TreeNode => {
  const metadata = storedMetadata(node.metadata)

  if (node.kind === "directory") {
    return TreeNode.cases.directory.make(
      { ino: node.ino, parent: node.parent, name: encodeName(node.name), metadata },
      UNCHECKED
    )
  }

  const named = node.links.map((link) => ({ parent: link.parent, name: encodeName(link.name) }))

  return node.kind === "file"
    ? TreeNode.cases.file.make({
      ino: node.ino,
      links: named,
      content: TreeContent.cases.Inline.make({ bytes: CanonicalBase64.encode(node.data.bytes) }, UNCHECKED),
      metadata
    }, UNCHECKED)
    : TreeNode.cases.symlink.make(
      { ino: node.ino, links: named, target: CanonicalBase64.encode(node.target), metadata },
      UNCHECKED
    )
}

// Every node a name reaches, and any `extra` ones, in inode order.
/** @internal */
export const treeNodes = Effect.fnUntraced(function*(value: VolumeState, extra: ReadonlyArray<Node> = []) {
  return [...(yield* reachableNodes(value)), ...extra].sort(byIno)
})

/** @internal */
export interface Writer<N extends TreeNode> {
  readonly operation: string
  // The field an encoding failure names.
  readonly documentField: string
  readonly header: string
  readonly node: (node: Node) => N
  readonly text: (node: N) => Result.Result<string, Schema.SchemaError>
  readonly meter: Meter | undefined
}

// The encoded bytes past which a chunk of lines is emitted before its node count is reached, so large files stream
// a few at a time rather than a whole batch at once.
/** @internal */
export const ENCODED_CHUNK_BYTES = 64 * 1024

// A value's nodes are valid by construction, so encoding one is never expected to fail.
/** @internal */
export const encodeFailure = (operation: string, field: string, cause: unknown) =>
  imageFailure(operation, "InvalidStructure", { field, cause })

// A tree's lines: the header, then its nodes a chunk at a time, each node built and encoded only when its chunk is
// pulled. A chunk ends at WALK_YIELD_INTERVAL lines, or before the line that would take it past ENCODED_CHUNK_BYTES,
// so a pull holds at most the cap and one line; a line past the cap goes out alone. A meter charges every line as it
// is written.
/** @internal */
export const writeTree = <N extends TreeNode>(
  writer: Writer<N>,
  nodes: ReadonlyArray<Node>
): Stream.Stream<Uint8Array, ImageFailure> => {
  // A reader checks a line against its bound and the input's as it grows, and charges the input when it ends.
  const charge = (line: Uint8Array) => writer.meter === undefined ? Result.void : writer.meter.line(line.length, true)

  // Charged in the order a reader checks: the line's length, then the node it holds.
  const encode = (source: Node): Result.Result<Uint8Array, ImageFailure> => {
    const node = writer.node(source)
    const text = writer.text(node)

    if (Result.isFailure(text)) {
      return Result.fail(encodeFailure(writer.operation, writer.documentField, text.failure))
    }

    const line = encodeLine(text.success)

    return Result.map(Result.flatMap(charge(line), () => writer.meter?.node(node) ?? Result.void), () => line)
  }

  // The chunk from `index`, and the line after it already encoded and charged, which starts the next chunk.
  interface Next {
    readonly index: number
    readonly carried: Uint8Array | undefined
  }

  const chunk = ({ carried, index }: Next): Result.Result<readonly [Uint8Array, Next] | undefined, ImageFailure> => {
    const lines: Array<Uint8Array> = carried === undefined ? [] : [carried]
    let bytes = carried === undefined ? 0 : carried.length + 1
    let next = index

    while (lines.length < WALK_YIELD_INTERVAL) {
      const source = nodes[next]

      if (source === undefined) break
      next++

      const line = encode(source)

      if (Result.isFailure(line)) return Result.fail(line.failure)

      if (lines.length > 0 && bytes + line.success.length + 1 > ENCODED_CHUNK_BYTES) {
        return Result.succeed([frame(lines), { index: next, carried: line.success }])
      }

      lines.push(line.success)
      bytes += line.success.length + 1
    }

    return lines.length === 0
      ? Result.succeed(undefined)
      : Result.succeed([frame(lines), { index: next, carried: undefined }])
  }

  const header = encodeLine(writer.header)

  return Stream.fromEffect(Effect.fromResult(Result.map(charge(header), () => frame([header])))).pipe(
    Stream.concat(
      Stream.unfold<Next, Uint8Array, ImageFailure, never>(
        { index: 0, carried: undefined },
        (next) => Effect.fromResult(chunk(next))
      )
    )
  )
}
