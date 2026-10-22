// These callbacks implement a checked native boundary with fresh synchronous fibers.
/* eslint-disable effecttsgo/run-effect-inside-effect */
/**
 * Checked synchronous operations for native adapters over an existing memory volume.
 * This adapter contract is versioned with core. Volumes from another package copy are rejected.
 * @since 0.10.0
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Result from "effect/Result"
import * as Scheduler from "effect/Scheduler"
import * as Scope from "effect/Scope"
import type { MkdirOptions, OpenOptions, RootCallerOptions } from "./Caller.js"
import { engineOf } from "./internal/adapterBinding.js"
import { Errors, Paths } from "./internal/engine.js"
import type { Metadata, OwnerUpdate, Times } from "./Metadata.js"
import type { Caller, DirectoryHandle, FileHandle, FsFailure, TargetInput, Volume } from "./VirtualFileSystem.js"

/**
 * A private-scope handle. Explicit close checks reentry before touching its scope.
 * @since 0.10.0
 */
export interface Handle {
  readonly closed: boolean
  readonly directory: boolean
  readonly stat: () => Metadata
  readonly read: (length: number, position: bigint) => Uint8Array
  readonly write: (bytes: Uint8Array, position: bigint, append: boolean) => number
  readonly truncate: (length: bigint) => void
  readonly chmod: (mode: number) => void
  readonly chown: (owner: OwnerUpdate) => void
  readonly utimes: (times: Times) => void
  readonly sync: () => void
  readonly close: () => void
}

/**
 * Synchronous filesystem operations. Failures throw the core FsFailure value.
 * @since 0.10.0
 */
export interface Binding {
  readonly stat: (target: TargetInput) => Metadata
  readonly readDirectory: (path: string) => Effect.Success<ReturnType<Caller["readDirectory"]>>
  readonly readLink: (path: string) => Uint8Array
  readonly realPath: (path: string) => Uint8Array
  readonly access: (path: string, bits: number) => number
  readonly mkdir: (path: string, options?: MkdirOptions) => void
  readonly rmdir: (path: string) => void
  readonly unlink: (path: string) => void
  readonly rename: (from: string, to: string) => void
  readonly link: (from: TargetInput, to: string) => void
  readonly symlink: (target: string, path: string) => void
  readonly chmod: (target: TargetInput, mode: number) => void
  readonly chown: (target: TargetInput, owner: OwnerUpdate) => void
  readonly utimes: (target: TargetInput, times: Times) => void
  readonly open: (path: string, options: OpenOptions, noFollow: boolean, directory: boolean) => Handle
}

/**
 * Binds only constructor-qualified synchronous memory volumes. The scope owns all opened handles.
 * No arbitrary Effect can be submitted to this binding.
 * @since 0.10.0
 */
export const bind = Effect.fnUntraced(
  function*(volume: Volume, options?: RootCallerOptions): Effect.fn.Return<Binding, FsFailure, Scope.Scope> {
    const engine = engineOf(volume)
    const checked = engine?.syncBinding

    if (engine === undefined || checked === undefined) return yield* Errors.argumentFailure("bind", "volume")
    yield* Effect.fromResult(checked.check("bind"))
    const context = yield* engine.context(options)
    const operations = context.operations
    const parent = yield* Effect.scope
    let closed = false
    yield* Scope.addFinalizer(
      parent,
      Effect.sync(() => {
        closed = true
      })
    )

    const run = <A, E>(operation: string, effect: Effect.Effect<A, E>): A => {
      if (closed) throw Errors.fsFailure("ClosedCaller", operation)
      const available = checked.check(operation)

      if (Result.isFailure(available)) throw available.failure
      const exit = Effect.runSyncExit(Effect.provideService(effect, Scheduler.PreventSchedulerYield, true))

      if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)

      return exit.value
    }

    const open = (path: string, options: OpenOptions, noFollow: boolean, directory: boolean): Handle => {
      // Preflight must precede even scope allocation. A rejected reentrant close/open owns no resources.
      run("open", Effect.void)
      const scope = Scope.forkUnsafe(parent)
      const target = { _tag: "Path" as const, path, followFinalSymlink: !noFollow }

      const acquire: Effect.Effect<FileHandle | DirectoryHandle, FsFailure, Scope.Scope> = directory
        ? operations.openDirectory(target)
        : operations.open(target, options)

      const acquired = Effect.runSyncExit(Effect.provideService(
        Effect.provideService(acquire, Scope.Scope, scope),
        Scheduler.PreventSchedulerYield,
        true
      ))

      if (Exit.isFailure(acquired)) {
        Effect.runSync(Scope.close(scope, Exit.void))
        throw Cause.squash(acquired.cause)
      }

      const handle: FileHandle | DirectoryHandle = acquired.value
      let released = false
      Effect.runSync(Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          released = true
        })
      ))

      const file = (): FileHandle => {
        if (!("pread" in handle)) throw Errors.fsFailure("IsDirectory", "read")

        return handle
      }

      return Object.freeze({
        get closed() {
          return released
        },
        directory,
        stat: () => run("fstat", handle.stat),
        read: (length: number, position: bigint) =>
          run("read", Effect.map(file().pread(length, position), (value) => value.bytes)),
        write: (bytes: Uint8Array, position: bigint, append: boolean) =>
          run("write", append ? file().write(bytes) : file().pwrite(bytes, position)),
        truncate: (length: bigint) => run("ftruncate", file().truncate(length)),
        chmod: (mode: number) => run("fchmod", operations.chmod(handle, mode)),
        chown: (owner: OwnerUpdate) => run("fchown", operations.chown(handle, owner)),
        utimes: (times: Times) => run("futimes", operations.utimes(handle, times)),
        sync: () => run("fsync", directory ? Effect.asVoid(handle.stat) : file().sync),
        close: () => {
          run("close", handle.close)
          Effect.runSync(Scope.close(scope, Exit.void))
        }
      })
    }

    return Object.freeze({
      stat: (target: TargetInput) => run("stat", operations.stat(target)),
      readDirectory: (path: string) => run("readdir", operations.readDirectory(path)),
      readLink: (path: string) => run("readlink", operations.readLink(path)),
      realPath: (path: string) => run("realpath", Effect.flatMap(operations.realPath(path), Paths.pathToBytes)),
      access: (path: string, bits: number) => run("access", operations.access(path, bits)),
      mkdir: (path: string, options?: MkdirOptions) => {
        run("mkdir", operations.mkdir(path, options))
      },
      rmdir: (path: string) => {
        run("rmdir", operations.rmdir(path))
      },
      unlink: (path: string) => {
        run("unlink", operations.unlink(path))
      },
      rename: (from: string, to: string) => {
        run("rename", operations.rename(from, to))
      },
      link: (from: TargetInput, to: string) => {
        run("link", operations.link(from, to))
      },
      symlink: (target: string, path: string) => {
        run("symlink", operations.symlink(target, path))
      },
      chmod: (target: TargetInput, mode: number) => run("chmod", operations.chmod(target, mode)),
      chown: (target: TargetInput, owner: OwnerUpdate) => run("chown", operations.chown(target, owner)),
      utimes: (target: TargetInput, times: Times) => run("utimes", operations.utimes(target, times)),
      open
    })
  }
)
