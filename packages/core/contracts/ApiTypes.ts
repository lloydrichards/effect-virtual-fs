// Compile-only checks against the public core API. Never execute `rejected` or
// `rejectedFile`: their invalid calls exist to make API regressions fail type-checking.
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import { VirtualFileSystem as Vfs } from "../src/index.js"

export const rootCaller = Effect.gen(function*() {
  const volume = yield* Vfs.make({ maxEntries: 10, maxPathBytes: 1024 })
  return yield* volume.caller()
}) satisfies Effect.Effect<Vfs.Caller, Vfs.ConfigurationError>

export const scopedDirectory = (caller: Vfs.Caller) =>
  Effect.scoped(Effect.gen(function*() {
    const child = yield* caller.withDirectory(".")
    const handle = yield* child.openDirectory(".")
    yield* handle.close
    return yield* child.stat(".")
  })) satisfies Effect.Effect<Vfs.Metadata, Vfs.FsError>

export const service = Layer.effect(Vfs.CurrentFileSystem, rootCaller)
export const moveDirectory = (caller: Vfs.Caller, source: Vfs.DirectoryHandle, destination: Vfs.DirectoryHandle) =>
  caller.rename("old", "new", { sourceRelativeTo: source, destinationRelativeTo: destination }) satisfies Effect.Effect<
    void,
    Vfs.FsError
  >

export const removeDirectory = (caller: Vfs.Caller) => caller.rmdir("empty") satisfies Effect.Effect<void, Vfs.FsError>

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

export const scopedFile = (caller: Vfs.Caller) =>
  Effect.scoped(Effect.gen(function*() {
    const file = yield* caller.open("file", { access: "readWrite", create: "ifMissing" })
    yield* file.write(new Uint8Array([1, 2]))
    yield* file.pwrite(new Uint8Array([3]), 0n)
    yield* file.seek(0n, "start")
    return yield* file.read(2)
  }))

export const persistence = Effect.gen(function*() {
  const volume = yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/file", bytes: new Uint8Array([1]) }] })
  const bytes = yield* Vfs.encodeSnapshot(yield* volume.snapshot)
  return yield* Vfs.fromSnapshot(
    yield* Vfs.decodeSnapshot(bytes, {
      maxEncodedBytes: 10_000,
      maxRecords: 10,
      maxEntries: 10,
      maxDecodedBytes: 1_000
    })
  )
})

export const overlay = Effect.gen(function*() {
  const base = yield* (yield* Vfs.make()).snapshot
  const volume = yield* Vfs.makeOverlay(base, { maxBytes: 1_000 })
  const ordinary: Vfs.Volume = volume
  const changes: ReadonlyArray<Vfs.OverlayChange> = yield* volume.changes({ includeTimestamps: true })
  const capture: Vfs.OverlayCapture = yield* volume.capture()
  return { ordinary, changes, capture }
}) satisfies Effect.Effect<{
  readonly ordinary: Vfs.Volume
  readonly changes: ReadonlyArray<Vfs.OverlayChange>
  readonly capture: Vfs.OverlayCapture
}, Vfs.ConfigurationError | Vfs.ImageError>

export const rejectedFile = (caller: Vfs.Caller, file: Vfs.FileHandle) => {
  // @ts-expect-error File acquisition requires Scope too.
  const unscoped: Effect.Effect<Vfs.FileHandle, Vfs.FsError> = caller.open("file", { access: "read" })
  // @ts-expect-error Positional offsets are bigint, never lossy numbers.
  file.pread(1, 0)
  // @ts-expect-error Decoding untrusted input requires explicit work limits.
  Vfs.decodeSnapshot(new Uint8Array())
  // @ts-expect-error Overlay construction requires an authentic opaque snapshot.
  Vfs.makeOverlay(new Uint8Array())
  return unscoped
}
