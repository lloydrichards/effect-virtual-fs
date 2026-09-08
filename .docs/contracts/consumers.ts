// Compile-only future-API cases. File and snapshot methods below are not implemented.
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import { CurrentFileSystem, VirtualFileSystem as Vfs } from "./proposed.js"
import type {
  Caller,
  ConfigurationError,
  DirectoryHandle,
  FileHandle,
  FsError,
  ImageError,
  Metadata,
  Snapshot,
  Volume
} from "./proposed.js"

export const direct = Effect.scoped(Effect.gen(function*() {
  const volume = yield* Vfs.make()
  const root = yield* volume.caller()
  yield* root.mkdir("/project")
  const project = yield* root.withDirectory("/project")
  const file = yield* project.open("main.js", { access: "readWrite", create: "exclusive", mode: 0o644 })
  const written = yield* file.write(new TextEncoder().encode("export default 1"))
  yield* file.seek(0n, "start")
  const bytes = yield* file.read(written)
  yield* file.close()
  return { written, bytes }
})) satisfies Effect.Effect<{ written: number; bytes: Uint8Array }, ConfigurationError | FsError>

export const inspect = Effect.gen(function*() {
  const caller = yield* CurrentFileSystem
  return yield* caller.stat("main.js")
}) satisfies Effect.Effect<Metadata, FsError, CurrentFileSystem>

export const provideExisting = (caller: Caller) =>
  inspect.pipe(Effect.provideService(CurrentFileSystem, caller)) satisfies Effect.Effect<Metadata, FsError>

export const provideLayer = (caller: Caller) =>
  inspect.pipe(Effect.provide(Layer.succeed(CurrentFileSystem, caller))) satisfies Effect.Effect<Metadata, FsError>

export const directoryLayer = (root: Caller) =>
  Layer.effect(CurrentFileSystem, root.withDirectory("/project")) satisfies Layer.Layer<CurrentFileSystem, FsError>

export const sharedCallers = (volume: Volume) =>
  Effect.scoped(Effect.gen(function*() {
    const admin = yield* volume.caller()
    const aliceRoot = yield* volume.caller({
      identity: { uid: 1000, gid: 100, groups: [], privileged: false },
      umask: 0o022
    })
    const alice = yield* aliceRoot.withDirectory("/project")
    const base = yield* admin.openDirectory("/project/src")
    yield* admin.rename("/project", "/moved")
    return yield* alice.stat("main.js", { relativeTo: base })
  })) satisfies Effect.Effect<Metadata, ConfigurationError | FsError>

export const handleOperations = (caller: Caller, file: FileHandle, base: DirectoryHandle) =>
  Effect.gen(function*() {
    const count = yield* file.pwrite(new Uint8Array([1, 2]), 4n)
    const bytes = yield* file.pread(count, 4n)
    yield* caller.chmodHandle(file, 0o600)
    yield* caller.utimesHandle(base, { access: { kind: "omit" }, modification: { kind: "now" } })
    return bytes
  }) satisfies Effect.Effect<Uint8Array, FsError>

export const restore = Effect.gen(function*() {
  const volume = yield* Vfs.fromFixture({
    entries: [
      { kind: "hardLink", path: "/b.txt", target: "/a.txt" },
      { kind: "file", path: "/a.txt", bytes: new TextEncoder().encode("hello") }
    ]
  })
  const captured = yield* volume.snapshot()
  const encoded = yield* Vfs.encodeSnapshot(captured)
  const decoded = yield* Vfs.decodeSnapshot(encoded, {
    maxEncodedBytes: 1_000_000,
    maxRecords: 100,
    maxEntries: 100,
    maxDecodedBytes: 100_000n
  })
  return yield* Vfs.fromSnapshot(decoded, { maxStoredBytes: 100_000n })
}) satisfies Effect.Effect<Volume, ConfigurationError | ImageError>

export const byteNames = (caller: Caller) =>
  Effect.gen(function*() {
    const path = yield* Vfs.pathFromBytes(new Uint8Array([47, 255]))
    const info = yield* caller.lstat(path)
    const names = yield* caller.readDirectoryBytes("/")
    return { info, names }
  }) satisfies Effect.Effect<{ info: Metadata; names: ReadonlyArray<Uint8Array> }, FsError>

// These rejections are part of the declaration review; removing a required
// distinction makes an @ts-expect-error unused and fails the compiler check.
export const rejectedCalls = (caller: Caller, file: FileHandle, image: Snapshot) => {
  // @ts-expect-error Acquisition requires a scope; provision alone does not remove it.
  const unscoped: Effect.Effect<FileHandle, FsError> = caller.open("x", { access: "read" })
  // @ts-expect-error A directory base is not a numeric descriptor.
  caller.stat("x", { relativeTo: 3 })
  // @ts-expect-error A file handle is not a directory base.
  caller.stat("x", { relativeTo: file })
  // @ts-expect-error Proposed offsets use bigint, not potentially rounded numbers.
  file.seek(1, "start")
  // @ts-expect-error Proposed read-only options prohibit truncation.
  caller.open("x", { access: "read", truncate: true })
  // @ts-expect-error Read-only mode does not enable append writes.
  caller.open("x", { access: "read", append: true })
  // @ts-expect-error Mode applies only to proposed creating opens.
  caller.open("x", { access: "write", mode: 0o600 })
  // @ts-expect-error Metadata authority comes from a caller, not an implicit opener.
  file.chmod(0o600)
  // @ts-expect-error Raw input bytes must pass through the path constructor.
  caller.stat(new Uint8Array([47, 255]))
  // @ts-expect-error Snapshot internals are not a mutable public record table.
  image.records
  return unscoped
}

export const scopedRequirement = (caller: Caller): Effect.Effect<Caller, FsError, Scope.Scope> =>
  caller.withDirectory("/project")

// The compiler deliberately cannot prove runtime lifetime or volume ownership.
// These expressions must compile; runtime checks remain necessary.
export const escapedHandle = (caller: Caller) => Effect.scoped(caller.open("x", { access: "read" }))
export const foreignBase = (caller: Caller, baseFromAnotherVolume: DirectoryHandle) =>
  caller.stat("x", { relativeTo: baseFromAnotherVolume })
