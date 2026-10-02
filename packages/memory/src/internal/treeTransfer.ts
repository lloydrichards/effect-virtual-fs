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
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Scope from "effect/Scope"
import type * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import { at } from "./adapterSupport.js"
import {
  childPath,
  DEFAULT_DIRECTORY_MODE,
  DEFAULT_FILE_MODE,
  emitPath,
  type Entry,
  type EntryMetadata,
  isRootPath,
  type Location,
  makeBudget,
  makeLimits,
  MODE_BITS,
  OWNER_ACCESS,
  pathKey,
  PERMISSION_BITS,
  placement,
  type ReadOptions,
  resolveLimits,
  sink,
  toPathInput,
  TransferError,
  type TransferReport,
  type TreeTransferLimits,
  type VolumeTransferOptions,
  walk,
  type WalkNode,
  type WriteOptions
} from "./treeTransferEngine.js"

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

const encoder = new TextEncoder()

const entryMetadata = (metadata: Vfs.Metadata): EntryMetadata => ({
  uid: metadata.uid,
  gid: metadata.gid,
  mode: metadata.mode,
  atimeNs: metadata.atimeNs,
  mtimeNs: metadata.mtimeNs,
  ctimeNs: metadata.ctimeNs,
  birthtimeNs: metadata.birthtimeNs
})

/** @internal */
export const fromCaller = (
  caller: Vfs.Caller,
  root: Vfs.PathInput,
  options?: ReadOptions
): Stream.Stream<Entry, TransferError | Vfs.VfsError> =>
  Stream.unwrap(Effect.gen(function*() {
    const limits = yield* resolveLimits(options?.limits)
    const location = Predicate.isString(root) ? root : yield* BytePath.toBytes(root)

    return walk<string | Uint8Array, Vfs.PathTarget, TransferError | Vfs.VfsError>(
      location,
      limits,
      Effect.fnUntraced(function*(location, target) {
        return (yield* caller.readDirectory(target)).value.map((child) => ({
          name: child.name,
          location: childPath(location, child.name)
        }))
      }),
      Effect.fnUntraced(
        function*(
          next,
          budget
        ): Effect.fn.Return<WalkNode<Vfs.PathTarget, TransferError | Vfs.VfsError>, TransferError | Vfs.VfsError> {
          const path = yield* emitPath(next.path)
          const target = at(yield* emitPath(next.location), { followFinalSymlink: false })
          // Capture metadata before content reads change the source access time.
          const metadata = yield* caller.stat(target)

          if (metadata.kind === "directory") {
            return {
              kind: "directory",
              entry: { kind: "directory", path, metadata: entryMetadata(metadata) },
              node: target
            }
          }

          return {
            kind: "content",
            identity: metadata.nlink > 1 ? metadata.ino : undefined,
            read: Effect.gen(function*() {
              if (metadata.kind === "file") {
                yield* budget.fileSize(path, metadata.size)
                const contents = yield* caller.readFile(target)
                yield* budget.fileSize(path, contents.length)
                yield* budget.stored(path, contents.length)

                return { kind: "file", path, bytes: contents, metadata: entryMetadata(metadata) } as const
              }

              const link = yield* caller.readLink(target)
              yield* budget.stored(path, link.length)

              return {
                kind: "symlink",
                path,
                target: yield* toPathInput(link),
                metadata: entryMetadata(metadata)
              } as const
            })
          }
        }
      ),
      emitPath
    )
  }))

// A path's byte length and its depth below the transfer root, which is "/" at depth 0.
const pathSize = Effect.fnUntraced(function*(path: Vfs.PathInput) {
  const bytes = Predicate.isString(path) ? encoder.encode(path) : yield* Vfs.pathToBytes(path)
  const depth = bytes.length === 1 ? 0 : bytes.reduce((count, byte) => (byte === SLASH ? count + 1 : count), 0)

  return { bytes: bytes.length, depth }
})

const payloadBytes = (target: Vfs.PathInput) =>
  Predicate.isString(target)
    ? Effect.succeed(encoder.encode(target).length)
    : Effect.map(Vfs.pathToBytes(target), (bytes) => bytes.length)

// Walks the snapshot's own value, so nothing is restored and no caller reads it. The walk already holds every
// listing and file, so the budget is charged entry by entry as each is emitted: a listing past `maxEntries` fails
// at the entry that overflows, after the entries before it.
/** @internal */
export const fromSnapshot = (snapshot: Vfs.Snapshot, root: Vfs.PathInput, options?: ReadOptions) =>
  Stream.unwrap(Effect.gen(function*() {
    const budget = makeBudget(yield* resolveLimits(options?.limits))

    const checked = Effect.fnUntraced(function*(entry: Entry) {
      const size = yield* pathSize(entry.path)
      yield* budget.entry(entry.path, size.bytes, size.depth)

      if (entry.kind === "file") {
        yield* budget.fileSize(entry.path, entry.bytes.length)
        yield* budget.stored(entry.path, entry.bytes.length)
      } else if (entry.kind === "symlink") yield* budget.stored(entry.path, yield* payloadBytes(entry.target))

      return entry
    })

    return Stream.mapEffect(Vfs.snapshotEntries(snapshot, root), checked)
  }))

const targetOf = (written: Written, options?: { readonly followFinalSymlink?: boolean }) =>
  at(written.name, { relativeTo: written.base, ...options })

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
  if ((yield* caller.stat(at(path, { followFinalSymlink: false }))).kind !== "directory") {
    return yield* caller.unlink(path)
  }

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

        const directory =
          (yield* caller.stat(at(name, { relativeTo: base, followFinalSymlink: false }))).kind === "directory"

        visited.push({ base, name, directory })

        if (directory) {
          yield* caller.chmod(at(name, { relativeTo: base }), OWNER_ACCESS)
          pending.push(yield* caller.openDirectory(at(name, { relativeTo: base })))
        }
      }
    }

    // Children follow their parents in `visited`, so removing in reverse empties each directory first.
    for (const entry of visited.reverse()) {
      yield* entry.directory
        ? caller.rmdir(at(entry.name, { relativeTo: entry.base }))
        : caller.unlink(at(entry.name, { relativeTo: entry.base }))
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
  sink<CreatedDirectory, bigint, TransferError | Vfs.VfsError>(
    "caller",
    options,
    Effect.fnUntraced(function*(state) {
      // Keep directory handles alive until engine cleanup completes.
      const handles = yield* Scope.make()
      const { existing, times, directories, modeOf } = state
      const create = existing === "reject" ? "exclusive" : "ifMissing"
      const bases = new Map<string, Vfs.DirectoryHandle>()
      const written = new Map<string, Written>()

      const claim = state.claim(
        Effect.map(caller.stat(at(destination, { followFinalSymlink: false })), (metadata) => metadata.ino)
      )

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
        const current = yield* Effect.result(caller.stat(at(name, { relativeTo: base, followFinalSymlink: false })))

        if (Result.isFailure(current)) {
          return current.failure.code === "NotFound" ? undefined : yield* current.failure
        }

        if (current.success.kind === "directory") {
          return yield* new Vfs.VfsError({ code: "IsDirectory", operation: "treeTransfer" })
        }

        return yield* caller.unlink(at(name, { relativeTo: base }))
      })

      const makeDirectory = Effect.fnUntraced(
        function*(name: Vfs.PathInput, base: Vfs.DirectoryHandle | undefined, mode: number) {
          // Owner access stays open until every child is written; the exact mode is applied afterwards.
          const made = yield* Effect.result(caller.mkdir(at(name, { relativeTo: base }), { mode: mode | OWNER_ACCESS }))

          if (Result.isSuccess(made)) return true

          if (existing === "reject" || made.failure.code !== "AlreadyExists") return yield* made.failure

          if ((yield* caller.stat(at(name, { relativeTo: base, followFinalSymlink: false }))).kind !== "directory") {
            return yield* new Vfs.VfsError({ code: "NotDirectory", operation: "treeTransfer" })
          }

          return false
        }
      )

      const write = Effect.fnUntraced(function*(entry: Entry, location: Location) {
        const base = location.parent === undefined ? undefined : bases.get(location.parent)

        if (location.parent !== undefined && base === undefined) {
          return yield* new TransferError({ code: "InvalidEntry", field: "parent", path: entry.path })
        }

        const name = base === undefined ? destination : location.name

        switch (entry.kind) {
          case "directory": {
            const mode = modeOf(entry.metadata, DEFAULT_DIRECTORY_MODE)
            const created = yield* makeDirectory(name, base, mode)

            if (base === undefined && created) yield* claim
            bases.set(location.key, yield* Scope.provide(caller.openDirectory(at(name, { relativeTo: base })), handles))
            directories.push({ base, name, mode: created ? mode : undefined, metadata: entry.metadata })

            return
          }

          case "file": {
            const mode = modeOf(entry.metadata, DEFAULT_FILE_MODE)

            yield* caller.writeFile(at(name, { relativeTo: base }), entry.bytes, {
              access: "write",
              create,
              truncate: true,
              mode,
              finalMode: mode,
              replaceFinalSymlink: true
            })
            state.file(entry.bytes.length)
            break
          }

          case "symlink": {
            if (existing === "overwrite") yield* clearExisting(name, base)

            yield* caller.symlink(entry.target, at(name, { relativeTo: base }))
            break
          }

          case "hardLink": {
            const source = written.get(yield* pathKey(entry.target))

            // Only entries below the root can be link sources or targets, so both sides have a parent handle.
            if (base === undefined || source?.base === undefined) {
              return yield* new TransferError({ code: "InvalidEntry", field: "target", path: entry.path })
            }

            if (existing === "overwrite") yield* clearExisting(name, base)

            yield* caller.link(at(source.name, { relativeTo: source.base }), at(name, { relativeTo: base }))
            written.set(location.key, { base, name })

            return
          }
        }

        if (base === undefined) yield* claim
        written.set(location.key, { base, name })
        yield* applyTimes(at(name, { relativeTo: base, followFinalSymlink: false }), entry.metadata)
      })

      return {
        write,
        removeClaimed: Effect.fnUntraced(function*(ino: bigint) {
          const current = yield* Effect.result(caller.stat(at(destination, { followFinalSymlink: false })))

          if (Result.isSuccess(current) && current.success.ino === ino) yield* removeTree(caller, destination)
        }),
        restoreMode: (directory) =>
          directory.mode === undefined ? Effect.void : caller.chmod(targetOf(directory), directory.mode),
        finishDirectory: Effect.fnUntraced(function*(directory) {
          // Avoid a redundant change event when the mode is already exact.
          if (
            directory.mode !== undefined &&
            (yield* caller.stat(targetOf(directory, { followFinalSymlink: false }))).mode !== directory.mode
          ) {
            yield* caller.chmod(targetOf(directory), directory.mode)
          }

          yield* applyTimes(targetOf(directory), directory.metadata)
        }),
        close: (exit) => Scope.close(handles, exit)
      }
    })
  )

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

  const positions = placement("volume")
  const rootLocation = yield* positions.start(root)

  if (rootLocation !== undefined) {
    yield* positions.check(root, rootLocation)
    positions.remember(root, rootLocation)
  }

  for (const entry of rest) {
    const location = yield* positions.start(entry)

    if (location === undefined) {
      return yield* new TransferError({ code: "InvalidEntry", field: "path", path: entry.path })
    }

    yield* positions.check(entry, location)
    positions.remember(entry, location)
  }

  yield* positions.finish

  const rootMetadata = volumeMetadata(root.metadata, options)
  const fixtureEntries = rest.map((entry) => withVolumeMetadata(entry, options))

  return yield* Vfs.fromFixture(
    rootMetadata === undefined ? { entries: fixtureEntries } : { rootMetadata, entries: fixtureEntries },
    options?.volume
  )
})
