// Validate each tree line as it arrives; check cross-node graph rules after the final line.
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Match from "effect/Match"
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
import { KeySecret, VolumeEpoch } from "./hex128.js"
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

const TreeIno = Schema.Int.check(Schema.isBetween({ minimum: ROOT_INO, maximum: MAX_INO }))

const NaturalBigInt = Schema.String.check(
  Schema.isPattern(/^(0|[1-9][0-9]{0,127})$/, { [ENCODING_CHECK]: true })
).pipe(Schema.decodeTo(Schema.BigInt, SchemaTransformation.bigintFromString))

const TreeLink = Schema.Struct({ parent: TreeIno, name: CanonicalBase64.Encoded })

// Ref is reserved for future content-addressed storage and rejected by this reader.
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

// Snapshots omit revisions; restoring starts them afresh.
/** @internal */
export const TreeNode = Schema.TaggedUnion({ directory, file, symlink })

/** @internal */
export type TreeNode = typeof TreeNode.Type

// Avoid validating each decoded node again.
const isDirectory = Predicate.isTagged("directory")

const isFile = Predicate.isTagged("file")

const isSymlink = Predicate.isTagged("symlink")

// Reopening must retain revisions for existing references and caches.
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

const Runtime = Schema.Struct({
  identity: VolumeIdentity,
  epoch: VolumeEpoch,
  keySecret: KeySecret,
  // Inodes are number keys, so the allocator must remain exactly representable.
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

/** @internal */
export const LiveHeader = Schema.Struct({
  format: Schema.Literal("effect-vfs-live"),
  version: Schema.Literal(1),
  runtime: Runtime
})

const VersionProbe = Schema.Struct({ format: Schema.Literal("effect-vfs"), version: Schema.Unknown })

const STRICT = { onExcessProperty: "error" } as const

// Readers and writers use the same meter so they enforce identical bounds.
/** @internal */
export interface Meter extends FrameMeter {
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
    // At a shared threshold, report the input bound regardless of chunking or read/write direction.
    line: (bytes, ended) => {
      const read = encoded + bytes + (ended ? 1 : 0)
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

interface Named {
  readonly parent: number
  readonly key: string
  readonly bytes: number
  readonly path: ReadonlyArray<PropertyKey>
  readonly directory: number | undefined
}

interface Issue {
  readonly path: ReadonlyArray<PropertyKey>
  readonly issue: string
}

/** @internal */
export interface ReaderOptions {
  readonly operation: string
  readonly documentField: string
  // Live images use runtime bounds instead of a snapshot meter.
  readonly meter?: Meter
}

/** @internal */
export interface Read<H> {
  readonly header: H
  readonly specs: ReadonlyArray<NodeSpec>
}

const at = (path: ReadonlyArray<PropertyKey>, issue: string): Issue => ({ path: ["nodes", ...path], issue })

const ROOT_RULE = "the first node is the root directory, its own parent with an empty name"

const malformedLine = (options: ReaderOptions) => (error: Schema.SchemaError) =>
  imageFailure(options.operation, isEncodingIssue(issueSite(error.issue)) ? "InvalidEncoding" : "InvalidStructure", {
    field: options.documentField,
    cause: error
  })

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

  const named = (
    parent: number,
    name: typeof CanonicalBase64.Encoded.Type,
    path: ReadonlyArray<PropertyKey>,
    directory?: number
  ): Result.Result<string, ImageFailure> => {
    const length = CanonicalBase64.decodedLength(name)
    // Reject overlong names before decoding base64.
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

    // Reopening reclaims unlinked files, but their bytes still count toward stored usage.
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

  const graphIssue = (): Issue | undefined => {
    const held = new Set<string>()

    for (const name of names) {
      if (!parents.has(name.parent)) return at([...name.path, "parent"], "a name's parent is a directory in the tree")
      const key = `${name.parent}/${name.key}`

      if (held.has(key)) return at([...name.path, "name"], "a directory holds each name once")
      held.add(key)
    }

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

  // Graph validation makes this a tree, so one root walk can measure every path.
  const pathIssue = (maxPathBytes: bigint): Issue | undefined => {
    const below = new Map<number, Array<Named>>()

    for (const name of names) {
      const listed = below.get(name.parent)

      if (listed === undefined) below.set(name.parent, [name])
      else listed.push(name)
    }

    const pending: Array<readonly [number, bigint]> = [[ROOT_INO, 1n]]

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

// Reject later snapshot versions before checking their shape, including fields this version does not know.
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

// Live images are private; a different version is malformed.
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

// Value nodes have already passed validation.
/** @internal */
export const UNCHECKED = { disableChecks: true }

/** @internal */
export const treeNode = (node: Node): TreeNode => {
  const metadata = storedMetadata(node.metadata)

  return Match.value(node).pipe(
    Match.discriminator("kind")("directory", (directory) =>
      TreeNode.cases.directory.make(
        { ino: directory.ino, parent: directory.parent, name: encodeName(directory.name), metadata },
        UNCHECKED
      )),
    Match.discriminator("kind")("file", (file) =>
      TreeNode.cases.file.make({
        ino: file.ino,
        links: file.links.map((link) => ({ parent: link.parent, name: encodeName(link.name) })),
        content: TreeContent.cases.Inline.make({ bytes: CanonicalBase64.encode(file.data) }, UNCHECKED),
        metadata
      }, UNCHECKED)),
    Match.discriminator("kind")("symlink", (symlink) =>
      TreeNode.cases.symlink.make(
        {
          ino: symlink.ino,
          links: symlink.links.map((link) => ({ parent: link.parent, name: encodeName(link.name) })),
          target: CanonicalBase64.encode(symlink.target),
          metadata
        },
        UNCHECKED
      )),
    Match.exhaustive
  )
}

/** @internal */
export const treeNodes = Effect.fnUntraced(function*(value: VolumeState, extra: ReadonlyArray<Node> = []) {
  return [...(yield* reachableNodes(value)), ...extra].sort(byIno)
})

/** @internal */
export interface Writer<N extends TreeNode> {
  readonly operation: string
  readonly documentField: string
  readonly header: string
  readonly node: (node: Node) => N
  readonly text: (node: N) => Result.Result<string, Schema.SchemaError>
  readonly meter: Meter | undefined
}

/** @internal */
export const ENCODED_CHUNK_BYTES = 64 * 1024

/** @internal */
export const encodeFailure = (operation: string, field: string, cause: unknown) =>
  imageFailure(operation, "InvalidStructure", { field, cause })

// Encode on pull. A chunk may hold one line past the byte cap when that line alone exceeds it.
/** @internal */
export const writeTree = <N extends TreeNode>(
  writer: Writer<N>,
  nodes: ReadonlyArray<Node>
): Stream.Stream<Uint8Array, ImageFailure> => {
  const charge = (line: Uint8Array) => writer.meter === undefined ? Result.void : writer.meter.line(line.length, true)

  // Match the reader's charge order: line, then node.
  const encode = (source: Node): Result.Result<Uint8Array, ImageFailure> => {
    const node = writer.node(source)
    const text = writer.text(node)

    if (Result.isFailure(text)) {
      return Result.fail(encodeFailure(writer.operation, writer.documentField, text.failure))
    }

    const line = encodeLine(text.success)

    return Result.map(Result.flatMap(charge(line), () => writer.meter?.node(node) ?? Result.void), () => line)
  }

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
