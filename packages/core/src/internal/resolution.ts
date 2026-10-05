import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import type { Identity } from "../Caller.js"
import { type EntryInput, isEntry, isTarget, type NameInput, type Target } from "../Target.js"
import type { FsFailure } from "../VfsError.js"
import type { DirectoryHandle, FileHandle, PathInput } from "../VirtualFileSystem.js"
import { type Confinement, make as makeConfinement } from "./confinement.js"
import type { OpContext } from "./errors.js"
import {
  DOT_DOT_HEX,
  DOT_HEX,
  isAttachedBytes,
  isDotComponent,
  isWellFormed,
  MAX_NAME_BYTES,
  MAX_SYMLINK_TRAVERSALS,
  nameBytes,
  ownedPath,
  type PreparedPath,
  preparePath,
  SLASH_BYTE
} from "./path.js"
import * as TokenRegistry from "./tokenRegistry.js"
import { type Directory, type Ino, type Node, ROOT_INO } from "./volumeState.js"

/** @internal */
export type PreparedEntry =
  | { readonly kind: "path"; readonly path: PreparedPath; readonly base: DirectoryHandle | undefined }
  | { readonly kind: "entry"; readonly directory: Target; readonly name: string }

/** @internal */
export interface NodeMode<R = never> {
  readonly kind: "Node"
  readonly followFinalSymlink?: boolean
  readonly final?: boolean
  readonly createMissing?: (parent: Directory, name: string, final: boolean) => Effect.Effect<Directory, FsFailure, R>
}

/** @internal */
export interface ParentMode {
  readonly kind: "Parent"
}

/** @internal */
export interface OrCreateMode<R = never> {
  readonly kind: "OrCreate"
  readonly create: "never" | "ifMissing" | "exclusive"
  readonly finalSymlink: "follow" | "preserve"
  // Entry writeFile historically checks exclusivity after following the link; open checks the direct entry.
  readonly entryExclusive?: "afterSymlink"
  readonly beforeFollow?: (parent: Directory, child: Node | undefined) => Effect.Effect<void, FsFailure, R>
}

type WalkMode<R> = NodeMode<R> | ParentMode | OrCreateMode<R>

/** @internal */
export type NodeResult =
  | { readonly kind: "node"; readonly node: Node; readonly op: OpContext }
  | {
    readonly kind: "entry"
    readonly node: Node
    readonly parent: Directory
    readonly name: string
    readonly op: OpContext
  }

interface MissingResult {
  readonly kind: "missing"
  readonly parent: Directory
  readonly name: string
  readonly op: OpContext
}

/** @internal */
export interface ParentResult {
  readonly kind: "parent"
  readonly parent: Ino
  readonly name: string | undefined
  readonly trailingSlash: boolean
  readonly addressing: "path" | "entry"
  readonly op: OpContext
}

interface CreateEntry {
  readonly parent: Directory
  readonly name: string
  readonly trailingSlash: boolean
  readonly addressing: "path" | "entry"
  readonly op: OpContext
  // Conditional entry opens report the original directory's revisions when a link resolves to an existing file.
  readonly origin: { readonly parent: Directory; readonly name: string }
}

/** @internal */
export type CreateResult =
  | (CreateEntry & { readonly kind: "existing"; readonly node: Node })
  | (CreateEntry & { readonly kind: "missing" })

const encoder = new TextEncoder()

const EMPTY_AUTHORITIES: ReadonlyArray<Confinement> = []

/** @internal */
export const inGroup = (identity: Identity, gid: number) => identity.gid === gid || identity.groups.includes(gid)

/** @internal */
export const permitted = (node: Node, identity: Identity) => {
  const shift = identity.uid === node.metadata.uid ? 6 : inGroup(identity, node.metadata.gid) ? 3 : 0

  return (node.metadata.mode >> shift) & 0o7
}

/** @internal */
export const authorize = (node: Node, identity: Identity, bits: number, op: OpContext) =>
  identity.privileged || (permitted(node, identity) & bits) === bits
    ? Effect.void
    : Effect.fail(op.fail("AccessDenied"))

/** @internal */
export const entryName = (input: NameInput, op: OpContext): Result.Result<string, FsFailure> => {
  if (Predicate.isString(input) && !isWellFormed(input)) return Result.fail(op.fail("InvalidPathEncoding"))
  const bytes = Predicate.isString(input) ? encoder.encode(input) : input

  if (
    !isAttachedBytes(bytes) || bytes.length === 0 || bytes.length > MAX_NAME_BYTES || bytes.includes(0) ||
    bytes.includes(SLASH_BYTE)
  ) return Result.fail(op.fail("InvalidArgument"))

  return Result.succeed(Hex.encode(new Uint8Array(bytes)))
}

/** @internal */
export const make = ({ caller, get, identity, maxPathBytes, registry, confinement, additional, authorityView }: {
  readonly additional?: ReadonlyArray<Confinement> | undefined
  readonly authorityView: Effect.Effect<(ino: Ino) => Node | undefined>
  readonly confinement?: Confinement | undefined
  readonly caller: TokenRegistry.DirectoryReference
  readonly get: (ino: Ino) => Effect.Effect<Node | undefined>
  readonly identity: Identity
  readonly maxPathBytes: ByteSize.ByteSize | undefined
  readonly registry: TokenRegistry.TokenRegistry
}) => {
  const visibleRoot = confinement?.root ?? ROOT_INO
  const prepare = (input: PathInput, op: OpContext) => preparePath(input, op.operation, maxPathBytes)

  const prepareEntry = (input: EntryInput, op: OpContext): Result.Result<PreparedEntry, FsFailure> =>
    isEntry(input)
      ? Result.map(
        entryName(input.name, op),
        (name): PreparedEntry => ({ kind: "entry", directory: input.directory, name })
      )
      : isTarget(input)
      ? Result.map(prepare(input.path, op), (path): PreparedEntry => ({ kind: "path", path, base: input.relativeTo }))
      : Result.map(prepare(input, op), (path): PreparedEntry => ({ kind: "path", path, base: undefined }))

  const nodeAt = Effect.fnUntraced(function*(lookup: (ino: Ino) => Node | undefined, ino: Ino) {
    const node = lookup(ino)

    return node === undefined ? yield* Effect.die("Inode left the table during resolution") : node
  })

  const directoryAt = Effect.fnUntraced(function*(lookup: (ino: Ino) => Node | undefined, ino: Ino) {
    const node = yield* nodeAt(lookup, ino)

    return node.kind !== "directory" ? yield* Effect.die("Directory left the table during resolution") : node
  })

  const callerDirectory = Effect.fnUntraced(function*(lookup: (ino: Ino) => Node | undefined, op: OpContext) {
    const ino = TokenRegistry.inode(caller)
    const node = ino === undefined ? undefined : lookup(ino)

    return node?.kind !== "directory" ? yield* op.fail("ClosedCaller") : node
  })

  const walk = Effect.fnUntraced(function*<R = never>(
    path: PreparedPath,
    base: DirectoryHandle | FileHandle | undefined,
    op: OpContext,
    mode: WalkMode<R>,
    referencedBase?: Directory
  ) {
    const pathOp = op.at(path.input)

    const baseAuthorities = base === undefined
      ? EMPTY_AUTHORITIES
      : registry.handleBoundaries(base).map((roots) => makeConfinement(authorityView, roots))

    const authorizeDirectory = baseAuthorities.length === 0 ? authorize : Effect.fnUntraced(function*(
      node: Node,
      callerIdentity: Identity,
      bits: number,
      context: OpContext
    ) {
      for (const authority of baseAuthorities) yield* authority.check(node, context, true)
      yield* authorize(node, callerIdentity, bits, context)
    })

    const parentOnly = mode.kind === "Parent"
    const allowMissing = mode.kind === "OrCreate" && mode.create !== "never"

    const followFinalSymlink = mode.kind === "Node"
      ? mode.followFinalSymlink !== false
      : mode.kind === "Parent" || mode.finalSymlink === "follow"

    const createMissing = mode.kind === "Node" ? mode.createMissing : undefined

    if (!TokenRegistry.isOpen(caller)) {
      return yield* pathOp.fail("ClosedCaller")
    }

    if (additional !== undefined && additional.length > 0) {
      for (const authority of additional) yield* authority.alive(pathOp)
    }

    if (confinement !== undefined) yield* confinement.alive(pathOp)

    if (
      path.absolute && base !== undefined &&
      (confinement !== undefined || (additional?.length ?? 0) > 0 || baseAuthorities.length > 0)
    ) {
      const node = yield* TokenRegistry.nodeOrFail(yield* registry.resolve(base, "directory"), "handle", pathOp)
      yield* registry.authorizeHandle(base, node, pathOp)

      if (confinement !== undefined) yield* confinement.check(node, pathOp)

      if (additional !== undefined && additional.length > 0) {
        for (const authority of additional) yield* authority.check(node, pathOp)
      }
    }

    // Reads remain live so recursive creation can revisit nodes added earlier in this walk.
    const lookup = yield* authorityView
    let current: Node = path.absolute ? (yield* nodeAt(lookup, visibleRoot)) : yield* callerDirectory(lookup, pathOp)

    if (!path.absolute && referencedBase !== undefined) {
      current = referencedBase
      yield* authorize(current, identity, 0o1, op)
    } else if (!path.absolute && base !== undefined) {
      const directory = yield* TokenRegistry.nodeOrFail(yield* registry.resolve(base, "directory"), "handle", pathOp)

      if (directory.kind !== "directory") return yield* pathOp.fail("InvalidHandle")
      yield* registry.authorizeHandle(base, directory, pathOp)
      current = directory
      yield* authorize(current, identity, 0o1, pathOp)
    }

    if (confinement !== undefined) yield* confinement.check(current, pathOp)

    if (additional !== undefined && additional.length > 0) {
      for (const authority of additional) yield* authority.check(current, pathOp)
    }

    if (current.metadata.nlink === 0) {
      return yield* pathOp.fail("NotFound")
    }

    let work = path
    let parent: Directory | undefined
    let name: string | undefined
    let traversals = 0
    // Leading components that came from a symbolic link's target. Only the components the caller wrote are
    // created, so a dangling link stays missing, as it does for mkdir -p.
    let linked = 0

    for (let index = 0; index < work.components.length - (parentOnly ? 1 : 0); index++) {
      if (current.kind !== "directory") {
        return yield* pathOp.fail("NotDirectory")
      }

      yield* authorizeDirectory(current, identity, 0o1, pathOp)
      const component = work.components[index]

      if (component === undefined) break

      if (component === DOT_HEX) continue

      if (component === DOT_DOT_HEX) {
        current = yield* directoryAt(
          lookup,
          confinement !== undefined && current.ino === visibleRoot ? current.ino : current.parent
        )
        parent = undefined
        name = undefined
        continue
      }

      parent = current
      name = component
      const childIno = current.entries.get(component)
      const child = childIno === undefined ? undefined : lookup(childIno)

      if (child === undefined) {
        if (allowMissing && index === work.components.length - 1) {
          return { kind: "missing" as const, parent, name, op: pathOp }
        }

        if (createMissing !== undefined && index >= linked) {
          current = yield* createMissing(current, component, index === work.components.length - 1)
          continue
        }

        return yield* pathOp.fail("NotFound")
      }

      if (
        child.kind === "symlink" && (followFinalSymlink || index < work.components.length - 1 || work.trailingSlash)
      ) {
        if (child.target.length === 0) {
          return yield* pathOp.fail("NotFound")
        }

        if (++traversals > MAX_SYMLINK_TRAVERSALS) {
          return yield* pathOp.fail("SymlinkLoop")
        }

        const suffix = work.suffixes[index] ?? new Uint8Array(0)
        const remaining = work.components.length - index - 1

        if (
          maxPathBytes !== undefined &&
          ByteSize.isGreaterThan(ByteSize.bytes(child.target.length + suffix.length), maxPathBytes)
        ) {
          return yield* pathOp.fail("PathTooLong")
        }

        const expansion = new Uint8Array(child.target.length + suffix.length)
        expansion.set(child.target)
        expansion.set(suffix, child.target.length)
        const expanded = preparePath(ownedPath(expansion), op.operation, maxPathBytes)

        // The expansion is synthetic: its per-component limits are the caller's to hear about,
        // but the path in the error has to be the one the caller passed in, so the
        // expansion's own failure is not kept as the cause.
        if (Result.isFailure(expanded)) {
          return yield* pathOp.fail(expanded.failure.code)
        }

        work = expanded.success
        linked = work.components.length - remaining + Math.max(0, linked - index - 1)

        if (work.absolute) current = yield* nodeAt(lookup, visibleRoot)
        index = -1
      } else current = child
    }

    if (baseAuthorities.length > 0) {
      for (const authority of baseAuthorities) yield* authority.check(current, pathOp, true)
    }

    if (!parentOnly && work.trailingSlash && current.kind !== "directory") {
      return yield* pathOp.fail("NotDirectory")
    }

    return parent === undefined || name === undefined
      ? { kind: "node" as const, node: current, op: pathOp }
      : { kind: "entry" as const, node: current, parent, name, op: pathOp }
  })

  const resolveNode = Effect.fnUntraced(
    function*<R = never>(target: Target, mode: NodeMode<R>, op: OpContext): Effect.fn.Return<NodeResult, FsFailure, R> {
      if (Predicate.isTagged(target, "Path")) {
        const path = yield* Effect.fromResult(prepare(target.path, op))

        const result = yield* walk(path, target.relativeTo, op, {
          ...mode,
          followFinalSymlink: mode.final === true
            ? mode.followFinalSymlink ?? true
            : target.followFinalSymlink ?? mode.followFinalSymlink ?? true
        })

        return result.kind === "missing" ? yield* result.op.fail("NotFound") : result
      }

      if (!TokenRegistry.isOpen(caller)) return yield* op.fail("ClosedCaller")

      const node = yield* TokenRegistry.nodeOrFail(
        yield* (Predicate.isTagged(target, "Reference")
          ? registry.resolve(target.reference, "reference")
          : registry.resolve(target.handle, "handle")),
        Predicate.isTagged(target, "Reference") ? "reference" : "handle",
        op
      )

      if (!Predicate.isTagged(target, "Reference")) yield* registry.authorizeHandle(target.handle, node, op)

      if (confinement !== undefined) yield* confinement.check(node, op)

      if (additional !== undefined && additional.length > 0) {
        for (const authority of additional) yield* authority.check(node, op)
      }

      return { kind: "node", node, op }
    }
  )

  const directory = Effect.fnUntraced(function*(target: Target, op: OpContext) {
    const resolved = yield* resolveNode(target, { kind: "Node" }, op)

    if (resolved.node.kind !== "directory") return yield* resolved.op.fail("NotDirectory")

    return { node: resolved.node, op: resolved.op }
  })

  const entryDirectory = Effect.fnUntraced(function*(target: Target, op: OpContext) {
    const resolved = yield* directory(target, op)

    if (resolved.node.metadata.nlink === 0) return yield* resolved.op.fail("NotFound")

    return resolved
  })

  const parent = Effect.fnUntraced(
    function*(prepared: PreparedEntry, op: OpContext): Effect.fn.Return<ParentResult, FsFailure> {
      if (prepared.kind === "entry") {
        const resolved = yield* entryDirectory(prepared.directory, op)

        return {
          kind: "parent",
          parent: resolved.node.ino,
          name: prepared.name,
          trailingSlash: false,
          addressing: "entry",
          op
        }
      }

      const resolved = yield* walk(prepared.path, prepared.base, op, { kind: "Parent" })

      if (resolved.kind === "missing") return yield* resolved.op.fail("NotFound")

      if (resolved.node.kind !== "directory") return yield* resolved.op.fail("NotDirectory")

      return {
        kind: "parent",
        parent: resolved.node.ino,
        name: prepared.path.components.at(-1),
        trailingSlash: prepared.path.trailingSlash,
        addressing: "path",
        op: resolved.op
      }
    }
  )

  const creationResult = (
    result: NodeResult | MissingResult,
    trailingSlash: boolean,
    addressing: "path" | "entry",
    op: OpContext,
    origin?: CreateEntry["origin"]
  ): Effect.Effect<CreateResult, FsFailure> => {
    if (result.kind === "node") return Effect.fail(op.fail("IsDirectory"))

    const entry = {
      parent: result.parent,
      name: result.name,
      trailingSlash,
      addressing,
      op,
      origin: origin ?? { parent: result.parent, name: result.name }
    }

    return Effect.succeed(
      result.kind === "missing" ? { ...entry, kind: "missing" } : { ...entry, kind: "existing", node: result.node }
    )
  }

  const orCreate = Effect.fnUntraced(
    function*<R = never>(
      prepared: PreparedEntry,
      mode: OrCreateMode<R>,
      op: OpContext
    ): Effect.fn.Return<CreateResult, FsFailure, R> {
      if (prepared.kind === "path") {
        const pathOp = op.at(prepared.path.input)

        if (mode.create === "exclusive") {
          const exists = yield* Effect.result(
            walk(prepared.path, prepared.base, op, { kind: "Node", followFinalSymlink: false })
          )

          if (Result.isSuccess(exists)) return yield* pathOp.fail("AlreadyExists")

          if (exists.failure.code !== "NotFound") return yield* exists.failure
        }

        return yield* creationResult(
          yield* walk(prepared.path, prepared.base, op, mode),
          prepared.path.trailingSlash,
          "path",
          pathOp
        )
      }

      const { node: parent } = yield* entryDirectory(prepared.directory, op)

      if (isDotComponent(prepared.name)) return yield* op.fail("InvalidArgument")
      yield* authorize(parent, identity, 0o1, op)
      const directIno = parent.entries.get(prepared.name)
      const direct = directIno === undefined ? undefined : yield* get(directIno)

      if (mode.beforeFollow !== undefined) yield* mode.beforeFollow(parent, direct)

      if (mode.create === "exclusive" && mode.entryExclusive !== "afterSymlink" && direct !== undefined) {
        return yield* op.fail("AlreadyExists")
      }

      let result: NodeResult | MissingResult = direct === undefined
        ? { kind: "missing", parent, name: prepared.name, op }
        : { kind: "entry", node: direct, parent, name: prepared.name, op }

      if (direct?.kind === "symlink" && mode.finalSymlink === "follow") {
        const path = yield* Effect.fromResult(preparePath(ownedPath(nameBytes(prepared.name)), op.operation, undefined))

        // Following an entry link must retain the directory capability's boundaries.
        const base = Predicate.isTagged(prepared.directory, "Handle")
          ? prepared.directory.handle
          : Predicate.isTagged(prepared.directory, "Path")
          ? prepared.directory.relativeTo
          : undefined

        result = yield* walk(path, base, op, mode, parent)

        // Entry writeFile rejects a followed directory before checking exclusive creation.
        if (
          mode.create === "exclusive" && mode.entryExclusive === "afterSymlink" &&
          (result.kind === "node" || (result.kind === "entry" && result.node.kind === "directory"))
        ) {
          return yield* op.fail("IsDirectory")
        }
      }

      if (result.kind === "missing" && mode.create === "never") return yield* op.fail("NotFound")

      if (mode.create === "exclusive" && mode.entryExclusive === "afterSymlink" && result.kind !== "missing") {
        return yield* op.fail("AlreadyExists")
      }

      return yield* creationResult(result, false, "entry", op, { parent, name: prepared.name })
    }
  )

  function resolve<R = never>(target: Target, mode: NodeMode<R>, op: OpContext): Effect.Effect<NodeResult, FsFailure, R>
  function resolve(prepared: PreparedEntry, mode: ParentMode, op: OpContext): Effect.Effect<ParentResult, FsFailure>
  function resolve<R = never>(
    prepared: PreparedEntry,
    mode: OrCreateMode<R>,
    op: OpContext
  ): Effect.Effect<CreateResult, FsFailure, R>
  function resolve<R>(
    input: Target | PreparedEntry,
    mode: WalkMode<R>,
    op: OpContext
  ): Effect.Effect<NodeResult | ParentResult | CreateResult, FsFailure, R> {
    if (isTarget(input)) {
      return mode.kind === "Node" ? resolveNode(input, mode, op) : Effect.die("A node target requires Node resolution")
    }

    return mode.kind === "Parent"
      ? parent(input, op)
      : mode.kind === "OrCreate"
      ? orCreate(input, mode, op)
      : Effect.die("An entry requires Parent or OrCreate resolution")
  }

  return { prepare, prepareEntry, resolve, directory, entryDirectory }
}
