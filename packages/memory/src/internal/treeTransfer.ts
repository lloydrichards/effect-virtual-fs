/**
 * Streams directory trees between callers, snapshots, and new volumes.
 *
 * Sources emit fixture entries in sorted pre-order with paths rooted at the
 * transfer root. Sinks apply the write policy and never read back from the
 * source.
 *
 * @internal
 * @since 0.6.0
 */
import { BytePath, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import { at } from "./adapterSupport.js"
// The public module defines TransferError and calls into this module only when its functions run, so the import cycle
// never reads an uninitialized binding while either module loads.
import {
  type Entry,
  type ReadOptions,
  TransferError,
  type TransferReport,
  type TreeTransferLimits,
  type VolumeTransferOptions,
  type WriteOptions
} from "../TreeTransfer.js"
import { defaultLimits, makeLimits, TreeTransferLimitsSchema } from "./treeTransferModel.js"

type EntryMetadata = NonNullable<Extract<Entry, { readonly kind: "file" }>["metadata"]>

const UNBOUNDED_BYTES = ByteSize.bytes(2n ** 64n)

/**
 * Derives a transfer policy that is only as strict as the volume itself, for
 * adapter operations whose public signature has no limits parameter.
 *
 * @internal
 */
export const volumeLimits = (limits: Vfs.VolumeLimits): TreeTransferLimits =>
  makeLimits({
    maxEntries: limits.maxEntries ?? Number.MAX_SAFE_INTEGER,
    maxBytes: limits.maxBytes ?? UNBOUNDED_BYTES,
    maxFileBytes: limits.maxFileBytes,
    maxDepth: Number.MAX_SAFE_INTEGER,
    maxPathBytes: limits.maxPathBytes ?? UNBOUNDED_BYTES
  })

const SLASH = 0x2f
const DEFAULT_DIRECTORY_MODE = 0o755
const DEFAULT_FILE_MODE = 0o644
const OWNER_ACCESS = 0o700
const PERMISSION_BITS = 0o777
const MODE_BITS = 0o7777

const encoder = new TextEncoder()

const decodeText = (bytes: Uint8Array): string | undefined => Option.getOrUndefined(BytePath.decodeOption(bytes))

// A name stays a string while it is UTF-8, so consumers can filter entries without decoding.
const toPathInput = (bytes: Uint8Array): Effect.Effect<Vfs.PathInput, Vfs.VfsError> => {
  const text = decodeText(bytes)

  return text === undefined ? BytePath.fromBytes(bytes) : Effect.succeed(text)
}

/** @internal */
export const exceeds = (value: number | bigint, limit: ByteSize.ByteSize) =>
  ByteSize.isGreaterThan(ByteSize.bytes(value), limit)

/** @internal */
export const limitExceeded = (field: keyof TreeTransferLimits, path?: Vfs.PathInput) =>
  new TransferError(path === undefined ? { code: "LimitExceeded", field } : { code: "LimitExceeded", field, path })

/** @internal */
export const resolveLimits = (limits: TreeTransferLimits | undefined) =>
  limits === undefined
    ? Effect.succeed(defaultLimits)
    : Schema.decodeEffect(TreeTransferLimitsSchema)(limits).pipe(
      Effect.mapError(() => new TransferError({ code: "InvalidArgument", field: "limits" }))
    )

const entryMetadata = (metadata: Vfs.Metadata): EntryMetadata => ({
  uid: metadata.uid,
  gid: metadata.gid,
  mode: metadata.mode,
  atimeNs: metadata.atimeNs,
  mtimeNs: metadata.mtimeNs,
  ctimeNs: metadata.ctimeNs,
  birthtimeNs: metadata.birthtimeNs
})

interface Pending {
  // The root's path, then each name below it, never following a final link. Every entry is reached by name, as a
  // path lookup reaches it, so it needs search permission on each directory above it and a directory renamed out
  // of the tree is not followed, and the stream holds no directory handle while it runs.
  readonly location: string | Uint8Array
  // Stays a string while every component is UTF-8, so consumers can filter entries without decoding.
  readonly path: string | Uint8Array
  readonly pathBytes: number
  readonly depth: number
}

const childPath = (parent: string | Uint8Array, name: Uint8Array, text: string | undefined) => {
  if (Predicate.isString(parent) && text !== undefined) {
    return parent.endsWith("/")
      ? `${parent}${text}`
      : `${parent}/${text}`
  }

  const prefix = Predicate.isString(parent) ? encoder.encode(parent) : parent
  const separator = prefix.at(-1) === SLASH ? 0 : 1
  const output = new Uint8Array(prefix.length + separator + name.length)
  output.set(prefix)

  if (separator === 1) output[prefix.length] = SLASH
  output.set(name, prefix.length + separator)

  return output
}

const emitPath = (path: string | Uint8Array) =>
  Predicate.isString(path) ? Effect.succeed(path) : Vfs.pathFromBytes(path)

/** @internal */
export const fromCaller = (
  caller: Vfs.Caller,
  root: Vfs.PathInput,
  options?: ReadOptions
): Stream.Stream<Entry, TransferError | Vfs.VfsError> =>
  Stream.unwrap(Effect.gen(function*() {
    const limits = yield* resolveLimits(options?.limits)
    const location = Predicate.isString(root) ? root : yield* BytePath.toBytes(root)
    const pending: Array<Pending> = [{ location, path: "/", pathBytes: 1, depth: 0 }]
    const firstAliases = new Map<bigint, Vfs.PathInput>()
    let entries = 0
    let bytes = 0n

    const step = Effect.gen(function*() {
      const next = pending.pop()

      if (next === undefined) return [[], Option.none()] as const
      const path = yield* emitPath(next.path)
      entries++

      if (entries > limits.maxEntries) return yield* limitExceeded("maxEntries", path)

      if (next.depth > limits.maxDepth) return yield* limitExceeded("maxDepth", path)

      if (exceeds(next.pathBytes, limits.maxPathBytes)) return yield* limitExceeded("maxPathBytes", path)
      const target = at(yield* emitPath(next.location), undefined, false)
      // Metadata is read before contents so entries carry the source's pre-read access time.
      const metadata = yield* caller.stat(target)
      let entry: Entry

      if (metadata.kind === "directory") {
        const names = (yield* caller.readDirectory(target)).value.map((child) => child.name).sort(BytePath.byteOrder)

        for (let index = names.length - 1; index >= 0; index--) {
          const name = names[index]

          if (name === undefined) continue
          const text = decodeText(name)
          pending.push({
            location: childPath(next.location, name, text),
            path: childPath(next.path, name, text),
            pathBytes: next.pathBytes === 1 ? 1 + name.length : next.pathBytes + 1 + name.length,
            depth: next.depth + 1
          })
        }

        // A listing is held in memory until visited, so a single huge directory must fit the entry budget up front.
        if (entries + pending.length > limits.maxEntries) return yield* limitExceeded("maxEntries", path)

        entry = { kind: "directory", path, metadata: entryMetadata(metadata) }
      } else {
        const alias = metadata.nlink > 1 ? firstAliases.get(metadata.ino) : undefined

        if (alias !== undefined) {
          entry = { kind: "hardLink", path, target: alias }
        } else {
          if (metadata.nlink > 1) firstAliases.set(metadata.ino, path)

          if (metadata.kind === "file") {
            if (exceeds(metadata.size, limits.maxFileBytes)) return yield* limitExceeded("maxFileBytes", path)
            const contents = yield* caller.readFile(target)

            if (exceeds(contents.length, limits.maxFileBytes)) return yield* limitExceeded("maxFileBytes", path)
            bytes += BigInt(contents.length)

            if (exceeds(bytes, limits.maxBytes)) return yield* limitExceeded("maxBytes", path)
            entry = { kind: "file", path, bytes: contents, metadata: entryMetadata(metadata) }
          } else {
            const link = yield* caller.readLink(target)
            // Symlink targets count toward stored bytes, as they do for volume capacity.
            bytes += BigInt(link.length)

            if (exceeds(bytes, limits.maxBytes)) return yield* limitExceeded("maxBytes", path)
            entry = { kind: "symlink", path, target: yield* toPathInput(link), metadata: entryMetadata(metadata) }
          }
        }
      }

      return [[entry], pending.length > 0 ? Option.some(undefined) : Option.none()] as const
    })

    return Stream.paginate(undefined, () => step)
  }))

/** @internal */
export const fromSnapshot = (snapshot: Vfs.Snapshot, root: Vfs.PathInput, options?: ReadOptions) =>
  Stream.unwrap(Effect.gen(function*() {
    const volume = yield* Vfs.fromSnapshot(snapshot)

    return fromCaller(yield* volume.caller(), root, options)
  }))

interface Location {
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

const locate = Effect.fnUntraced(function*(path: Vfs.PathInput) {
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

const targetOf = (written: Written, followFinalSymlink?: boolean) => at(written.name, written.base, followFinalSymlink)

const pathKey = (path: Vfs.PathInput) =>
  Predicate.isString(path) ? Effect.succeed(path) : Vfs.pathToBytes(path).pipe(Effect.map(byteKey))

interface Written {
  readonly base: Vfs.DirectoryHandle | undefined
  readonly name: Vfs.PathInput
}

interface CreatedDirectory extends Written {
  readonly mode: number | undefined
  readonly metadata: EntryMetadata | undefined
}

// Removes a tree this sink created. Directories may already carry restrictive final modes, so owner access is
// restored before each one is listed.
const removeTree = Effect.fnUntraced(function*(caller: Vfs.Caller, path: Vfs.PathInput) {
  if ((yield* caller.stat(at(path, undefined, false))).kind !== "directory") return yield* caller.unlink(path)

  return yield* Effect.scoped(Effect.gen(function*() {
    yield* caller.chmod(path, OWNER_ACCESS)
    const root = yield* caller.openDirectory(path)
    const visited: Array<{ base: Vfs.DirectoryHandle; name: Vfs.PathInput; directory: boolean }> = []
    const pending = [root]

    while (pending.length > 0) {
      const base = pending.pop()

      if (base === undefined) break

      for (const bytes of (yield* caller.readDirectory(base)).value.map((entry) => entry.name)) {
        const name = yield* toPathInput(bytes)
        const directory = (yield* caller.stat(at(name, base, false))).kind === "directory"
        visited.push({ base, name, directory })

        if (directory) {
          yield* caller.chmod(at(name, base), OWNER_ACCESS)
          pending.push(yield* caller.openDirectory(at(name, base)))
        }
      }
    }

    // Children follow their parents in `visited`, so removing in reverse empties each directory first.
    for (const entry of visited.reverse()) {
      yield* entry.directory
        ? caller.rmdir(at(entry.name, entry.base))
        : caller.unlink(at(entry.name, entry.base))
    }

    yield* caller.rmdir(path)
  }))
})

/** @internal */
export const toCaller = (
  caller: Vfs.Caller,
  destination: Vfs.PathInput,
  options?: WriteOptions
): Sink.Sink<TransferReport, Entry, never, TransferError | Vfs.VfsError> =>
  Sink.unwrap(Effect.gen(function*() {
    // Handles live in their own scope so the cleanup finalizer below can still use them.
    const handles = yield* Scope.make()
    const existing = options?.existing ?? "reject"
    const times = options?.times ?? "mtime"
    const modeMask = options?.specialBits ? MODE_BITS : PERMISSION_BITS
    const create = existing === "reject" ? "exclusive" : "ifMissing"
    const bases = new Map<string, Vfs.DirectoryHandle>()
    const written = new Map<string, Written>()
    const directories: Array<CreatedDirectory> = []
    let started = false
    let claimedIno: bigint | undefined
    let completed = false
    let entries = 0
    let files = 0
    let bytes = 0n

    // A failed overwrite keeps what it wrote, but its new directories get their final modes back.
    const restoreModes = Effect.forEach(directories, (directory) =>
      directory.mode === undefined
        ? Effect.void
        : caller.chmod(targetOf(directory), directory.mode).pipe(Effect.ignore), { discard: true })

    // Only a root this sink claimed exclusively is removed, and only while it is still the same object.
    const removeClaimed = Effect.gen(function*() {
      const current = yield* Effect.result(caller.stat(at(destination, undefined, false)))

      if (Result.isSuccess(current) && current.success.ino === claimedIno) yield* removeTree(caller, destination)
    })

    yield* Effect.addFinalizer((exit) =>
      Effect.gen(function*() {
        if (!completed) yield* claimedIno === undefined ? restoreModes : removeClaimed
      }).pipe(Effect.orDie, Effect.ensuring(Scope.close(handles, exit)))
    )

    const claim = Effect.gen(function*() {
      if (existing === "reject") claimedIno = (yield* caller.stat(at(destination, undefined, false))).ino
    })

    const modeOf = (entry: Entry, fallback: number) =>
      ("metadata" in entry && entry.metadata?.mode !== undefined ? entry.metadata.mode : fallback) & modeMask

    const applyTimes = (target: Vfs.PathTarget, metadata: EntryMetadata | undefined) => {
      if (times === "none" || metadata?.mtimeNs === undefined) return Effect.void

      return caller.utimes(target, {
        access: times === "all" && metadata.atimeNs !== undefined
          ? { kind: "value", nanoseconds: metadata.atimeNs }
          : { kind: "omit" },
        modification: { kind: "value", nanoseconds: metadata.mtimeNs }
      })
    }

    const clearExisting = Effect.fnUntraced(function*(name: Vfs.PathInput, base: Vfs.DirectoryHandle | undefined) {
      const current = yield* Effect.result(caller.stat(at(name, base, false)))

      if (Result.isFailure(current)) {
        return current.failure.code === "NotFound" ? undefined : yield* current.failure
      }

      if (current.success.kind === "directory") {
        return yield* new Vfs.VfsError({ code: "IsDirectory", operation: "treeTransfer" })
      }

      return yield* caller.unlink(at(name, base))
    })

    const makeDirectory = Effect.fnUntraced(
      function*(name: Vfs.PathInput, base: Vfs.DirectoryHandle | undefined, mode: number) {
        // Owner access stays open until every child is written; the exact mode is applied afterwards.
        const made = yield* Effect.result(caller.mkdir(at(name, base), { mode: mode | OWNER_ACCESS }))

        if (Result.isSuccess(made)) return true

        if (existing === "reject" || made.failure.code !== "AlreadyExists") return yield* made.failure

        if ((yield* caller.stat(at(name, base, false))).kind !== "directory") {
          return yield* new Vfs.VfsError({ code: "NotDirectory", operation: "treeTransfer" })
        }

        return false
      }
    )

    const write = Effect.fnUntraced(function*(entry: Entry) {
      const location = yield* locate(entry.path)
      entries++

      if (location.parent === undefined ? started : !started) {
        return yield* new TransferError({ code: "InvalidEntry", field: "root", path: entry.path })
      }

      started = true
      const base = location.parent === undefined ? undefined : bases.get(location.parent)

      if (location.parent !== undefined && base === undefined) {
        return yield* new TransferError({ code: "InvalidEntry", field: "parent", path: entry.path })
      }

      const name = base === undefined ? destination : location.name

      switch (entry.kind) {
        case "directory": {
          const mode = modeOf(entry, DEFAULT_DIRECTORY_MODE)
          const created = yield* makeDirectory(name, base, mode)

          if (base === undefined && created) yield* claim
          bases.set(location.key, yield* Scope.provide(caller.openDirectory(at(name, base)), handles))
          directories.push({ base, name, mode: created ? mode : undefined, metadata: entry.metadata })

          return
        }

        case "file": {
          const mode = modeOf(entry, DEFAULT_FILE_MODE)

          yield* caller.writeFile(at(name, base), entry.bytes, {
            access: "write",
            create,
            truncate: true,
            mode,
            finalMode: mode,
            replaceFinalSymlink: true
          })
          files++
          bytes += BigInt(entry.bytes.length)
          break
        }

        case "symlink": {
          if (existing === "overwrite") yield* clearExisting(name, base)

          yield* caller.symlink(entry.target, at(name, base))
          break
        }

        case "hardLink": {
          const source = written.get(yield* pathKey(entry.target))

          // Only entries below the root can be link sources or targets, so both sides have a parent handle.
          if (base === undefined || source?.base === undefined) {
            return yield* new TransferError({ code: "InvalidEntry", field: "target", path: entry.path })
          }

          if (existing === "overwrite") yield* clearExisting(name, base)

          yield* caller.link(at(source.name, source.base), at(name, base))
          written.set(location.key, { base, name })

          return
        }
      }

      if (base === undefined) yield* claim
      written.set(location.key, { base, name })
      yield* applyTimes(at(name, base, false), entry.metadata)
    })

    const finish = Effect.gen(function*() {
      if (!started) return yield* new TransferError({ code: "InvalidEntry", field: "root" })

      // Reverse creation order visits children before parents, so later writes cannot disturb applied times or modes.
      for (const directory of [...directories].reverse()) {
        // Skipping a mode that is already exact avoids a redundant change event.
        if (directory.mode !== undefined && (yield* caller.stat(targetOf(directory, false))).mode !== directory.mode) {
          yield* caller.chmod(targetOf(directory), directory.mode)
        }

        yield* applyTimes(targetOf(directory), directory.metadata)
      }

      completed = true

      return {
        entries,
        files,
        bytes: ByteSize.bytes(bytes),
        skipped: [],
        hardLinksDegraded: 0
      } satisfies TransferReport
    })

    // Uninterruptible, so a transfer is never abandoned halfway through applying final directory modes.
    return Sink.forEach(write).pipe(Sink.mapEffect(() => Effect.uninterruptible(finish)))
  }))

// Never fails: an entry whose path is malformed is not the root, so the sink reports it as InvalidEntry.
/** @internal */
export const isRootPath = (path: Vfs.PathInput) =>
  Effect.succeed(Predicate.isString(path) ? path === "/" : BytePath.isRoot(path))

const volumeMetadata = (metadata: EntryMetadata | undefined, options: VolumeTransferOptions | undefined) => {
  if (metadata === undefined) return undefined
  const { uid, gid, mode, ...rest } = metadata
  const output: { -readonly [Key in keyof EntryMetadata]: EntryMetadata[Key] } = rest

  if (options?.owner === true && uid !== undefined) output.uid = uid

  if (options?.owner === true && gid !== undefined) output.gid = gid

  if (mode !== undefined) output.mode = mode & (options?.specialBits === true ? MODE_BITS : PERMISSION_BITS)

  return output
}

const withVolumeMetadata = (entry: Entry, options: VolumeTransferOptions | undefined): Entry => {
  if (entry.kind === "hardLink") return entry
  const { metadata, ...rest } = entry
  const applied = volumeMetadata(metadata, options)

  return applied === undefined ? rest : { ...rest, metadata: applied }
}

/** @internal */
export const toVolume = Effect.fnUntraced(function*<E, R>(
  entries: Stream.Stream<Entry, E, R>,
  options?: VolumeTransferOptions
) {
  const [root, ...rest] = yield* Stream.runCollect(entries)

  if (root === undefined || root.kind !== "directory" || !(yield* isRootPath(root.path))) {
    return yield* new TransferError({ code: "InvalidEntry", field: "root" })
  }

  // Applies the same placement rules as the live sinks, so every sink accepts the same streams.
  const directoryKeys = new Set(["/"])
  const otherKeys = new Set<string>()

  for (const entry of rest) {
    const location = yield* locate(entry.path)

    if (location.parent === undefined) {
      return yield* new TransferError({ code: "InvalidEntry", field: "root", path: entry.path })
    }

    if (!directoryKeys.has(location.parent)) {
      return yield* new TransferError({ code: "InvalidEntry", field: "parent", path: entry.path })
    }

    if (directoryKeys.has(location.key) || otherKeys.has(location.key)) {
      return yield* new TransferError({ code: "InvalidEntry", field: "path", path: entry.path })
    }

    if (entry.kind === "hardLink" && !otherKeys.has(yield* pathKey(entry.target))) {
      return yield* new TransferError({ code: "InvalidEntry", field: "target", path: entry.path })
    }

    if (entry.kind === "directory") directoryKeys.add(location.key)
    else otherKeys.add(location.key)
  }

  const rootMetadata = volumeMetadata(root.metadata, options)
  const fixtureEntries = rest.map((entry) => withVolumeMetadata(entry, options))

  return yield* Vfs.fromFixture(
    rootMetadata === undefined ? { entries: fixtureEntries } : { rootMetadata, entries: fixtureEntries },
    options?.volume
  )
})
