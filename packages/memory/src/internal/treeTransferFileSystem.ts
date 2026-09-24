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

    // Returns the link target, `undefined` for a real entry, or `null` when the name can be neither resolved nor read.
    const readLinkTarget = Effect.fnUntraced(function*(next: Pending) {
      if (next.canonical === undefined) {
        const target = yield* Effect.result(fs.readLink(next.host))

        return Result.isSuccess(target) ? target.success : undefined
      }

      const resolved = yield* Effect.result(fs.realPath(next.host))

      if (Result.isSuccess(resolved) && resolved.success === next.canonical) return undefined

      // A different resolved path, a missing one, or a loop means this name is probably a link.
      const target = yield* Effect.result(fs.readLink(next.host))

      if (Result.isSuccess(target)) return target.success

      return Result.isFailure(resolved) ? null : yield* target.failure
    })

    const visit = Effect.fnUntraced(function*(next: Pending) {
      entries++

      if (entries > limits.maxEntries) return yield* limitExceeded("maxEntries", next.path)

      if (next.depth > limits.maxDepth) return yield* limitExceeded("maxDepth", next.path)

      if (exceeds(next.pathBytes, limits.maxPathBytes)) return yield* limitExceeded("maxPathBytes", next.path)

      // Effect's FileSystem decodes host names as UTF-8, so a replacement character marks a name it could not carry.
      if (next.name.includes(REPLACEMENT_CHARACTER)) return yield* refuse(next.path, "UnrepresentableName")
      const target = yield* readLinkTarget(next)

      if (target === null) return yield* refuse(next.path, "UnsupportedEntryType")

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

        // A listing is held in memory until visited, so a single huge directory must fit the entry budget up front.
        if (entries + pending.length > limits.maxEntries) return yield* limitExceeded("maxEntries", next.path)

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

// Hosts may fold case and Unicode form, so link lookups during escape checks use a folded key. Folding can only
// find more links than exist, which makes the check stricter, never looser.
const foldName = (path: string) => path.normalize("NFC").toLowerCase()

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
    const next = links.get(foldName(`/${stack.join("/")}`))

    if (next === undefined) continue
    hops++

    if (hops > MAX_SYMLINK_HOPS || next.startsWith("/")) return true
    stack.pop()
    queue.unshift(...next.split("/"))
  }

  return false
}

const parentOf = (path: string) => path.split("/").filter((part) => part.length > 0).slice(0, -1)

// Rewrites a relative link target so a copy of the link placed at `aliasPath` resolves where the original did.
// A target that climbs above the transfer root is kept as written; the escape check then rejects it.
const retarget = (linkPath: string, aliasPath: string, target: string) => {
  if (target.startsWith("/")) return target
  const resolved = parentOf(linkPath)

  for (const component of target.split("/")) {
    if (component === "" || component === ".") continue

    if (component === "..") {
      if (resolved.length === 0) return target
      resolved.pop()
    } else {
      resolved.push(component)
    }
  }

  const from = parentOf(aliasPath)
  let shared = 0

  while (shared < from.length && shared < resolved.length && from[shared] === resolved[shared]) shared++

  return [...from.slice(shared).map(() => ".."), ...resolved.slice(shared)].join("/") || "."
}

const isInside = (root: string, path: string) => root === "/" || path === root || path.startsWith(`${root}/`)

// A hard link may fall back to a copy only when the host cannot link; name and lookup failures stay failures.
const cannotLink = (error: PlatformError | TransferError): error is PlatformError =>
  !(error instanceof TransferError) && !isReason("AlreadyExists")(error) && !isReason("NotFound")(error)

interface DeferredLink {
  readonly path: string
  readonly host: string
  readonly target: string
}

interface WrittenFile {
  readonly host: string
  readonly metadata: EntryMetadata | undefined
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
    const written = new Map<string, WrittenFile>()
    const directories = new Set<string>()
    const skippedDirectories = new Map<string, SkipReason>()
    const links = new Map<string, string>()
    const deferredLinks: Array<DeferredLink> = []
    const createdDirectories: Array<CreatedDirectory> = []
    const skipped: Array<SkippedEntry> = []
    let canonicalRoot = destination
    let claimed: { readonly dev: number; readonly ino: number | undefined } | undefined
    let started = false
    let completed = false
    let entries = 0
    let files = 0
    let bytes = 0n
    let hardLinksDegraded = 0

    // A failed overwrite keeps what it wrote, but its new directories get their final modes back.
    const restoreModes = Effect.forEach(
      createdDirectories,
      (directory) =>
        directory.mode === undefined ? Effect.void : fs.chmod(directory.host, directory.mode).pipe(Effect.ignore),
      {
        discard: true
      }
    )

    // Only a root this sink claimed exclusively is removed, and only while it is still the same object. Owner
    // access is restored first, because finished directories may carry restrictive modes.
    const removeClaimed = Effect.gen(function*() {
      if (Result.isSuccess(yield* Effect.result(fs.readLink(destination)))) return
      const current = yield* Effect.result(fs.stat(destination))

      if (Result.isFailure(current) || current.success.dev !== claimed?.dev) return

      if (claimed.ino !== undefined && Option.getOrUndefined(current.success.ino) !== claimed.ino) return

      yield* Effect.forEach(
        createdDirectories,
        (directory) => fs.chmod(directory.host, OWNER_ACCESS).pipe(Effect.ignore),
        { discard: true }
      )
      yield* fs.remove(destination, { recursive: true })
    })

    yield* Effect.addFinalizer(() =>
      completed ? Effect.void : (claimed === undefined ? restoreModes : removeClaimed).pipe(Effect.orDie)
    )

    const claim = Effect.gen(function*() {
      if (existing !== "reject") return
      const info = yield* fs.stat(destination)
      claimed = { dev: info.dev, ino: Option.getOrUndefined(info.ino) }
    })

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
      if (Result.isSuccess(yield* Effect.result(fs.readLink(host)))) return "link" as const

      if (path === "/") return (yield* fs.exists(host)) ? "entry" as const : "absent" as const
      const resolved = yield* Effect.result(fs.realPath(host))

      if (Result.isFailure(resolved)) {
        if (isReason("NotFound")(resolved.failure)) return "absent" as const

        return yield* resolved.failure
      }

      return resolved.success === hostPath(canonicalRoot, path) ? "entry" as const : "link" as const
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

    // Writes a new file with an exclusive create, which never follows a link placed at the name. The mode and
    // times that follow still resolve the name, so a link swapped in after creation remains a documented gap.
    const createFile = Effect.fnUntraced(
      function*(path: string, host: string, contents: Uint8Array, metadata: EntryMetadata | undefined) {
        const mode = modeOf(metadata, DEFAULT_FILE_MODE)

        const wrote = yield* fs.writeFile(host, contents, { flag: "wx", mode }).pipe(
          Effect.as(true),
          Effect.catchIf(isReason("AlreadyExists"), collision(path))
        )

        if (!wrote) return false

        // The create mode passes through the host umask.
        yield* fs.chmod(host, mode)
        yield* applyTimes(path, host, metadata)
        written.set(path, { host, metadata })

        return true
      }
    )

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

          if (path === "/") {
            if (outcome === "created") yield* claim
            canonicalRoot = yield* fs.realPath(host)
          }

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
          yield* clearForReplacement(path, host)

          if (!(yield* createFile(path, host, entry.bytes, entry.metadata))) return

          if (path === "/") yield* claim
          files++
          bytes += BigInt(entry.bytes.length)

          return
        }

        case "symlink": {
          const target = Predicate.isString(entry.target) ? entry.target : undefined

          if (target === undefined) return yield* refuse(entry.path, "UnrepresentableName")

          // Links are created after every entry is known, so escape checks can resolve through links that come later.
          links.set(foldName(path), target)
          deferredLinks.push({ path, host, target })

          return
        }

        case "hardLink": {
          const source = Predicate.isString(entry.target) ? entry.target : undefined

          if (source === undefined) return yield* refuse(entry.path, "UnrepresentableName")
          const original = deferredLinks.find((link) => link.path === source)

          if (original !== undefined) {
            // Effect's FileSystem cannot hard-link a symbolic link portably, so this alias becomes another link.
            const target = retarget(source, path, original.target)
            hardLinksDegraded++
            links.set(foldName(path), target)
            deferredLinks.push({ path, host, target })

            return
          }

          const sourceFile = written.get(source)

          if (sourceFile === undefined) {
            return yield* new TransferError({ code: "InvalidEntry", field: "target", path: entry.path })
          }

          yield* clearForReplacement(path, host)

          const copyInstead = fs.readFile(sourceFile.host).pipe(
            Effect.flatMap((contents) => createFile(path, host, contents, sourceFile.metadata)),
            Effect.tap((copied) => Effect.sync(() => copied && hardLinksDegraded++))
          )

          const linked = yield* fs.link(sourceFile.host, host).pipe(
            Effect.as(true),
            Effect.catchIf(isReason("AlreadyExists"), collision(path)),
            Effect.catchIf(cannotLink, () => copyInstead)
          )

          if (linked) written.set(path, sourceFile)

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

    // Checks a created link against the host itself, which catches folded names and links that were already in
    // the destination. A dangling link is checked through its deepest existing ancestor.
    const staysInside = Effect.fnUntraced(function*(link: DeferredLink) {
      const resolved = yield* Effect.result(fs.realPath(link.host))

      if (Result.isSuccess(resolved)) return isInside(canonicalRoot, resolved.success)

      if (!isReason("NotFound")(resolved.failure)) return false
      const base = yield* fs.realPath(link.host.slice(0, link.host.lastIndexOf("/")) || "/")
      const components = link.target.split("/")

      for (let length = components.length; length >= 0; length--) {
        const prefix = [base, ...components.slice(0, length)].join("/")
        const ancestor = yield* Effect.result(fs.realPath(prefix))

        if (Result.isSuccess(ancestor)) {
          return isInside(canonicalRoot, ancestor.success) && !components.slice(length).includes("..")
        }
      }

      return false
    })

    const finish = Effect.gen(function*() {
      if (!started) return yield* new TransferError({ code: "InvalidEntry", field: "root" })

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

        if (made && link.path === "/") yield* claim

        if (made && escaping === "reject" && !(yield* staysInside(link))) {
          yield* fs.remove(link.host)

          return yield* new TransferError({ code: "EscapingSymlink", path: link.path })
        }
      }

      // Reverse creation order visits children before parents, so later writes cannot disturb applied times or modes.
      for (const directory of [...createdDirectories].reverse()) {
        if (directory.mode !== undefined) yield* fs.chmod(directory.host, directory.mode)
        yield* applyTimes(directory.path, directory.host, directory.metadata)
      }

      completed = true

      return { entries, files, bytes: ByteSize.bytes(bytes), skipped, hardLinksDegraded } satisfies TransferReport
    })

    // Uninterruptible, so a transfer is never abandoned halfway through creating links or applying final modes.
    return Sink.forEach(write).pipe(Sink.mapEffect(() => Effect.uninterruptible(finish)))
  }))
