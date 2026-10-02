/**
 * Coordinates tree transfer ordering, placement, cleanup, and reporting.
 *
 * Package exports hide this module. `@ignore` omits its declarations from API
 * documentation while retaining them in emitted types.
 *
 * @since 0.6.0
 */
import { BytePath } from "@effect-vfs/core"
import * as Vfs from "@effect-vfs/core/VirtualFileSystem"
import * as ByteSize from "effect/ByteSize"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"

/** @ignore */
export const TreeTransferLimitsSchema = Schema.Struct({
  maxEntries: Schema.Natural,
  maxBytes: Schema.ByteSize,
  maxFileBytes: Schema.ByteSize,
  maxDepth: Schema.Natural,
  maxPathBytes: Schema.ByteSize
})

/** @ignore */
export const makeLimits = (limits: typeof TreeTransferLimitsSchema.Type): typeof TreeTransferLimitsSchema.Type =>
  Object.freeze({ ...limits })

/** @ignore */
export const defaultLimits = makeLimits({
  maxEntries: 100_000,
  maxBytes: ByteSize.gibibytes(1),
  maxFileBytes: ByteSize.mebibytes(256),
  maxDepth: 256,
  maxPathBytes: ByteSize.kibibytes(4)
})

/** @ignore */
export const constrainedLimits = makeLimits({
  maxEntries: 10_000,
  maxBytes: ByteSize.mebibytes(64),
  maxFileBytes: ByteSize.mebibytes(8),
  maxDepth: 64,
  maxPathBytes: ByteSize.kibibytes(1)
})

/** @ignore */
export type Entry = Vfs.Fixture["entries"][number]

/** @ignore */
export class TransferError extends Data.TaggedError("TransferError")<{
  readonly code:
    | "LimitExceeded"
    | "InvalidEntry"
    | "InvalidArgument"
    | "UnrepresentableName"
    | "UnsupportedEntryType"
    | "NameCollision"
    | "EscapingSymlink"
    | "DestinationConflict"
  readonly field?: string
  readonly path?: Vfs.PathInput
}> {}

/** @ignore */
export type TreeTransferLimits = typeof TreeTransferLimits.Type

/** @ignore */
export const TreeTransferLimits = Object.assign(TreeTransferLimitsSchema, {
  default: defaultLimits,
  constrained: constrainedLimits
})

/** @ignore */
export interface ReadOptions {
  /** Source work policy. Omission uses `TreeTransferLimits.default`. */
  readonly limits?: TreeTransferLimits | undefined
}

/** @ignore */
export interface WriteOptions {
  /** How an existing destination is treated. Defaults to `"reject"`. */
  readonly existing?: "reject" | "overwrite" | undefined
  /** Which source timestamps are applied. Defaults to `"mtime"`. */
  readonly times?: "none" | "mtime" | "all" | undefined
  /** Applies setuid, setgid, and sticky bits. Defaults to `false`. */
  readonly specialBits?: boolean | undefined
}

/** @ignore */
export interface FileSystemReadOptions extends ReadOptions {
  /** How entries the source cannot carry are treated. Defaults to `"fail"`. */
  readonly unsupported?: "fail" | "skip" | undefined
  /** Receives each skipped entry. Defaults to logging a warning. */
  readonly onSkip?: ((skipped: SkippedEntry) => Effect.Effect<void>) | undefined
}

/** @ignore */
export interface FileSystemWriteOptions extends WriteOptions {
  /** How symbolic links that leave the tree are treated. Defaults to `"reject"`. */
  readonly escaping?: "reject" | "allow" | undefined
  /** How entries the destination cannot carry are treated. Defaults to `"fail"`. */
  readonly unsupported?: "fail" | "skip" | undefined
}

/** @ignore */
export const SinkCapabilities = Object.assign(
  Schema.Struct({
    byteNames: Schema.Boolean,
    timestampPrecision: Schema.Literals(["nanosecond", "millisecond"]),
    changeAndBirthTimes: Schema.Boolean,
    owner: Schema.Boolean,
    symlinkMetadata: Schema.Boolean,
    hardLinks: Schema.Literals(["exact", "bestEffort"])
  }),
  {
    caller: Object.freeze(
      {
        byteNames: true,
        timestampPrecision: "nanosecond",
        changeAndBirthTimes: false,
        owner: false,
        symlinkMetadata: true,
        hardLinks: "exact"
      } as const
    ),
    volume: Object.freeze(
      {
        byteNames: true,
        timestampPrecision: "nanosecond",
        changeAndBirthTimes: true,
        owner: true,
        symlinkMetadata: true,
        hardLinks: "exact"
      } as const
    ),
    fileSystem: Object.freeze(
      {
        byteNames: false,
        timestampPrecision: "millisecond",
        changeAndBirthTimes: false,
        owner: false,
        symlinkMetadata: false,
        hardLinks: "bestEffort"
      } as const
    )
  }
)

/** @ignore */
export type SinkCapabilities = typeof SinkCapabilities.Type

/** @ignore */
export const SkippedEntry = Schema.Struct({
  path: Schema.Union([Schema.String, Vfs.BytePath]),
  reason: Schema.Literals(["UnrepresentableName", "UnsupportedEntryType", "NameCollision"])
})

/** @ignore */
export type SkippedEntry = typeof SkippedEntry.Type

/** @ignore */
export type TransferReport = typeof TransferReport.Type

/** @ignore */
export const TransferReport = Schema.Struct({
  entries: Schema.Natural,
  files: Schema.Natural,
  bytes: Schema.ByteSize,
  skipped: Schema.Array(SkippedEntry),
  hardLinksDegraded: Schema.Natural
})

const SLASH = 0x2f
/** @ignore */
export const DEFAULT_DIRECTORY_MODE = 0o755
/** @ignore */
export const DEFAULT_FILE_MODE = 0o644
/** @ignore */
export const OWNER_ACCESS = 0o700
/** @ignore */
export const PERMISSION_BITS = 0o777
/** @ignore */
export const MODE_BITS = 0o7777

const encoder = new TextEncoder()

/** @ignore */
export const decodeText = (bytes: Uint8Array): string | undefined => Option.getOrUndefined(BytePath.decodeOption(bytes))

// A name stays a string while it is UTF-8, so consumers can filter entries without decoding.
/** @ignore */
export const toPathInput = (bytes: Uint8Array): Effect.Effect<Vfs.PathInput, Vfs.VfsError> => {
  const text = decodeText(bytes)

  return text === undefined ? BytePath.fromBytes(bytes) : Effect.succeed(text)
}

/** @ignore */
export const exceeds = (value: number | bigint, limit: ByteSize.ByteSize) =>
  ByteSize.isGreaterThan(ByteSize.bytes(value), limit)

/** @ignore */
export const limitExceeded = (field: keyof TreeTransferLimits, path?: Vfs.PathInput) =>
  new TransferError(path === undefined ? { code: "LimitExceeded", field } : { code: "LimitExceeded", field, path })

/** @ignore */
export const resolveLimits = (limits: TreeTransferLimits | undefined) =>
  limits === undefined
    ? Effect.succeed(defaultLimits)
    : Schema.decodeEffect(TreeTransferLimitsSchema)(limits).pipe(
      Effect.mapError(() => new TransferError({ code: "InvalidArgument", field: "limits" }))
    )

/** @ignore */
export function childPath(parent: string, name: string): string
/** @ignore */
export function childPath(parent: string | Uint8Array, name: string | Uint8Array, text?: string): string | Uint8Array
/** @ignore */
export function childPath(
  parent: string | Uint8Array,
  name: string | Uint8Array,
  text: string | undefined = Predicate.isString(name) ? name : decodeText(name)
): string | Uint8Array {
  if (Predicate.isString(parent) && text !== undefined) {
    return parent.endsWith("/")
      ? `${parent}${text}`
      : `${parent}/${text}`
  }

  const bytes = Predicate.isString(name) ? encoder.encode(name) : name
  const prefix = Predicate.isString(parent) ? encoder.encode(parent) : parent
  const separator = prefix.at(-1) === SLASH ? 0 : 1
  const output = new Uint8Array(prefix.length + separator + bytes.length)
  output.set(prefix)

  if (separator === 1) output[prefix.length] = SLASH
  output.set(bytes, prefix.length + separator)

  return output
}

/** @ignore */
export const makeBudget = (limits: TreeTransferLimits) => {
  let entries = 0
  let bytes = 0n

  return {
    entry: (path: Vfs.PathInput, pathBytes: number, depth: number) => {
      entries++

      if (entries > limits.maxEntries) return limitExceeded("maxEntries", path)

      if (depth > limits.maxDepth) return limitExceeded("maxDepth", path)

      return exceeds(pathBytes, limits.maxPathBytes) ? limitExceeded("maxPathBytes", path) : Effect.void
    },
    // A listing's names are held until each is visited, so the listing must fit the entry budget up front.
    listing: (path: Vfs.PathInput, pending: number) =>
      entries + pending > limits.maxEntries ? limitExceeded("maxEntries", path) : Effect.void,
    fileSize: (path: Vfs.PathInput, size: number | bigint) =>
      exceeds(size, limits.maxFileBytes) ? limitExceeded("maxFileBytes", path) : Effect.void,
    // File contents and symbolic-link targets count toward stored bytes, as they do for volume capacity.
    stored: (path: Vfs.PathInput, size: number) => {
      bytes += BigInt(size)

      return exceeds(bytes, limits.maxBytes) ? limitExceeded("maxBytes", path) : Effect.void
    }
  }
}

/** @ignore */
export const emitPath = (path: string | Uint8Array) =>
  Predicate.isString(path) ? Effect.succeed(path) : Vfs.pathFromBytes(path)

/** @ignore */
export interface Location {
  readonly key: string
  readonly parent: string | undefined
  readonly name: Vfs.PathInput
}

const latin1 = (bytes: Uint8Array) => {
  let output = ""

  for (const byte of bytes) output += String.fromCharCode(byte)

  return output
}

// Bytes that are valid UTF-8 key the same as the equivalent string path; other bytes get a prefix no string path has.
const byteKey = (bytes: Uint8Array) => decodeText(bytes) ?? `\u0000${latin1(bytes)}`

const isDotName = (name: string) => name === "" || name === "." || name === ".."

/** @ignore */
export const locate = Effect.fnUntraced(function*(path: Vfs.PathInput) {
  const invalid = new TransferError({ code: "InvalidEntry", field: "path", path })

  if (Predicate.isString(path)) {
    if (!path.startsWith("/")) return yield* invalid

    if (path === "/") return { key: "/", parent: undefined, name: path } satisfies Location
    const slash = path.lastIndexOf("/")
    const name = path.slice(slash + 1)

    if (isDotName(name)) return yield* invalid

    return { key: path, parent: slash === 0 ? "/" : path.slice(0, slash), name } satisfies Location
  }

  const bytes = yield* Vfs.pathToBytes(path)

  if (bytes[0] !== SLASH) return yield* invalid

  if (bytes.length === 1) return { key: "/", parent: undefined, name: path } satisfies Location
  const slash = bytes.lastIndexOf(SLASH)
  const name = bytes.subarray(slash + 1)

  if (isDotName(decodeText(name) ?? "-")) return yield* invalid

  return {
    key: byteKey(bytes),
    parent: slash === 0 ? "/" : byteKey(bytes.subarray(0, slash)),
    name: yield* toPathInput(name)
  } satisfies Location
})

/** @ignore */
export const pathKey = (path: Vfs.PathInput) =>
  Predicate.isString(path) ? Effect.succeed(path) : Vfs.pathToBytes(path).pipe(Effect.map(byteKey))

// Root testing does not decode byte paths; placement handles malformed input.
/** @ignore */
export const isRootPath = (path: Vfs.PathInput) =>
  Effect.succeed(Predicate.isString(path) ? path === "/" : BytePath.isRoot(path))

/** @ignore */
export interface VolumeTransferOptions {
  readonly volume?: Vfs.VolumeOptions | undefined
  readonly owner?: boolean | undefined
  readonly specialBits?: boolean | undefined
}

/** @ignore */
export interface WalkLocation<L> {
  readonly location: L
  readonly path: string | Uint8Array
  readonly pathBytes: number
  readonly depth: number
}

/** @ignore */
export interface WalkChild<L> {
  readonly name: string | Uint8Array
  readonly location: L
}

/** @ignore */
export type WalkNode<N, E> =
  | { readonly kind: "directory"; readonly entry: Extract<Entry, { kind: "directory" }>; readonly node: N }
  | {
    readonly kind: "content"
    readonly identity?: string | bigint | undefined
    // Hosts retire identities when every reported alias has been visited; callers retain them for the live walk.
    readonly aliases?: number | undefined
    readonly read: Effect.Effect<Entry, E>
  }

/** @ignore */
export const walk = <L, N, E>(
  root: L,
  limits: TreeTransferLimits,
  listChildren: (location: L, node: N) => Effect.Effect<ReadonlyArray<WalkChild<L>>, E>,
  readNode: (
    next: WalkLocation<L>,
    budget: ReturnType<typeof makeBudget>
  ) => Effect.Effect<WalkNode<N, E> | undefined, E>,
  pathInput: (path: string | Uint8Array) => Effect.Effect<Vfs.PathInput, E>
): Stream.Stream<Entry, E | TransferError> =>
  Stream.unwrap(Effect.sync(() => {
    const pending: Array<WalkLocation<L>> = [{ location: root, path: "/", pathBytes: 1, depth: 0 }]
    const aliases = new Map<string | bigint, { readonly path: Vfs.PathInput; readonly remaining: number | undefined }>()
    const budget = makeBudget(limits)

    const step = Effect.gen(function*() {
      const next = pending.pop()

      if (next === undefined) return [[], Option.none()] as const
      const path = yield* pathInput(next.path)
      yield* budget.entry(path, next.pathBytes, next.depth)
      const node = yield* readNode(next, budget)
      let entry: Entry | undefined

      if (node?.kind === "directory") {
        const children = (yield* listChildren(next.location, node.node))
          .map((child) => ({
            ...child,
            bytes: Predicate.isString(child.name) ? encoder.encode(child.name) : child.name
          }))
          .sort((left, right) => BytePath.byteOrder(left.bytes, right.bytes))

        for (let index = children.length - 1; index >= 0; index--) {
          const child = children[index]

          if (child === undefined) continue
          const nameBytes = child.bytes.length
          pending.push({
            location: child.location,
            path: childPath(next.path, child.name),
            pathBytes: next.pathBytes === 1 ? 1 + nameBytes : next.pathBytes + 1 + nameBytes,
            depth: next.depth + 1
          })
        }

        yield* budget.listing(path, pending.length)
        entry = node.entry
      } else if (node !== undefined) {
        const alias = node.identity === undefined ? undefined : aliases.get(node.identity)

        if (alias !== undefined) {
          if (node.identity !== undefined && alias.remaining !== undefined) {
            if (alias.remaining <= 1) aliases.delete(node.identity)
            else aliases.set(node.identity, { path: alias.path, remaining: alias.remaining - 1 })
          }

          entry = { kind: "hardLink", path, target: alias.path }
        } else {
          entry = yield* node.read

          if (node.identity !== undefined) {
            aliases.set(node.identity, { path, remaining: node.aliases === undefined ? undefined : node.aliases - 1 })
          }
        }
      }

      return [entry === undefined ? [] : [entry], pending.length > 0 ? Option.some(undefined) : Option.none()] as const
    })

    return Stream.paginate(undefined, () => step)
  }))

/** @ignore */
export const placement = (policy: "caller" | "fileSystem" | "volume") => {
  let started = false
  const directories = new Set<string>()
  const others = new Set<string>()
  const received = new Set<string>()

  const start = Effect.fnUntraced(function*(entry: Entry) {
    // FileSystem checks root sequencing before rejecting byte names.
    const location = policy === "fileSystem"
      ? Predicate.isString(entry.path)
        ? {
          key: entry.path,
          parent: entry.path === "/"
            ? undefined
            : entry.path.lastIndexOf("/") === 0
            ? "/"
            : entry.path.slice(0, entry.path.lastIndexOf("/")),
          name: entry.path.slice(entry.path.lastIndexOf("/") + 1)
        }
        : undefined
      : yield* locate(entry.path)

    const root = policy === "fileSystem" ? yield* isRootPath(entry.path) : location?.parent === undefined

    if (root ? started : !started) {
      return yield* new TransferError({ code: "InvalidEntry", field: "root", path: entry.path })
    }

    started = true

    const key = yield* pathKey(entry.path)

    if (received.has(key)) {
      return yield* new TransferError({ code: "InvalidEntry", field: "path", path: entry.path })
    }

    received.add(key)

    return location
  })

  const check = Effect.fnUntraced(function*(entry: Entry, location: Location) {
    if (location.parent !== undefined && !directories.has(location.parent)) {
      return yield* new TransferError({ code: "InvalidEntry", field: "parent", path: entry.path })
    }

    if (policy === "volume") {
      if (entry.kind === "hardLink" && !others.has(yield* pathKey(entry.target))) {
        return yield* new TransferError({ code: "InvalidEntry", field: "target", path: entry.path })
      }
    }
  })

  return {
    start,
    check,
    remember: (entry: Entry, location: Location) => {
      if (entry.kind === "directory") directories.add(location.key)
      else if (policy === "volume") others.add(location.key)
    },
    finish: Effect.gen(function*() {
      if (!started) return yield* new TransferError({ code: "InvalidEntry", field: "root" })
    })
  }
}

/** @ignore */
export interface SinkState<D, C, E> {
  readonly existing: "reject" | "overwrite"
  readonly times: "none" | "mtime" | "all"
  readonly modeOf: (metadata: EntryMetadata | undefined, fallback: number) => number
  readonly directories: Array<D>
  readonly skipped: Array<SkippedEntry>
  readonly claim: (identity: Effect.Effect<C, E>) => Effect.Effect<void, E>
  readonly file: (size: number) => void
  readonly degrade: () => void
}

/** @ignore */
export type EntryMetadata = NonNullable<Extract<Entry, { readonly kind: "file" }>["metadata"]>

/** @ignore */
export interface SinkStep<D, C, E> {
  readonly prepare?: ((entry: Entry, location: Location | undefined) => Effect.Effect<boolean, E>) | undefined
  readonly write: (entry: Entry, location: Location) => Effect.Effect<boolean | void, E>
  readonly removeClaimed: (identity: C) => Effect.Effect<void, E>
  readonly restoreMode: (directory: D) => Effect.Effect<void, E>
  readonly finishDirectory: (directory: D) => Effect.Effect<void, E>
  readonly finish?: Effect.Effect<void, E> | undefined
  readonly close?: ((exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void>) | undefined
}

/** @ignore */
export const sink = <D, C, E>(
  policy: "caller" | "fileSystem",
  options: WriteOptions | undefined,
  setup: (state: SinkState<D, C, E>) => Effect.Effect<SinkStep<D, C, E>, E, Scope.Scope>
): Sink.Sink<TransferReport, Entry, never, E | TransferError | Vfs.VfsError> =>
  Sink.unwrap(Effect.gen(function*() {
    const existing = options?.existing ?? "reject"
    const times = options?.times ?? "mtime"
    const modeMask = options?.specialBits ? MODE_BITS : PERMISSION_BITS
    const directories: Array<D> = []
    const skipped: Array<SkippedEntry> = []
    let claimed: C | undefined
    let completed = false
    let entries = 0
    let files = 0
    let bytes = 0n
    let hardLinksDegraded = 0

    const state: SinkState<D, C, E> = {
      existing,
      times,
      directories,
      skipped,
      modeOf: (metadata, fallback) => (metadata?.mode ?? fallback) & modeMask,
      claim: Effect.fnUntraced(function*(identity: Effect.Effect<C, E>) {
        if (existing === "reject") claimed = yield* identity
      }),
      file: (size) => {
        files++
        bytes += BigInt(size)
      },
      degrade: () => {
        hardLinksDegraded++
      }
    }

    const adapter = yield* setup(state)
    const positions = placement(policy)
    yield* Effect.addFinalizer((exit) => {
      const cleanup = completed ? Effect.void : claimed === undefined
        ? Effect.forEach(directories, (directory) => adapter.restoreMode(directory).pipe(Effect.ignore), {
          discard: true
        })
        : adapter.removeClaimed(claimed)

      return cleanup.pipe(Effect.orDie, Effect.ensuring(adapter.close?.(exit) ?? Effect.void))
    })

    const write = Effect.fnUntraced(function*(entry: Entry) {
      // Caller counts only paths accepted by locate; FileSystem counts every received entry.
      if (policy === "fileSystem") entries++
      const location = yield* positions.start(entry)

      if (policy === "caller") entries++

      if (adapter.prepare !== undefined && !(yield* adapter.prepare(entry, location))) return

      if (location === undefined) return yield* new TransferError({ code: "UnrepresentableName", path: entry.path })
      yield* positions.check(entry, location)
      const written = yield* adapter.write(entry, location)

      if (written !== false) positions.remember(entry, location)
    })

    const finish = Effect.gen(function*() {
      yield* positions.finish

      if (adapter.finish !== undefined) yield* adapter.finish

      // Children finish before parents; no interruption may leave half-applied restrictive directory modes.
      for (const directory of [...directories].reverse()) yield* adapter.finishDirectory(directory)
      completed = true

      return { entries, files, bytes: ByteSize.bytes(bytes), skipped, hardLinksDegraded } satisfies TransferReport
    })

    return Sink.forEach(write).pipe(Sink.mapEffect(() => Effect.uninterruptible(finish)))
  }))
