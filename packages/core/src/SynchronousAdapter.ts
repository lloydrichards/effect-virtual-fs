/**
 * Checked synchronous operations for native adapters over an existing memory volume.
 * This adapter contract is versioned with core. Volumes from another package copy are rejected.
 * @since 0.10.0
 */
import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type { MkdirOptions, OpenOptions, RootCallerOptions } from "./Caller.js"
import { Errors } from "./internal/model.js"
import { runtimeOf } from "./internal/runtime.js"
import { bind as bindRuntime } from "./internal/synchronous.js"
import type { Metadata, OwnerUpdate, Times } from "./Metadata.js"
import type { Caller, FsFailure, TargetInput, Volume } from "./VirtualFileSystem.js"

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
    const runtime = runtimeOf(volume)

    if (runtime === undefined || !runtime.owner.limits.synchronous) {
      return yield* Errors.argumentFailure("bind", "volume")
    }

    return yield* bindRuntime(runtime, options)
  }
)
