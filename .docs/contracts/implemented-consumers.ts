// Compile-only checks against real core exports. Never execute the invalid-call example.
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import { VirtualFileSystem as Vfs } from "../../packages/core/src/index.js"

export const rootCaller = Effect.gen(function*() {
  const volume = yield* Vfs.make({ maxEntries: 10, maxPathBytes: 1024 })
  return yield* volume.caller()
}) satisfies Effect.Effect<Vfs.Caller, Vfs.ConfigurationError>

export const scopedDirectory = (caller: Vfs.Caller) =>
  Effect.scoped(Effect.gen(function*() {
    const child = yield* caller.withDirectory(".")
    const handle = yield* child.openDirectory(".")
    yield* handle.close()
    return yield* child.stat(".")
  })) satisfies Effect.Effect<Vfs.Metadata, Vfs.FsError>

export const service = Layer.effect(Vfs.CurrentFileSystem, rootCaller)
export const acquired = (caller: Vfs.Caller) =>
  caller.openDirectory(".") satisfies Effect.Effect<Vfs.DirectoryHandle, Vfs.FsError, Scope.Scope>

export const rejected = (caller: Vfs.Caller) => {
  // @ts-expect-error Directory acquisition still requires Scope.
  const unscoped: Effect.Effect<Vfs.DirectoryHandle, Vfs.FsError> = caller.openDirectory(".")
  // @ts-expect-error Raw bytes require the owning BytePath constructor.
  caller.stat(new Uint8Array([47]))
  // @ts-expect-error Numeric descriptors are not directory identities.
  caller.stat(".", { relativeTo: 1 })
  // @ts-expect-error Root callers have no public close method.
  caller.close()
  return unscoped
}
