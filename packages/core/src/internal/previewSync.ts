// The existing core native boundary borrows the preview's checked synchronous region.
/* eslint-disable effecttsgo/experimental-api-usage, effecttsgo/run-effect-inside-effect */
import { BytePath, type VirtualFileSystem as Vfs } from "@effect-vfs/effect-preview"
import { unixNanoFromNanoseconds as nano } from "@effect-vfs/effect-preview/DateTime"
import { Effect, Predicate, Result, Scope } from "effect"
import type { MkdirOptions, OpenOptions, RootCallerOptions } from "../Caller.js"
import { DirectoryHandleId, FileHandleId } from "../FileHandle.js"
import type { OwnerUpdate, Times } from "../Metadata.js"
import type { Binding, Handle } from "../SynchronousAdapter.js"
import { Target as CoreTarget } from "../Target.js"
import type { FsFailure, ObjectReference, TargetInput } from "../VirtualFileSystem.js"
import { Errors, Paths } from "./engine.js"
import { coreReference, failure, metadata, PreviewBlocker, type runtimeOf } from "./previewRuntime.js"

type Runtime = NonNullable<ReturnType<typeof runtimeOf>>

type Target = TargetInput

const isPath = (target: Target): target is Extract<ReturnType<typeof CoreTarget.of>, { _tag: "Path" }> =>
  !Predicate.isString(target) && "_tag" in target && Predicate.isTagged(target, "Path")

const unwrap = <A>(result: Result.Result<A, Vfs.VirtualFileSystemError>): A => {
  if (Result.isFailure(result)) throw failure(result.failure)

  return result.success
}

const times = (runtime: Runtime, t: Times): Vfs.Attributes => {
  const selected = (value: Times["access"]) =>
    value.kind === "omit"
      ? undefined
      : nano(value.kind === "value" ? value.nanoseconds : runtime.clock.currentTimeNanosUnsafe())

  return { atime: selected(t.access), mtime: selected(t.modification) }
}

const run = <A>(runtime: Runtime, operation: string, action: () => A): A => {
  if (runtime.busy) throw Errors.fsFailure("VolumeBusy", operation)
  runtime.busy = true

  try {
    return action()
  } finally {
    runtime.busy = false
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
    }).pipe(Effect.mapError(failure))

    const sync = yield* caller.acquireSync.pipe(Effect.mapError(failure))
    let closed = false
    yield* Scope.addFinalizer(
      yield* Effect.scope,
      Effect.sync(() => {
        closed = true
      })
    )

    const resolveReference = (value: ObjectReference) => {
      const r = runtime.references.get(value)

      if (r === undefined) throw Errors.fsFailure("ForeignReference", "bind")

      return r
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

    const stat = (t: Target) =>
      metadata(
        runtime,
        unwrap(isPath(t) && t.followFinalSymlink === false ? sync.linkStat(resolveEntry(t)) : sync.stat(resolve(t)))
      )

    const attributes = (t: Target, a: Vfs.Attributes) => {
      if (isPath(t) && t.followFinalSymlink === false && a.mode !== undefined && stat(t).kind === "symlink") {
        throw new PreviewBlocker({ feature: "symlinkMode" })
      }

      return unwrap(
        sync.setAttributes(resolve(t), a, { followFinalSymlink: !(isPath(t) && t.followFinalSymlink === false) })
      )
    }

    const binding: Binding = {
      stat,
      readDirectory: (path: string) => ({
        revision: metadata(runtime, unwrap(sync.stat(path))).revision,
        value: unwrap(sync.readDirectoryEntries(path)).entries.map((e) => ({
          name: BytePath.toBytes(e.name),
          reference: coreReference(runtime, e.object)
        }))
      }),
      readLink: (path: string) => BytePath.toBytes(unwrap(sync.readLink(path))),
      realPath: (path: string) => BytePath.toBytes(unwrap(sync.realPath(path))),
      access: (path: string, bits: number) => {
        unwrap(sync.access(path, { read: (bits & 4) !== 0, write: (bits & 2) !== 0, execute: (bits & 1) !== 0 }))

        return bits
      },
      mkdir: (path: string, o?: MkdirOptions) => {
        if (o?.exactMode || o?.times !== undefined) throw new PreviewBlocker({ feature: "atomicDirectoryMetadata" })
        unwrap(sync.makeDirectory(path, o))
      },
      rmdir: (path: string) => {
        unwrap(sync.removeDirectory(path))
      },
      unlink: (path: string) => {
        if (unwrap(sync.linkStat(path)).kind === "directory") throw Errors.fsFailure("IsDirectory", "unlink")
        unwrap(sync.unlink(path))
      },
      rename: (from: string, to: string) => {
        unwrap(sync.rename(from, to))
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
        unwrap(sync.makeSymlink(path, target))
      },
      chmod: (t: Target, mode: number) => attributes(t, { mode }),
      chown: (t: Target, owner: OwnerUpdate) => attributes(t, owner),
      utimes: (t: Target, tms: Times) => attributes(t, times(runtime, tms)),
      open: (path: string, o: OpenOptions, noFollow: boolean, directory: boolean): Handle => {
        const info = noFollow ? sync.linkStat(path) : sync.stat(path)

        if (Result.isFailure(info) && !Predicate.isTagged(info.failure, "NotFound")) throw failure(info.failure)

        if (noFollow && Result.isSuccess(info) && info.success.kind === "symlink") {
          throw Errors.fsFailure("SymlinkLoop", "open")
        }

        if (!directory && Result.isSuccess(info) && info.success.kind === "directory") {
          throw Errors.fsFailure("IsDirectory", "open")
        }

        const handle = directory ? unwrap(sync.openDirectory(path)) : unwrap(sync.open(path, {
          ...o,
          access: o.access === "readWrite" ? "readwrite" : o.access,
          create: o.create === "never" ? "existing" : o.create === "ifMissing" ? "ifmissing" : o.create,
          noFollow,
          appendCursor: "preserve",
          truncateCursor: "preserve"
        }))

        let released = false

        const file = () => {
          if (!("readAlloc" in handle)) throw Errors.fsFailure("IsDirectory", "read")

          return handle
        }

        const set = (a: Vfs.Attributes) => {
          if ("setAttributes" in handle) unwrap(handle.setAttributes(a))
          else unwrap(sync.setAttributes(unwrap(handle.stat()).reference, a))
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
            const usage = Effect.runSync(runtime.owner.usage)
            const fileAvailable = runtime.owner.limits.fileBytes - at
            const volumeAvailable = info.metadata.size + runtime.owner.limits.contentBytes - usage.contentBytes - at
            const available = fileAvailable < volumeAvailable ? fileAvailable : volumeAvailable

            if (bytes.length > 0 && available <= 0n) {
              throw Errors.fsFailure(
                fileAvailable <= 0n ? "FileTooLarge" : "NoSpace",
                "write"
              )
            }

            const part = bytes.subarray(0, Number(available < BigInt(bytes.length) ? available : BigInt(bytes.length)))
            unwrap(file().write(new Uint8Array(part), append ? undefined : { position }))

            return part.length
          },
          truncate: (length) => {
            unwrap(file().truncate(length))
          },
          chmod: (mode) => set({ mode }),
          chown: set,
          utimes: (t) => set(times(runtime, t)),
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

    return {
      stat: (target) => run(runtime, "stat", () => binding.stat(target)),
      readDirectory: (path) => run(runtime, "readDirectory", () => binding.readDirectory(path)),
      readLink: (path) => run(runtime, "readLink", () => binding.readLink(path)),
      realPath: (path) => run(runtime, "realPath", () => binding.realPath(path)),
      access: (path, bits) => run(runtime, "access", () => binding.access(path, bits)),
      mkdir: (path, options) => run(runtime, "mkdir", () => binding.mkdir(path, options)),
      rmdir: (path) => run(runtime, "rmdir", () => binding.rmdir(path)),
      unlink: (path) => run(runtime, "unlink", () => binding.unlink(path)),
      rename: (from, to) => run(runtime, "rename", () => binding.rename(from, to)),
      link: (from, to) => run(runtime, "link", () => binding.link(from, to)),
      symlink: (target, path) => run(runtime, "symlink", () => binding.symlink(target, path)),
      chmod: (target, mode) => run(runtime, "chmod", () => binding.chmod(target, mode)),
      chown: (target, owner) => run(runtime, "chown", () => binding.chown(target, owner)),
      utimes: (target, times) => run(runtime, "utimes", () => binding.utimes(target, times)),
      open: (path, options, noFollow, directory) =>
        run(runtime, "open", () => binding.open(path, options, noFollow, directory))
    }
  }
)
