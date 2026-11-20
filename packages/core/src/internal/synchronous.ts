// The existing core native boundary borrows the preview's checked synchronous region.
import { BytePath, type VirtualFileSystem as Vfs } from "@effect-vfs/effect-preview"
import { unixNanoFromNanoseconds as nano } from "@effect-vfs/effect-preview/DateTime"
import { Clock, Context, Effect, Exit, Predicate, Result, Scheduler, Scope } from "effect"
import type { MkdirOptions, OpenOptions, RootCallerOptions } from "../Caller.js"
import { DirectoryHandleId, FileHandleId } from "../FileHandle.js"
import type { OwnerUpdate, Times } from "../Metadata.js"
import type { Binding, Handle } from "../SynchronousAdapter.js"
import { Target as CoreTarget } from "../Target.js"
import type { FsFailure, ObjectReference, TargetInput } from "../VirtualFileSystem.js"
import { Errors, Paths } from "./model.js"
import {
  attributeHandle,
  attributeTimes,
  creationMode,
  direntReference,
  drainPending,
  failure,
  growsFile,
  growthWritePrefix,
  invalidateSnapshot,
  metadata,
  type runtimeOf,
  target
} from "./runtime.js"

type Runtime = NonNullable<ReturnType<typeof runtimeOf>>

type Target = TargetInput

const isPath = (target: Target): target is Extract<ReturnType<typeof CoreTarget.of>, { _tag: "Path" }> =>
  !Predicate.isString(target) && "_tag" in target && Predicate.isTagged(target, "Path")

const unwrap = <A>(result: Result.Result<A, Vfs.VirtualFileSystemError>): A => {
  if (Result.isFailure(result)) throw failure(result.failure)

  return result.success
}

const run = <A>(runtime: Runtime, operation: string, action: () => A): A => {
  if (runtime.busy) throw Errors.fsFailure("VolumeBusy", operation)
  runtime.busy = true
  runtime.time.active = true
  runtime.time.value = undefined
  invalidateSnapshot(runtime, operation)

  try {
    return action()
  } catch (cause) {
    if (Predicate.isTagged(cause, "InvalidClockSample")) {
      throw Errors.argumentFailure(operation, "clock.currentTimeNanos")
    }

    throw cause
  } finally {
    runtime.busy = false
    runtime.time.active = false
    runtime.time.value = undefined

    if (runtime.pending.length > 0) {
      Effect.runSync(drainPending(runtime).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true)))
    }
  }
}

const guardHandle = (runtime: Runtime, handle: Handle): Handle => ({
  get closed() {
    return handle.closed
  },
  directory: handle.directory,
  stat: () => run(runtime, "stat", handle.stat),
  read: (n, position) => run(runtime, "read", () => handle.read(n, position)),
  write: (bytes, position, append) => run(runtime, "write", () => handle.write(bytes, position, append)),
  truncate: (length) => run(runtime, "truncate", () => handle.truncate(length)),
  chmod: (mode) => run(runtime, "chmod", () => handle.chmod(mode)),
  chown: (owner) => run(runtime, "chown", () => handle.chown(owner)),
  utimes: (times) => run(runtime, "utimes", () => handle.utimes(times)),
  sync: () => run(runtime, "sync", handle.sync),
  close: () => run(runtime, "close", handle.close)
})

export const bind = Effect.fnUntraced(
  function*(runtime: Runtime, options?: RootCallerOptions): Effect.fn.Return<Binding, FsFailure, Scope.Scope> {
    const parent = yield* Effect.scope
    const owned = yield* Scope.make()
    let closed = false
    yield* Scope.addFinalizer(
      parent,
      Effect.suspend(() => {
        closed = true
        const release = Scope.close(owned, Exit.void)

        if (runtime.busy) {
          runtime.pending.push(release)

          return Effect.void
        }

        return release
      })
    )

    if (closed) return yield* Effect.interrupt

    const caller = yield* runtime.owner.authorize({
      credentials: options?.identity === undefined
        ? { uid: 0, gid: 0, privileged: true }
        : {
          uid: options.identity.uid,
          gid: options.identity.gid,
          privileged: options.identity.privileged,
          supplementaryGroups: options.identity.groups
        },
      umask: options?.umask ?? 0o022
    }).pipe(Scope.provide(owned), Effect.mapError(failure), Effect.onError(() => Scope.close(owned, Exit.void)))

    const sync = yield* caller.acquireSync.pipe(
      Scope.provide(owned),
      Effect.mapError(failure),
      Effect.onError(() => Scope.close(owned, Exit.void))
    )

    const exactCaller = yield* runtime.owner.authorize({
      credentials: options?.identity === undefined
        ? { uid: 0, gid: 0, privileged: true }
        : {
          uid: options.identity.uid,
          gid: options.identity.gid,
          privileged: options.identity.privileged,
          supplementaryGroups: options.identity.groups
        },
      umask: 0
    }).pipe(Scope.provide(owned), Effect.mapError(failure), Effect.onError(() => Scope.close(owned, Exit.void)))

    const exactSync = yield* exactCaller.acquireSync.pipe(
      Scope.provide(owned),
      Effect.mapError(failure),
      Effect.onError(() => Scope.close(owned, Exit.void))
    )

    const resolveReference = (value: ObjectReference) => {
      const r = runtime.compatibility.references.get(value)

      if (r === undefined) throw Errors.fsFailure("ForeignReference", "bind")

      return r.reference
    }

    const checked = (input: string) => {
      const value = Paths.preparePath(input, "path", runtime.owner.limits.expandedPathBytes)

      if (Result.isFailure(value)) throw value.failure

      return input
    }

    const resolve = (value: Target): Vfs.Target => {
      const chosen = CoreTarget.of(value)

      if (Predicate.isTagged(chosen, "Reference")) return resolveReference(chosen.reference)

      if (Predicate.isTagged(chosen, "Handle")) {
        const original = FileHandleId in chosen.handle
          ? runtime.files.get(chosen.handle)
          : DirectoryHandleId in chosen.handle
          ? runtime.directories.get(chosen.handle)
          : undefined

        if (original === undefined) throw Errors.fsFailure("InvalidHandle", "target")

        const view = "readAlloc" in original
          ? Effect.runSync(original.sync().pipe(Effect.mapError(failure)))
          : Effect.runSync(original.sync().pipe(Effect.mapError(failure)))

        return unwrap<Vfs.ObjectObservation>(view.stat()).reference
      }

      const prepared = Paths.preparePath(chosen.path, "path", runtime.owner.limits.expandedPathBytes)

      if (Result.isFailure(prepared)) throw prepared.failure

      const name = Predicate.isString(chosen.path)
        ? chosen.path
        : Result.getOrThrow(BytePath.fromBytes(Effect.runSync(Paths.pathToBytes(chosen.path))))

      if (chosen.relativeTo === undefined) return name
      const directory = runtime.directories.get(chosen.relativeTo)

      if (directory === undefined) throw Errors.fsFailure("InvalidHandle", "target")

      return { directory, name }
    }

    const resolveEntry = (value: Target): Vfs.EntryTarget => {
      const t = resolve(value)

      if (Predicate.isString(t) || BytePath.isBytePath(t) || "directory" in t) return t
      throw Errors.fsFailure("InvalidArgument", "entry")
    }

    const stat = (t: Target) => {
      if (Predicate.isString(t)) {
        const valid = Paths.validatePath(t, "path", runtime.owner.limits.expandedPathBytes)

        if (Result.isFailure(valid)) throw valid.failure

        return metadata(runtime, unwrap(sync.stat(t)))
      }

      return metadata(
        runtime,
        unwrap(isPath(t) && t.followFinalSymlink === false ? sync.linkStat(resolveEntry(t)) : sync.stat(resolve(t)))
      )
    }

    const attributes = (t: Target, a: Vfs.Attributes) => {
      const selected = CoreTarget.of(t)

      if (Predicate.isTagged(selected, "Handle")) {
        const handle = attributeHandle(runtime, t)
        const grant = runtime.grants.get(selected.handle)

        if (handle !== undefined && grant?.allowed && grant.boundaries.length === 1) {
          return unwrap(sync.setHandleAttributes(handle, a))
        }

        const resolved = Effect.runSync(
          Effect.result(target(runtime, t)).pipe(
            Effect.provideService(Scheduler.PreventSchedulerYield, true)
          )
        )

        if (Result.isFailure(resolved)) throw resolved.failure

        return unwrap(
          handle === undefined
            ? sync.setAttributes(resolved.success, a)
            : sync.setHandleAttributes(handle, a)
        )
      }

      return unwrap(
        sync.setAttributes(resolve(t), a, { followFinalSymlink: !(isPath(t) && t.followFinalSymlink === false) })
      )
    }

    const binding: Binding = {
      stat,
      readDirectory: (path: string) => {
        const listing = unwrap(sync.readDirents(checked(path)))

        return {
          revision: metadata(runtime, listing.directory).revision,
          value: listing.entries.map((entry) => ({
            name: BytePath.toBytes(entry.name),
            reference: direntReference(runtime, entry)
          }))
        }
      },
      readLink: (path: string) => BytePath.toBytes(unwrap(sync.readLink(checked(path)))),
      realPath: (path: string) => BytePath.toBytes(unwrap(sync.realPath(checked(path)))),
      access: (path: string, bits: number) => {
        unwrap(
          sync.access(checked(path), { read: (bits & 4) !== 0, write: (bits & 2) !== 0, execute: (bits & 1) !== 0 })
        )

        return bits
      },
      mkdir: (path: string, o?: MkdirOptions) => {
        if (o?.exactMode && o.mode === undefined) throw Errors.fsFailure("InvalidArgument", "mkdir")

        unwrap((o?.exactMode ? exactSync : sync).makeDirectory(checked(path), {
          mode: creationMode(o?.mode, 0o1777, o?.exactMode),
          recursive: o?.recursive,
          preserveTimes: o?.times === undefined ? undefined : {
            atime: nano(o.times.access.kind === "value" ? o.times.access.nanoseconds : runtime.readClock()),
            mtime: nano(o.times.modification.kind === "value" ? o.times.modification.nanoseconds : runtime.readClock())
          }
        }))
      },
      rmdir: (path: string) => {
        unwrap(sync.removeDirectory(checked(path)))
      },
      unlink: (path: string) => {
        if (unwrap(sync.linkStat(path)).kind === "directory") throw Errors.fsFailure("IsDirectory", "unlink")
        unwrap(sync.unlink(checked(path)))
      },
      rename: (from: string, to: string) => {
        unwrap(sync.rename(checked(from), checked(to)))
      },
      link: (from: Target, to: string) => {
        const selected = resolve(from)

        const source: Vfs.HardLinkSource =
          Predicate.isString(selected) || BytePath.isBytePath(selected) || "directory" in selected
            ? { entry: selected }
            : { reference: selected }

        unwrap(sync.makeHardLink(source, to))
      },
      symlink: (target: string, path: string) => {
        unwrap(sync.makeSymlink(checked(path), target))
        runtime.compatibility.links.set(
          unwrap(sync.linkStat(path)).metadata.objectNumber,
          new TextEncoder().encode(target)
        )
      },
      chmod: (t: Target, mode: number) => attributes(t, { mode }),
      chown: (t: Target, owner: OwnerUpdate) => attributes(t, owner),
      utimes: (t: Target, tms: Times) => attributes(t, attributeTimes(tms)),
      open: (path: string, o: OpenOptions, noFollow: boolean, directory: boolean): Handle => {
        const openFile = (name: string) =>
          sync.open(name, {
            ...o,
            mode: creationMode(o.mode, 0o777),
            access: o.access === "readWrite" ? "readwrite" : o.access,
            create: o.create === "never" ? "existing" : o.create === "ifMissing" ? "ifmissing" : o.create,
            noFollow,
            appendCursor: "preserve",
            truncateCursor: "preserve"
          })

        const overwrite = o.access === "write" && o.create === "ifMissing" && o.truncate && !o.append
        const readExisting = o.access === "read" && o.create === "never" && !o.truncate && !o.append
        const checkedOpen = !noFollow && !directory && (overwrite || readExisting)

        const prepared = checkedOpen
          ? Paths.preparePath(path, "path", runtime.owner.limits.expandedPathBytes)
          : undefined

        const opened = prepared !== undefined && Result.isSuccess(prepared) ? openFile(path) : undefined

        // A successful checked open has already resolved and validated the file.
        // On failure, keep the preflight's error precedence and directory mapping.
        if (opened === undefined || Result.isFailure(opened)) {
          const info = noFollow ? sync.linkStat(path) : sync.stat(path)

          if (Result.isFailure(info) && !Predicate.isTagged(info.failure, "NotFound")) throw failure(info.failure)

          if (noFollow && Result.isSuccess(info) && info.success.kind === "symlink") {
            throw Errors.fsFailure("SymlinkLoop", "open")
          }

          if (!directory && Result.isSuccess(info) && info.success.kind === "directory") {
            throw Errors.fsFailure("IsDirectory", "open")
          }
        }

        const handle = directory ? unwrap(sync.openDirectory(checked(path))) : unwrap(opened ?? openFile(checked(path)))

        runtime.compatibility.track(handle.effect)
        let released = false

        const file = () => {
          if (!("readAlloc" in handle)) throw Errors.fsFailure("IsDirectory", "read")

          return handle
        }

        const set = (a: Vfs.Attributes) => {
          if ("setAttributes" in handle) unwrap(handle.setAttributes(a))
          else unwrap(sync.setHandleAttributes(handle.effect, a))
        }

        return guardHandle(runtime, {
          get closed() {
            return closed || released
          },
          directory,
          stat: () => {
            if (released) throw Errors.fsFailure("InvalidHandle", "stat")

            return metadata(runtime, unwrap(handle.stat()))
          },
          read: (length, position) => unwrap(file().readAlloc(length, { position })),
          write: (bytes, position, append) => {
            const info = unwrap(file().stat())
            const at = append ? info.metadata.size : position

            const part = growsFile(bytes, at, info.metadata.size)
              ? Effect.runSync(growthWritePrefix(runtime.owner, bytes, at, info.metadata.size))
              : bytes

            unwrap(file().write(new Uint8Array(part), append ? undefined : { position }))

            return part.length
          },
          truncate: (length) => {
            unwrap(file().truncate(length))
          },
          chmod: (mode) => set({ mode }),
          chown: set,
          utimes: (t) => set(attributeTimes(t)),
          sync: () => {
            unwrap(handle.stat())
          },
          close: () => {
            if (released) throw Errors.fsFailure("InvalidHandle", "close")
            unwrap(handle.close())
            released = true
          }
        })
      }
    }

    const liveClock = runtime.clock === Context.get(Context.empty(), Clock.Clock)

    const perform = <A>(operation: string, action: () => A): A => {
      if (closed) throw Errors.fsFailure("ClosedCaller", operation)

      return run(runtime, operation, action)
    }

    return {
      stat: (target) => perform("stat", () => binding.stat(target)),
      checkExists: (path) =>
        perform("stat", () => {
          const valid = Paths.validatePath(path, "path", runtime.owner.limits.expandedPathBytes)

          if (Result.isFailure(valid)) throw valid.failure
          unwrap(sync.lookup(path))
        }),
      readDirectory: (path) => perform("readDirectory", () => binding.readDirectory(path)),
      readDirectoryNames: options === undefined && liveClock
        ? (path) =>
          perform("readDirectory", () => unwrap(sync.readDirectory(checked(path))).names.map(BytePath.toBytes))
        : undefined,
      readDirectoryKinds: options === undefined && liveClock
        ? (path) =>
          perform("readDirectory", () =>
            unwrap(sync.readDirents(checked(path))).entries.map((entry) => ({
              name: BytePath.toBytes(entry.name),
              kind: entry.kind
            })))
        : undefined,
      // The Node provider takes ownership of this fresh array. Keep readFile detached from file storage.
      tryReadFile: liveClock
        ? (path) =>
          perform("readFile", () => {
            const valid = Paths.validatePath(path, "path", runtime.owner.limits.expandedPathBytes)

            return Result.isSuccess(valid) ? Result.getOrUndefined(sync.readFile(path)) : undefined
          })
        : undefined,
      readLink: (path) => perform("readLink", () => binding.readLink(path)),
      realPath: (path) => perform("realPath", () => binding.realPath(path)),
      access: (path, bits) => perform("access", () => binding.access(path, bits)),
      mkdir: (path, options) => perform("mkdir", () => binding.mkdir(path, options)),
      rmdir: (path) => perform("rmdir", () => binding.rmdir(path)),
      unlink: (path) => perform("unlink", () => binding.unlink(path)),
      rename: (from, to) => perform("rename", () => binding.rename(from, to)),
      link: (from, to) => perform("link", () => binding.link(from, to)),
      symlink: (target, path) => perform("symlink", () => binding.symlink(target, path)),
      chmod: (target, mode) => perform("chmod", () => binding.chmod(target, mode)),
      chown: (target, owner) => perform("chown", () => binding.chown(target, owner)),
      utimes: (target, times) => perform("utimes", () => binding.utimes(target, times)),
      open: (path, options, noFollow, directory) =>
        perform("open", () => binding.open(path, options, noFollow, directory))
    }
  }
)
