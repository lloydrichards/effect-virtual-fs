// The one tree schema: a volume value as nodes ordered by inode number, each naming the directory entries that
// reach it. A snapshot is this tree; the live image adds the runtime state a reopened volume resumes from. Names,
// payloads and targets stay canonical base64 until a tree becomes a value, so a decoder refuses a document that
// breaks a rule or a budget before it allocates any payload.
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Schema from "effect/Schema"
import type { ImageFailure } from "../VfsError.js"
import { CanonicalBase64 } from "./canonicalBase64.js"
import { imageFailure, isEncodingIssue, issueSite } from "./errors.js"
import { StoredMetadata } from "./metadata.js"
import { isNameBytes, MAX_NAME_BYTES, nameBytes, NUL_BYTE } from "./path.js"
import {
  assemble,
  byIno,
  Ino,
  type Link,
  type Node,
  type NodeSpec,
  reachableNodes,
  ROOT_INO,
  storedMetadata,
  type VolumeState
} from "./volumeState.js"

// The largest inode number a tree holds. A restored volume's allocator resumes one above it, and the allocator
// must stay exactly representable.
const MAX_TREE_INO = Number.MAX_SAFE_INTEGER - 1

// Marks the check holding a tree's graph rules, whose failures name the node that broke one.
const GRAPH_CHECK = "@effect-vfs/core/graphCheck"

/** @internal */
export const TreeIno = Schema.Int.check(Schema.isBetween({ minimum: ROOT_INO, maximum: MAX_TREE_INO }))

const TreeLink = Schema.Struct({ parent: TreeIno, name: CanonicalBase64.Encoded })

// A file's bytes inline, or a reference to content stored elsewhere. The reference is reserved for
// content-addressed storage: the schema knows its shape so a document holding one is refused by name.
const TreeContent = Schema.TaggedUnion({
  Inline: { bytes: CanonicalBase64.Encoded },
  Ref: { hash: Schema.String, size: Schema.Natural }
})

// The inline bytes of a file's content; a reference holds none.
/** @internal */
export const inlineBytes = (content: typeof TreeContent.Type): typeof CanonicalBase64.Encoded.Type | undefined =>
  TreeContent.guards.Inline(content) ? content.bytes : undefined

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

const isDirectory = TreeNode.guards.directory

/** @internal */
export const Tree = Schema.Struct({
  format: Schema.Literal("effect-vfs"),
  version: Schema.Literal(1),
  nodes: Schema.Array(TreeNode)
})

/** @internal */
export type Tree = typeof Tree.Type

/** @internal */
export interface GraphIssue {
  readonly path: ReadonlyArray<PropertyKey>
  readonly issue: string
}

// The rules every tree keeps, reported at the first node that breaks one: the root directory comes first as its
// own parent with an empty name; inode numbers ascend without repeats; every name is a valid name held once by a
// directory in the tree; every directory reaches the root through its parents; every symbolic link, and every
// file unless the tree retains unlinked files, has a name; no symbolic link target holds a NUL.
/** @internal */
export const graphIssue = (nodes: ReadonlyArray<TreeNode>, retainsFiles: boolean): GraphIssue | undefined => {
  const at = (path: ReadonlyArray<PropertyKey>, issue: string) => ({ path: ["nodes", ...path], issue })
  const root = nodes[0]

  if (
    root === undefined || !isDirectory(root) || root.ino !== ROOT_INO || root.parent !== ROOT_INO || root.name !== ""
  ) {
    return at([0], "the first node is the root directory, its own parent with an empty name")
  }

  // Each directory's parent, by inode number.
  const parents = new Map<number, number>()

  for (const [index, node] of nodes.entries()) {
    const previous = nodes[index - 1]

    if (previous !== undefined && node.ino <= previous.ino) {
      return at([index, "ino"], "nodes ascend by inode number without repeats")
    }

    if (isDirectory(node)) parents.set(node.ino, node.parent)
  }

  const names = new Set<string>()

  const entryIssue = (parent: number, name: typeof CanonicalBase64.Encoded.Type, path: ReadonlyArray<PropertyKey>) => {
    if (!parents.has(parent)) return at([...path, "parent"], "a name's parent is a directory in the tree")

    const length = CanonicalBase64.decodedLength(name)

    // The length is read from the base64 first, so an overlong name is refused without being decoded.
    if (length < 1 || length > MAX_NAME_BYTES || !isNameBytes(CanonicalBase64.toBytes(name))) {
      return at([...path, "name"], "a name is 1 to 255 bytes without a NUL or a slash, and neither . nor ..")
    }

    const key = `${parent}/${name}`

    if (names.has(key)) return at([...path, "name"], "a directory holds each name once")
    names.add(key)
  }

  for (const [index, node] of nodes.entries()) {
    if (isDirectory(node)) {
      const issue = index === 0 ? undefined : entryIssue(node.parent, node.name, [index])

      if (issue !== undefined) return issue
      continue
    }

    if (node.links.length === 0 && !(retainsFiles && TreeNode.guards.file(node))) {
      return at([index, "links"], "every file and symbolic link has a name")
    }

    for (const [position, link] of node.links.entries()) {
      const issue = entryIssue(link.parent, link.name, [index, "links", position])

      if (issue !== undefined) return issue
    }

    if (TreeNode.guards.symlink(node) && CanonicalBase64.toBytes(node.target).includes(NUL_BYTE)) {
      return at([index, "target"], "a symbolic link's target holds no NUL")
    }
  }

  // Parent chains end at the root; one that comes back to a directory it passed is a cycle nothing reaches.
  const reachesRoot = new Set<number>([ROOT_INO])

  for (const [index, node] of nodes.entries()) {
    if (!isDirectory(node)) continue
    const chain = new Set<number>()
    let ino: number | undefined = node.ino

    while (ino !== undefined && !reachesRoot.has(ino)) {
      if (chain.has(ino)) return at([index, "parent"], "every directory reaches the root")
      chain.add(ino)
      ino = parents.get(ino)
    }

    for (const member of chain) reachesRoot.add(member)
  }
}

// A snapshot's graph rules, checked apart from its shape so the decoder can count its budgets in between: a tree
// over budget is refused before any of its names or targets is decoded.
/** @internal */
export const checkGraph = (tree: Tree, operation: string): Effect.Effect<void, ImageFailure> => {
  const issue = graphIssue(tree.nodes, false)

  return issue === undefined
    ? Effect.void
    : imageFailure(operation, "InvalidStructure", { field: issue.path.map(String).join(".") })
}

// Maps a failed tree decode to the codec's error. A broken graph rule names the node from its issue path; a
// document of the wrong shape or spelling names `documentField`, as it always has.
/** @internal */
export const decodeFailure = (operation: string, documentField: string) => (error: Schema.SchemaError) => {
  const site = issueSite(error.issue)

  return site.checks.some((check) => check.annotations?.[GRAPH_CHECK] === true)
    ? imageFailure(operation, "InvalidStructure", { field: site.path.map(String).join("."), cause: error })
    : imageFailure(operation, isEncodingIssue(site) ? "InvalidEncoding" : "InvalidStructure", {
      field: documentField,
      cause: error
    })
}

const hexName = (name: typeof CanonicalBase64.Encoded.Type) => Encoding.encodeHex(CanonicalBase64.toBytes(name))

const links = (links: ReadonlyArray<typeof TreeLink.Type>): ReadonlyArray<Link> =>
  links.map((link) => ({ parent: Ino(link.parent), name: hexName(link.name) }))

// The value a valid tree describes, decoding each payload once. A content reference is refused here, where the
// bytes would be needed. Snapshot nodes carry no revision and restore at the first one.
/** @internal */
export const toValue = Effect.fnUntraced(function*(
  nodes: ReadonlyArray<TreeNode & { readonly rev?: bigint }>,
  operation: string
): Effect.fn.Return<VolumeState, ImageFailure> {
  const specs: Array<NodeSpec> = []

  for (const [index, node] of nodes.entries()) {
    const common = { ino: Ino(node.ino), metadata: node.metadata, revision: node.rev ?? 1n }

    if (isDirectory(node)) {
      specs.push({ ...common, kind: "directory", parent: Ino(node.parent), name: hexName(node.name) })
    } else if (TreeNode.guards.symlink(node)) {
      specs.push({ ...common, kind: "symlink", links: links(node.links), target: CanonicalBase64.toBytes(node.target) })
    } else {
      const bytes = inlineBytes(node.content)

      if (bytes === undefined) {
        return yield* imageFailure(operation, "UnsupportedVersion", { field: `nodes.${index}.content` })
      }

      specs.push({ ...common, kind: "file", links: links(node.links), data: CanonicalBase64.toBytes(bytes) })
    }
  }

  return assemble(specs)
})

const encodeName = (name: string) => CanonicalBase64.encode(nameBytes(name))

// A node built from a value is valid by construction, so building it skips the schema's checks.
const UNCHECKED = { disableChecks: true }

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
