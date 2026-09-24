/**
 * Adapts an application-provided Effect `FileSystem` as a tree transfer source
 * and sink.
 *
 * Effect's `FileSystem` has string paths, millisecond times, no change time, and
 * a `stat` that follows symbolic links. Links are detected by comparing a
 * resolved path with its expected canonical path. Host paths use `/`
 * separators.
 *
 * @internal
 * @since 0.6.0
 */
import type { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as ByteSize from "effect/ByteSize"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import type { PlatformError } from "effect/PlatformError"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import {
  type Entry,
  type FileSystemReadOptions,
  type FileSystemWriteOptions,
  type SkippedEntry,
  TransferError,
  type TransferReport
} from "../TreeTransfer.js"
import { compareBytes, exceeds, isRootPath, limitExceeded, resolveLimits } from "./treeTransfer.js"

type EntryMetadata = NonNullable<Extract<Entry, { readonly kind: "file" }>["metadata"]>

type MutableEntryMetadata = { -readonly [Key in keyof EntryMetadata]: EntryMetadata[Key] }

type SkipReason = SkippedEntry["reason"]

const READ_CHUNK_BYTES = 64 * 1024
const MAX_SYMLINK_HOPS = 40
const DEFAULT_DIRECTORY_MODE = 0o755
const DEFAULT_FILE_MODE = 0o644
const OWNER_ACCESS = 0o700
const PERMISSION_BITS = 0o777
const MODE_BITS = 0o7777
const NANOSECONDS_PER_MILLISECOND = 1_000_000n
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd)

const encoder = new TextEncoder()

const hostPath = (root: string, path: string) => path === "/" ? root : `${root.replace(/\/+$/, "")}${path}`

const childPath = (parent: string, name: string) => parent === "/" ? `/${name}` : `${parent}/${name}`

const isReason = (tag: "AlreadyExists" | "NotFound") => (error: PlatformError) => Predicate.isTagged(tag)(error.reason)

const nanoseconds = (date: Option.Option<Date>) =>
  Option.getOrUndefined(Option.map(date, (value) => BigInt(value.getTime()) * NANOSECONDS_PER_MILLISECOND))

const hostMetadata = (info: FileSystem.File.Info): EntryMetadata => {
  const metadata: MutableEntryMetadata = { mode: info.mode & MODE_BITS }

  const uid = Option.getOrUndefined(info.uid)
  const gid = Option.getOrUndefined(info.gid)
  const atimeNs = nanoseconds(info.atime)
  const mtimeNs = nanoseconds(info.mtime)
  const birthtimeNs = nanoseconds(info.birthtime)

  if (uid !== undefined) metadata.uid = uid

  if (gid !== undefined) metadata.gid = gid

  if (atimeNs !== undefined) metadata.atimeNs = atimeNs

  if (mtimeNs !== undefined) metadata.mtimeNs = mtimeNs

  if (birthtimeNs !== undefined) metadata.birthtimeNs = birthtimeNs

  return metadata
}

const readCapped = (fs: FileSystem.FileSystem, path: string, limit: ByteSize.ByteSize, entryPath: string) =>
  Effect.scoped(Effect.gen(function*() {
    const file = yield* fs.open(path, { flag: "r" })
    const chunks: Array<Uint8Array> = []
    let total = 0

    while (true) {
      const chunk = yield* file.readAlloc(READ_CHUNK_BYTES)

      if (Option.isNone(chunk)) break
      total += chunk.value.length

      // The cap holds even when the file grows after its size was checked.
      if (exceeds(total, limit)) return yield* limitExceeded("maxFileBytes", entryPath)
      chunks.push(chunk.value)
    }

    const output = new Uint8Array(total)
    let offset = 0

    for (const chunk of chunks) {
      output.set(chunk, offset)
      offset += chunk.length
    }

    return output
  }))

interface Pending {
  readonly host: string
  // The resolved path this entry has when it is not a symbolic link. Undefined for the root.
  readonly canonical: string | undefined
  readonly path: string
  readonly name: string
  readonly pathBytes: number
  readonly depth: number
}

/** @internal */
export const fromFileSystem = (
  fs: FileSystem.FileSystem,
  root: string,
  options?: FileSystemReadOptions
): Stream.Stream<Entry, TransferError | PlatformError> =>
  Stream.unwrap(Effect.gen(function*() {
    const limits = yield* resolveLimits(options?.limits)
    const unsupported = options?.unsupported ?? "fail"

    const onSkip = options?.onSkip ??
      ((skipped: SkippedEntry) => Effect.logWarning("TreeTransfer skipped entry", skipped))

    const pending: Array<Pending> = [{ host: root, canonical: undefined, path: "/", name: "", pathBytes: 1, depth: 0 }]
    const firstAliases = new Map<string, { path: string; remaining: number }>()
    let entries = 0
    let bytes = 0n

    const refuse = (path: string, reason: SkipReason) =>
      unsupported === "skip"
        ? onSkip({ path, reason }).pipe(Effect.as(undefined))
        : Effect.fail(new TransferError({ code: reason, path }))

    const readLinkTarget = Effect.fnUntraced(function*(next: Pending) {
      if (next.canonical === undefined) {
        const target = yield* Effect.result(fs.readLink(next.host))

        return Result.isSuccess(target) ? target.success : undefined
      }

      const resolved = yield* Effect.result(fs.realPath(next.host))

      if (Result.isSuccess(resolved) && resolved.success === next.canonical) return undefined

      if (Result.isFailure(resolved) && !isReason("NotFound")(resolved.failure)) return yield* resolved.failure

      // A different resolved path, or a missing one, means this name is a link.
      return yield* fs.readLink(next.host)
    })

    const visit = Effect.fnUntraced(function*(next: Pending) {
      entries++

      if (entries > limits.maxEntries) return yield* limitExceeded("maxEntries", next.path)

      if (next.depth > limits.maxDepth) return yield* limitExceeded("maxDepth", next.path)

      if (exceeds(next.pathBytes, limits.maxPathBytes)) return yield* limitExceeded("maxPathBytes", next.path)

      // Effect's FileSystem decodes host names as UTF-8, so a replacement character marks a name it could not carry.
      if (next.name.includes(REPLACEMENT_CHARACTER)) return yield* refuse(next.path, "UnrepresentableName")
      const target = yield* readLinkTarget(next)

      if (target !== undefined) {
        bytes += BigInt(encoder.encode(target).length)

        if (exceeds(bytes, limits.maxBytes)) return yield* limitExceeded("maxBytes", next.path)

        return { kind: "symlink", path: next.path, target } satisfies Entry
      }

      const info = yield* fs.stat(next.host)

      if (info.type === "Directory") {
        const canonical = next.canonical ?? (yield* fs.realPath(next.host))

        const names = (yield* fs.readDirectory(next.host))
          .map((name) => ({ name, bytes: encoder.encode(name) }))
          .sort((left, right) => compareBytes(left.bytes, right.bytes))

        for (const child of names.reverse()) {
          pending.push({
            host: childPath(next.host, child.name),
            canonical: childPath(canonical, child.name),
            path: childPath(next.path, child.name),
            name: child.name,
            pathBytes: next.pathBytes === 1 ? 1 + child.bytes.length : next.pathBytes + 1 + child.bytes.length,
            depth: next.depth + 1
          })
        }

        return { kind: "directory", path: next.path, metadata: hostMetadata(info) } satisfies Entry
      }

      if (info.type !== "File") return yield* refuse(next.path, "UnsupportedEntryType")
      const ino = Option.getOrUndefined(info.ino)
      const nlink = Option.getOrUndefined(info.nlink) ?? 1
      const identity = ino === undefined || nlink < 2 ? undefined : `${info.dev}:${ino}`
      const alias = identity === undefined ? undefined : firstAliases.get(identity)

      if (identity !== undefined && alias !== undefined) {
        // Forget an identity once every alias has been seen, so the table only holds links still expected.
        if (alias.remaining <= 1) firstAliases.delete(identity)
        else firstAliases.set(identity, { path: alias.path, remaining: alias.remaining - 1 })

        return { kind: "hardLink", path: next.path, target: alias.path } satisfies Entry
      }

      if (exceeds(info.size, limits.maxFileBytes)) return yield* limitExceeded("maxFileBytes", next.path)
      const contents = yield* readCapped(fs, next.host, limits.maxFileBytes, next.path)
      bytes += BigInt(contents.length)

      if (exceeds(bytes, limits.maxBytes)) return yield* limitExceeded("maxBytes", next.path)

      if (identity !== undefined) firstAliases.set(identity, { path: next.path, remaining: nlink - 1 })

      return { kind: "file", path: next.path, bytes: contents, metadata: hostMetadata(info) } satisfies Entry
    })

    const step = Effect.gen(function*() {
      const next = pending.pop()

      if (next === undefined) return [[], Option.none()] as const
      const entry = yield* visit(next)
      const more = pending.length > 0 ? Option.some(undefined) : Option.none()

      return [entry === undefined ? [] : [entry], more] as const
    })

    return Stream.paginate(undefined, () => step)
  }))

// Resolves a link target against the links in the transferred set. A target escapes when it is absolute or when
// resolving `..` or another in-tree link would leave the transfer root.
const escapes = (linkPath: string, target: string, links: ReadonlyMap<string, string>) => {
  if (linkPath === "/" || target.startsWith("/")) return true
  const stack = linkPath.split("/").filter((part) => part.length > 0).slice(0, -1)
  const queue = target.split("/")
  let hops = 0

  while (queue.length > 0) {
    const component = queue.shift()

    if (component === undefined || component === "" || component === ".") continue

    if (component === "..") {
      if (stack.length === 0) return true
      stack.pop()
      continue
    }

    stack.push(component)
    const next = links.get(`/${stack.join("/")}`)

    if (next === undefined) continue
    hops++

    if (hops > MAX_SYMLINK_HOPS || next.startsWith("/")) return true
    stack.pop()
    queue.unshift(...next.split("/"))
  }

  return false
}

// The destination may not exist yet, so its canonical path is its parent's resolved path plus its own name.
const canonicalDestination = Effect.fnUntraced(function*(fs: FileSystem.FileSystem, destination: string) {
  const trimmed = destination.replace(/\/+$/, "") || "/"

  if (trimmed === "/") return trimmed
  const slash = trimmed.lastIndexOf("/")
  const parent = yield* fs.realPath(slash < 0 ? "." : slash === 0 ? "/" : trimmed.slice(0, slash))

  return childPath(parent, trimmed.slice(slash + 1))
})

interface DeferredLink {
  readonly path: string
  readonly host: string
  readonly target: string
}

interface CreatedDirectory {
  readonly path: string
  readonly host: string
  readonly mode: number | undefined
  readonly metadata: EntryMetadata | undefined
}

/** @internal */
export const toFileSystem = (
  fs: FileSystem.FileSystem,
  destination: string,
  options?: FileSystemWriteOptions
): Sink.Sink<TransferReport, Entry, never, TransferError | Vfs.FsError | PlatformError> =>
  Sink.unwrap(Effect.gen(function*() {
    const existing = options?.existing ?? "reject"
    const times = options?.times ?? "mtime"
    const escaping = options?.escaping ?? "reject"
    const unsupported = options?.unsupported ?? "fail"
    const modeMask = options?.specialBits ? MODE_BITS : PERMISSION_BITS
    const written = new Map<string, string>()
    const directories = new Set<string>()
    const skippedDirectories = new Map<string, SkipReason>()
    const links = new Map<string, string>()
    const deferredLinks: Array<DeferredLink> = []
    const createdDirectories: Array<CreatedDirectory> = []
    const skipped: Array<SkippedEntry> = []
    const canonicalRoot = yield* canonicalDestination(fs, destination)
    let started = false
    let claimed = false
    let completed = false
    let entries = 0
    let files = 0
    let bytes = 0n
    let hardLinksDegraded = 0

    // Only a root this sink claimed exclusively is removed; overwrite never deletes existing data.
    yield* Effect.addFinalizer(() =>
      completed || !claimed ? Effect.void : fs.remove(destination, { recursive: true }).pipe(Effect.orDie)
    )

    const refuse = (path: Vfs.PathInput, reason: SkipReason) => {
      if (unsupported === "fail") return Effect.fail(new TransferError({ code: reason, path }))
      skipped.push({ path, reason })

      return Effect.void
    }

    // Inside a claimed root every name is new, so an existing name means the host folded two names together.
    const collision = (path: string) => (error: PlatformError): Effect.Effect<boolean, TransferError | PlatformError> =>
      existing === "reject" && path !== "/" && isReason("AlreadyExists")(error)
        ? refuse(path, "NameCollision").pipe(Effect.as(false))
        : Effect.fail(error)

    const conflict = (path: string) => new TransferError({ code: "DestinationConflict", path })

    // Classifies an existing destination name without following it: absent, a link, or a real entry.
    const probe = Effect.fnUntraced(function*(path: string, host: string) {
      const resolved = yield* Effect.result(fs.realPath(host))

      if (Result.isFailure(resolved)) {
        if (!isReason("NotFound")(resolved.failure)) return yield* resolved.failure
        const link = yield* Effect.result(fs.readLink(host))

        return Result.isSuccess(link) ? "link" : "absent"
      }

      return resolved.success === hostPath(canonicalRoot, path) ? "entry" : "link"
    })

    const clearForReplacement = Effect.fnUntraced(function*(path: string, host: string) {
      if (existing === "reject") return
      const current = yield* probe(path, host)

      if (current === "absent") return

      if (current === "entry" && (yield* fs.stat(host)).type === "Directory") return yield* conflict(path)

      yield* fs.remove(host)
    })

    const hostDate = (path: string, value: bigint) =>
      Option.match(DateTime.make(Number(value / NANOSECONDS_PER_MILLISECOND)), {
        onNone: () => Effect.fail(new TransferError({ code: "InvalidEntry", field: "times", path })),
        onSome: (date) => Effect.succeed(DateTime.toDateUtc(date))
      })

    const applyTimes = Effect.fnUntraced(function*(path: string, host: string, metadata: EntryMetadata | undefined) {
      if (times === "none" || metadata?.mtimeNs === undefined) return
      const modification = yield* hostDate(path, metadata.mtimeNs)

      const access = times === "all" && metadata.atimeNs !== undefined
        ? yield* hostDate(path, metadata.atimeNs)
        : DateTime.toDateUtc(yield* DateTime.now)

      yield* fs.utimes(host, access, modification)
    })

    const modeOf = (metadata: EntryMetadata | undefined, fallback: number) => (metadata?.mode ?? fallback) & modeMask

    const makeDirectory = Effect.fnUntraced(function*(path: string, host: string, mode: number) {
      const made = yield* Effect.result(fs.makeDirectory(host, { mode: mode | OWNER_ACCESS }))

      if (Result.isSuccess(made)) return "created" as const

      if (!isReason("AlreadyExists")(made.failure)) return yield* made.failure

      if (path === "/" && existing === "reject") return yield* made.failure

      if (existing === "reject") return (yield* refuse(path, "NameCollision").pipe(Effect.as("skipped" as const)))

      if ((yield* probe(path, host)) !== "entry" || (yield* fs.stat(host)).type !== "Directory") {
        return yield* conflict(path)
      }

      return "merged" as const
    })

    const writeEntry = Effect.fnUntraced(function*(entry: Entry, path: string, host: string) {
      switch (entry.kind) {
        case "directory": {
          const mode = modeOf(entry.metadata, DEFAULT_DIRECTORY_MODE)
          const outcome = yield* makeDirectory(path, host, mode)

          if (outcome === "skipped") {
            skippedDirectories.set(path, "NameCollision")

            return
          }

          if (path === "/" && outcome === "created") claimed = existing === "reject"

          directories.add(path)
          createdDirectories.push({
            path,
            host,
            mode: outcome === "created" ? mode : undefined,
            metadata: entry.metadata
          })

          return
        }

        case "file": {
          const mode = modeOf(entry.metadata, DEFAULT_FILE_MODE)

          yield* clearForReplacement(path, host)

          const wrote = yield* fs.writeFile(host, entry.bytes, { flag: existing === "reject" ? "wx" : "w", mode }).pipe(
            Effect.as(true),
            Effect.catchIf(isReason("AlreadyExists"), collision(path))
          )

          if (!wrote) return

          if (path === "/") claimed = existing === "reject"
          // The create mode passes through the host umask and does not apply to an existing file.
          yield* fs.chmod(host, mode)
          yield* applyTimes(path, host, entry.metadata)
          files++
          bytes += BigInt(entry.bytes.length)
          written.set(path, host)

          return
        }

        case "symlink": {
          const target = Predicate.isString(entry.target) ? entry.target : undefined

          if (target === undefined) return yield* refuse(entry.path, "UnrepresentableName")

          // Links are created after every entry is known, so escape checks can resolve through links that come later.
          links.set(path, target)
          deferredLinks.push({ path, host, target })

          return
        }

        case "hardLink": {
          const source = Predicate.isString(entry.target) ? entry.target : undefined

          if (source === undefined) return yield* refuse(entry.path, "UnrepresentableName")
          const linkTarget = links.get(source)

          if (linkTarget !== undefined) {
            // Effect's FileSystem cannot hard-link a symbolic link portably, so this alias becomes another link.
            hardLinksDegraded++
            links.set(path, linkTarget)
            deferredLinks.push({ path, host, target: linkTarget })

            return
          }

          const sourceHost = written.get(source)

          if (sourceHost === undefined) {
            return yield* new TransferError({ code: "InvalidEntry", field: "target", path: entry.path })
          }

          yield* clearForReplacement(path, host)

          const linked = yield* fs.link(sourceHost, host).pipe(
            Effect.as(true),
            Effect.catchIf(isReason("AlreadyExists"), collision(path)),
            Effect.catch(() =>
              fs.copyFile(sourceHost, host).pipe(
                Effect.tap(() => Effect.sync(() => hardLinksDegraded++)),
                Effect.as(true)
              )
            )
          )

          if (linked) written.set(path, host)

          return
        }
      }
    })

    const write = Effect.fnUntraced(function*(entry: Entry) {
      entries++
      const root = yield* isRootPath(entry.path)

      if (root ? started : !started) {
        return yield* new TransferError({ code: "InvalidEntry", field: "root", path: entry.path })
      }

      started = true

      if (!Predicate.isString(entry.path)) return yield* refuse(entry.path, "UnrepresentableName")
      const path = entry.path
      const slash = path.lastIndexOf("/")
      const parent = root ? undefined : slash === 0 ? "/" : path.slice(0, slash)
      const skippedParent = parent === undefined ? undefined : skippedDirectories.get(parent)

      if (skippedParent !== undefined) {
        if (entry.kind === "directory") skippedDirectories.set(path, skippedParent)
        skipped.push({ path, reason: skippedParent })

        return
      }

      if (parent !== undefined && !directories.has(parent)) {
        return yield* new TransferError({ code: "InvalidEntry", field: "parent", path })
      }

      return yield* writeEntry(entry, path, hostPath(destination, path))
    })

    const finish = Effect.gen(function*() {
      if (escaping === "reject") {
        for (const link of deferredLinks) {
          if (escapes(link.path, link.target, links)) {
            return yield* new TransferError({ code: "EscapingSymlink", path: link.path })
          }
        }
      }

      for (const link of deferredLinks) {
        yield* clearForReplacement(link.path, link.host)

        const made = yield* fs.symlink(link.target, link.host).pipe(
          Effect.as(true),
          Effect.catchIf(isReason("AlreadyExists"), collision(link.path))
        )

        if (made && link.path === "/") claimed = existing === "reject"
      }

      // Reverse creation order visits children before parents, so later writes cannot disturb applied times or modes.
      for (const directory of createdDirectories.reverse()) {
        if (directory.mode !== undefined) yield* fs.chmod(directory.host, directory.mode)
        yield* applyTimes(directory.path, directory.host, directory.metadata)
      }

      completed = true

      return { entries, files, bytes: ByteSize.bytes(bytes), skipped, hardLinksDegraded } satisfies TransferReport
    })

    return Sink.forEach(write).pipe(Sink.mapEffect(() => finish))
  }))
