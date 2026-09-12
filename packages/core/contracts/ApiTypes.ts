// Compile-only checks against the public core API. Never execute `rejected` or
// `rejectedFile`: their invalid calls exist to make API regressions fail type-checking.
import * as ByteSize from "effect/ByteSize"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { VirtualFileSystem as Vfs } from "../src/index.js"

export const rootCaller = Effect.gen(function*() {
  const volume = yield* Vfs.make({ maxEntries: 10, maxPathBytes: ByteSize.kibibytes(1) })
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
      maxEncodedBytes: ByteSize.kilobytes(10),
      maxRecords: 10,
      maxEntries: 10,
      maxDecodedBytes: ByteSize.kilobytes(1)
    })
  )
})

export const overlay = Effect.gen(function*() {
  const base = yield* (yield* Vfs.make()).snapshot
  const volume = yield* Vfs.makeOverlay(base, { maxBytes: ByteSize.bytes(1_000) })
  const ordinary: Vfs.Volume = volume
  const changes: ReadonlyArray<Vfs.OverlayChange> = yield* volume.changes({ includeTimestamps: true })
  const capture: Vfs.OverlayCapture = yield* volume.capture()
  return { ordinary, changes, capture }
}) satisfies Effect.Effect<{
  readonly ordinary: Vfs.Volume
  readonly changes: ReadonlyArray<Vfs.OverlayChange>
  readonly capture: Vfs.OverlayCapture
}, Vfs.ConfigurationError | Vfs.ImageError>

const customDeltaLimits: Vfs.SnapshotDeltaLimits = {
  ...Vfs.SnapshotDeltaLimits.constrained,
  maxEncodedBytes: ByteSize.mebibytes(8)
}

export const snapshotDelta = Effect.gen(function*() {
  const baseVolume = yield* Vfs.fromFixture({
    entries: [{ kind: "file", path: "/before", bytes: new Uint8Array([1]) }]
  })
  const targetVolume = yield* Vfs.fromFixture({
    entries: [{ kind: "file", path: "/after", bytes: new Uint8Array([2]) }]
  })
  const base = yield* baseVolume.snapshot
  const target = yield* targetVolume.snapshot
  const delta = yield* Vfs.diffSnapshots(base, target, customDeltaLimits)
  const changes: ReadonlyArray<Vfs.SnapshotChange> = yield* Vfs.inspectSnapshotDelta(base, delta, {
    includeTimestamps: true
  })

  const codec = Vfs.SnapshotDeltaFromBytes(customDeltaLimits)
  const bytes = yield* Schema.encodeEffect(codec)(delta)
  const decoded = yield* Schema.decodeEffect(codec)(bytes)
  const restored = yield* Vfs.applySnapshotDelta(base, decoded, customDeltaLimits)
  return { changes, restored }
}) satisfies Effect.Effect<
  { readonly changes: ReadonlyArray<Vfs.SnapshotChange>; readonly restored: Vfs.Snapshot },
  Vfs.ConfigurationError | Vfs.ImageError | Vfs.SnapshotDeltaError | Schema.SchemaError | PlatformError.PlatformError,
  Crypto.Crypto
>

export const defaultDeltaCodec = Vfs.SnapshotDeltaFromBytes(Vfs.SnapshotDeltaLimits.default)
export const constrainedDeltaCodec = Vfs.SnapshotDeltaFromBytes(Vfs.SnapshotDeltaLimits.constrained)

export const recoverBaseMismatch = (base: Vfs.Snapshot, delta: Vfs.SnapshotDelta) =>
  Vfs.applySnapshotDelta(base, delta).pipe(
    Effect.catchTag(
      "SnapshotDeltaError",
      (error) => error.code === "BaseMismatch" ? Effect.succeed(base) : Effect.fail(error)
    )
  )

export const rejectedDelta = () => {
  // @ts-expect-error Delta comparison requires authentic opaque snapshots, not encoded bytes.
  Vfs.diffSnapshots(new Uint8Array(), new Uint8Array())
  // @ts-expect-error Delta application requires an authentic opaque SnapshotDelta.
  Vfs.applySnapshotDelta({} as Vfs.Snapshot, { records: [] })
  // @ts-expect-error Custom policies must specify every resource limit.
  Vfs.SnapshotDeltaFromBytes({ maxEncodedBytes: 1_000 })
}

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
