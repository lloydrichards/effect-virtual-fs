// Compile-only checks against the public core API. Never execute `rejected` or
// `rejectedFile`: their invalid calls exist to make API regressions fail type-checking.
import * as ByteSize from "effect/ByteSize"
import type * as Cause from "effect/Cause"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type * as Stream from "effect/Stream"
import { LiveVolume, Search, Testing } from "../src/index.js"
import { VfsError as VfsErrorModule, VirtualFileSystem as Vfs } from "../src/index.js"
import * as SearchModule from "../src/Search.js"

export const publicErrorIdentity: typeof Vfs.VfsError = VfsErrorModule.VfsError
export const publicCodeIdentity: typeof Vfs.VfsCode = VfsErrorModule.VfsCode

export const liveVolumeRegistry = <K, E, R>(options: LiveVolume.RegistryOptions<K, E, R>) =>
  LiveVolume.makeRegistry(options) satisfies Effect.Effect<
    LiveVolume.Registry<K, E>,
    Vfs.ArgumentFailure,
    R | Crypto.Crypto | Scope.Scope
  >

export const borrowLiveVolume = <K, E>(registry: LiveVolume.Registry<K, E>, key: K) =>
  registry.get(key) satisfies Effect.Effect<Vfs.Volume, E | Vfs.VfsError | Cause.ExceededCapacityError, Scope.Scope>

export const conditionalChildOpen = (caller: Vfs.Caller, reference: Vfs.ObjectReference) =>
  Effect.gen(function*() {
    const observation = yield* caller.stat(reference)
    const options: Vfs.OpenEntryOptions = {
      access: "readWrite",
      create: "ifMissing",
      initialSize: 3n,
      owner: { uid: 1, gid: 2 },
      expectedChild: {
        reference,
        revision: observation.revision,
        atimeNs: observation.atimeNs,
        mtimeNs: observation.mtimeNs
      }
    }
    yield* caller.open(Vfs.Entry(reference, new Uint8Array([102])), options)
    return yield* caller.open(Vfs.Entry(reference, "g"), { ...options, expectedChild: null, expected: null })
  }) satisfies Effect.Effect<Vfs.OpenEntryResult, Vfs.FsFailure, Scope.Scope>

export const references = (caller: Vfs.Caller) =>
  Effect.gen(function*() {
    const root: Vfs.ObjectReference = yield* caller.root
    const child: Vfs.ObjectReference = yield* caller.lookup(Vfs.Entry(root, new Uint8Array([102])))
    const parent: Vfs.ObjectReference = yield* caller.parent(root)
    const metadata: Vfs.Metadata = yield* caller.stat(child)
    const granted: number = yield* caller.access(child, 0o4)
    const directory: Vfs.ObjectObservation<ReadonlyArray<Vfs.DirectoryEntry>> = yield* caller.readDirectory(parent)
    const target: Uint8Array = yield* caller.readLink(child)
    return { root, child, metadata, granted, directory, target }
  }) satisfies Effect.Effect<{
    readonly root: Vfs.ObjectReference
    readonly child: Vfs.ObjectReference
    readonly metadata: Vfs.Metadata
    readonly granted: number
    readonly directory: Vfs.ObjectObservation<ReadonlyArray<Vfs.DirectoryEntry>>
    readonly target: Uint8Array
  }, Vfs.FsFailure>

export const targets = (caller: Vfs.Caller, reference: Vfs.ObjectReference, handle: Vfs.DirectoryHandle) =>
  Effect.gen(function*() {
    const byPath: Vfs.Metadata = yield* caller.stat(Vfs.Target.Path({ path: "file", relativeTo: handle }))
    const noFollow: Vfs.Metadata = yield* caller.stat(Vfs.Target.Path({ path: "/link", followFinalSymlink: false }))
    const byReference: Vfs.Metadata = yield* caller.stat(Vfs.Target.Reference({ reference }))
    const byHandle: Vfs.Metadata = yield* caller.stat(Vfs.Target.Handle({ handle }))
    const bare: Vfs.Metadata = yield* caller.stat(handle)
    const path: Vfs.BytePath = yield* caller.realPath(reference)
    return [byPath, noFollow, byReference, byHandle, bare, path] as const
  }) satisfies Effect.Effect<unknown, Vfs.FsFailure>

export const referencedFile = (caller: Vfs.Caller, reference: Vfs.ObjectReference) =>
  caller.open(reference, { access: "read" }) satisfies Effect.Effect<Vfs.FileHandle, Vfs.FsFailure, Scope.Scope>

export const entryMutations = (caller: Vfs.Caller, source: Vfs.ObjectReference, destination: Vfs.ObjectReference) =>
  Effect.gen(function*() {
    const directory: Vfs.ReferenceEntryResult = yield* caller.mkdir(Vfs.Entry(destination, "directory"), {
      mode: 0o750
    })
    const linked: Vfs.ReferenceEntryResult = yield* caller.link(source, Vfs.Entry(destination, "alias"))
    const renamed: Vfs.RenameReferenceResult = yield* caller.rename(
      Vfs.Entry(destination, "alias"),
      Vfs.Entry(directory.reference, "moved")
    )
    const byPath: Vfs.ReferenceEntryResult = yield* caller.mkdir("/by-path")
    const removed: Vfs.DirectoryChange = yield* caller.remove("/by-path")
    yield* caller.chmod(linked.reference, 0o600)
    yield* caller.truncate(linked.reference, 0n)
    return { renamed, byPath, removed }
  }) satisfies Effect.Effect<unknown, Vfs.FsFailure>

export const referencedWritableFile = (caller: Vfs.Caller, reference: Vfs.ObjectReference) =>
  caller.open(reference, {
    access: "readWrite",
    append: true
  }) satisfies Effect.Effect<Vfs.FileHandle, Vfs.FsFailure, Scope.Scope>

export const referencedChildFile = (caller: Vfs.Caller, directory: Vfs.ObjectReference) =>
  caller.open(Vfs.Entry(directory, "file"), {
    access: "readWrite",
    create: "ifMissing"
  }) satisfies Effect.Effect<Vfs.OpenEntryResult, Vfs.FsFailure, Scope.Scope>

export const rootCaller = Effect.gen(function*() {
  const volume = yield* Vfs.make({ maxEntries: 10, maxPathBytes: ByteSize.kibibytes(1) })
  const durability: Vfs.VolumeDurability = volume.durability
  const identity: Vfs.VolumeIdentity = volume.identity
  const incarnation: Vfs.VolumeIncarnation = volume.incarnation
  const limits: Vfs.VolumeLimits = volume.limits
  const usage: Vfs.VolumeUsage = yield* volume.usage
  Vfs.isVolumeDurabilityAtLeast(durability, "memory-only")
  Vfs.VolumeDurabilityOrder("memory-only", "survives-power-loss")
  void identity
  void incarnation
  void limits
  void usage
  return yield* volume.caller()
}) satisfies Effect.Effect<Vfs.Caller, Vfs.VfsError, Crypto.Crypto>

export const scopedDirectory = (caller: Vfs.Caller) =>
  Effect.scoped(Effect.gen(function*() {
    const child = yield* caller.withDirectory(".")
    const handle = yield* child.openDirectory(".")
    yield* handle.close
    return yield* child.stat(".")
  })) satisfies Effect.Effect<Vfs.Metadata, Vfs.FsFailure>

export const service = Layer.effect(Vfs.Caller, rootCaller)
export const wired: Layer.Layer<Vfs.Caller, Vfs.VfsError, Crypto.Crypto> = Vfs.Caller.layer({ umask: 0o022 }).pipe(
  Layer.provide(Vfs.Volume.layer({ maxEntries: 10 }))
)
export const moveDirectory = (caller: Vfs.Caller, source: Vfs.DirectoryHandle, destination: Vfs.DirectoryHandle) =>
  caller.rename(
    Vfs.Target.Path({ path: "old", relativeTo: source }),
    Vfs.Target.Path({ path: "new", relativeTo: destination })
  ) satisfies Effect.Effect<Vfs.RenameReferenceResult, Vfs.FsFailure>

export const removeDirectory = (caller: Vfs.Caller) =>
  caller.rmdir("empty") satisfies Effect.Effect<Vfs.DirectoryChange, Vfs.FsFailure>

export const acquired = (caller: Vfs.Caller) =>
  caller.openDirectory(".") satisfies Effect.Effect<Vfs.DirectoryHandle, Vfs.FsFailure, Scope.Scope>

export const rejected = (caller: Vfs.Caller) => {
  // @ts-expect-error Directory acquisition still requires Scope.
  const unscoped: Effect.Effect<Vfs.DirectoryHandle, Vfs.FsFailure> = caller.openDirectory(".")
  // @ts-expect-error Raw bytes require the owning BytePath constructor.
  caller.stat(new Uint8Array([47]))
  // @ts-expect-error Numeric descriptors are not directory identities.
  caller.stat(Vfs.Target.Path({ path: ".", relativeTo: 1 }))
  // @ts-expect-error Root callers have no public close method.
  caller.close()
  // @ts-expect-error Object references cannot be structurally constructed.
  const reference: Vfs.ObjectReference = {}
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

export const rejectedReferenceFile = (caller: Vfs.Caller, reference: Vfs.ObjectReference) => {
  // @ts-expect-error Reference-based file acquisition still requires Scope.
  const unscoped: Effect.Effect<Vfs.FileHandle, Vfs.FsFailure> = caller.open(reference, { access: "read" })
  // @ts-expect-error Creation mode does not apply to an already identified object.
  caller.open(reference, { access: "write", mode: 0o600, unknownOption: true })
  return unscoped
}

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
}) satisfies Effect.Effect<
  {
    readonly ordinary: Vfs.Volume
    readonly changes: ReadonlyArray<Vfs.OverlayChange>
    readonly capture: Vfs.OverlayCapture
  },
  Vfs.VfsError,
  Crypto.Crypto
>

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
  Vfs.VfsError | Schema.SchemaError | PlatformError.PlatformError,
  Crypto.Crypto
>

export const defaultDeltaCodec = Vfs.SnapshotDeltaFromBytes(Vfs.SnapshotDeltaLimits.default)
export const constrainedDeltaCodec = Vfs.SnapshotDeltaFromBytes(Vfs.SnapshotDeltaLimits.constrained)

export const recoverBaseMismatch = (base: Vfs.Snapshot, delta: Vfs.SnapshotDelta) =>
  Vfs.applySnapshotDelta(base, delta).pipe(
    Effect.catchTag("VfsError", (error) => error.code === "BaseMismatch" ? Effect.succeed(base) : Effect.fail(error))
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
  const unscoped: Effect.Effect<Vfs.FileHandle, Vfs.FsFailure> = caller.open("file", { access: "read" })
  // @ts-expect-error Positional offsets are bigint, never lossy numbers.
  file.pread(1, 0)
  // @ts-expect-error Decoding untrusted input requires explicit work limits.
  Vfs.decodeSnapshot(new Uint8Array())
  // @ts-expect-error Overlay construction requires an authentic opaque snapshot.
  Vfs.makeOverlay(new Uint8Array())
  return unscoped
}

export const snapshotGlobTypes = (snapshot: Vfs.Snapshot) => {
  const query: Search.GlobQuery = {
    root: "/",
    include: ["**"],
    kinds: ["file"],
    limits: { maxResults: 5, maxResultBytes: ByteSize.bytes(100) }
  }
  const collector: Effect.Effect<Search.GlobReport, Search.GlobFailure> = Search.glob(snapshot, query)
  const stream: Stream.Stream<string, Search.ScanGlobFailure> = SearchModule.scanGlob(snapshot, query)
  // @ts-expect-error filenames have no regular-expression interpretation
  Search.glob(snapshot, { root: "/", include: [/TODO/u] })
  // @ts-expect-error every query chooses an explicit root
  Search.glob(snapshot, { include: ["**"] })
  // @ts-expect-error kind selectors use the finite namespace kinds
  Search.glob(snapshot, { root: "/", include: ["**"], kinds: ["hardLink"] })
  // @ts-expect-error byte limits preserve native Effect ByteSize contracts
  Search.glob(snapshot, { root: "/", include: ["**"], limits: { maxPathBytes: 4096 } })
  return { collector, stream }
}

export const snapshotContentTypes = (snapshot: Vfs.Snapshot) => {
  const query: Search.ContentQuery = {
    root: "/",
    include: ["**/*.ts"],
    pattern: Search.Pattern.cases.Literal.make({ pattern: "TODO" }),
    ignoreCase: true,
    limits: { maxExcerptBytes: ByteSize.bytes(20) }
  }
  const lines: Effect.Effect<Search.LinesReport, Search.ContentFailure> = Search.lines(snapshot, query)
  const files: Effect.Effect<Search.FilesReport, Search.ContentFailure> = Search.files(snapshot, query)
  const counts: Effect.Effect<Search.CountLinesReport, Search.ContentFailure> = Search.countLines(snapshot, query)
  const scanLines: Stream.Stream<Search.LineResult, Search.ScanContentFailure> = SearchModule.scanLines(snapshot, query)
  const scanFiles: Stream.Stream<string, Search.ScanContentFailure> = SearchModule.scanFiles(snapshot, query)
  const scanCounts: Stream.Stream<Search.CountResult, Search.ScanContentFailure> = SearchModule.scanCountLines(
    snapshot,
    query
  )
  Search.lines(snapshot, { ...query, pattern: Search.Pattern.cases.Regex.make({ pattern: "TODO|FIXME" }) })
  // @ts-expect-error Content patterns always declare their interpretation.
  Search.lines(snapshot, { ...query, pattern: "TODO" })
  // @ts-expect-error Native RegExp objects do not supply flags to Search.
  Search.lines(snapshot, { ...query, pattern: /TODO/iu })
  // @ts-expect-error Content search always selects regular files.
  Search.files(snapshot, { ...query, kinds: ["symlink"] })
  // @ts-expect-error Pattern accepts source only, never caller flags.
  Search.Pattern.cases.Regex.make({ pattern: "TODO", flags: "g" })
  // @ts-expect-error Content byte limits remain Effect ByteSize.
  Search.countLines(snapshot, { ...query, limits: { maxScannedBytes: 100 } })
  return { lines, files, counts, scanLines, scanFiles, scanCounts }
}

export const confinedCaller = (caller: Vfs.Caller, reference: Vfs.ObjectReference) =>
  Effect.gen(function*() {
    const confined = yield* caller.withRoot(reference)
    const options: Vfs.CallerWatchOptions = { alias: "resolved", recursive: false }
    const events: Stream.Stream<Vfs.Change, Vfs.FsFailure> = yield* confined.watch("/", options)
    const removal = confined.remove("/temp", { expected: reference }) satisfies Effect.Effect<
      Vfs.DirectoryChange,
      Vfs.FsFailure
    >
    const forcedRemoval = confined.remove("/temp", { expected: reference, force: true }) satisfies Effect.Effect<
      Vfs.DirectoryChange | undefined,
      Vfs.FsFailure
    >
    // @ts-expect-error Conditional removal compares an object reference, never a pathname.
    confined.remove("/temp", { expected: "/temp" })
    return { events, removal, forcedRemoval, limits: confined.limits }
  }) satisfies Effect.Effect<unknown, Vfs.FsFailure, Scope.Scope>

export const dualSearch = (snapshot: Vfs.Snapshot, glob: Search.GlobQuery, content: Search.ContentQuery) => ({
  glob: Search.glob(glob)(snapshot) satisfies Effect.Effect<Search.GlobReport, Search.GlobFailure>,
  scanGlob: Search.scanGlob(glob)(snapshot) satisfies Stream.Stream<string, Search.ScanGlobFailure>,
  lines: Search.lines(content)(snapshot) satisfies Effect.Effect<Search.LinesReport, Search.ContentFailure>,
  scanLines: Search.scanLines(content)(snapshot) satisfies Stream.Stream<Search.LineResult, Search.ScanContentFailure>,
  files: Search.files(content)(snapshot) satisfies Effect.Effect<Search.FilesReport, Search.ContentFailure>,
  scanFiles: Search.scanFiles(content)(snapshot) satisfies Stream.Stream<string, Search.ScanContentFailure>,
  countLines: Search.countLines(content)(snapshot) satisfies Effect.Effect<
    Search.CountLinesReport,
    Search.ContentFailure
  >,
  scanCountLines: Search.scanCountLines(content)(snapshot) satisfies Stream.Stream<
    Search.CountResult,
    Search.ScanContentFailure
  >
})

export const dualSnapshots = (snapshot: Vfs.Snapshot, bytes: Uint8Array, limits: Vfs.DecodeLimits) => ({
  encode: Vfs.encodeSnapshot(limits)(snapshot) satisfies Effect.Effect<
    Uint8Array,
    Vfs.ImageFailure | Vfs.ArgumentFailure
  >,
  encodeWithoutLimits: Vfs.encodeSnapshot()(snapshot) satisfies Effect.Effect<
    Uint8Array,
    Vfs.ImageFailure | Vfs.ArgumentFailure
  >,
  encodeStream: Vfs.encodeSnapshotStream(limits)(snapshot) satisfies Stream.Stream<
    Uint8Array,
    Vfs.ImageFailure | Vfs.ArgumentFailure
  >,
  decode: Vfs.decodeSnapshot(limits)(bytes) satisfies Effect.Effect<
    Vfs.Snapshot,
    Vfs.ImageFailure | Vfs.ArgumentFailure
  >,
  entries: Vfs.snapshotEntries("/")(snapshot) satisfies Stream.Stream<
    Vfs.Fixture["entries"][number],
    Vfs.FsFailure | Vfs.ImageFailure
  >
})

export const dualWatchCollection = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  Testing.collectChanges(2)(stream) satisfies Effect.Effect<Effect.Effect<Array<A>, E>, never, R | Scope.Scope>
