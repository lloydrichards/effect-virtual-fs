import type * as Vfs from "@effect-vfs/core/VirtualFileSystem"
import type { Crypto, Effect, FileSystem, Layer, PlatformError, Sink, Stream } from "effect"
import { MemoryFileSystem, TreeTransfer } from "../src/index.js"

export const dualAdapter = (volume: Vfs.Volume, fixture: Vfs.Fixture) => ({
  bind: MemoryFileSystem.bind()(volume) satisfies Effect.Effect<FileSystem.FileSystem, Vfs.VfsError>,
  layer: MemoryFileSystem.layerFromFixture()(fixture) satisfies Layer.Layer<
    FileSystem.FileSystem,
    Vfs.VfsError,
    Crypto.Crypto
  >
})

export const dualTransfer = (caller: Vfs.Caller, snapshot: Vfs.Snapshot, fs: FileSystem.FileSystem) => ({
  callerSource: TreeTransfer.fromCaller("/")(caller) satisfies Stream.Stream<
    TreeTransfer.Entry,
    TreeTransfer.TransferError | Vfs.VfsError
  >,
  snapshotSource: TreeTransfer.fromSnapshot("/")(snapshot) satisfies Stream.Stream<
    TreeTransfer.Entry,
    TreeTransfer.TransferError | Vfs.VfsError
  >,
  filesystemSource: TreeTransfer.fromFileSystem("/")(fs) satisfies Stream.Stream<
    TreeTransfer.Entry,
    TreeTransfer.TransferError | PlatformError.PlatformError
  >,
  callerSink: TreeTransfer.toCaller("/copy")(caller) satisfies Sink.Sink<
    TreeTransfer.TransferReport,
    TreeTransfer.Entry,
    never,
    TreeTransfer.TransferError | Vfs.VfsError
  >,
  filesystemSink: TreeTransfer.toFileSystem("/copy")(fs) satisfies Sink.Sink<
    TreeTransfer.TransferReport,
    TreeTransfer.Entry,
    never,
    TreeTransfer.TransferError | Vfs.VfsError | PlatformError.PlatformError
  >
})
