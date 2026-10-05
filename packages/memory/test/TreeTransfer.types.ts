import type * as Vfs from "@effect-vfs/core/VirtualFileSystem"
import type { Crypto, Effect, Stream } from "effect"
import * as TreeTransfer from "../src/TreeTransfer.js"

export const curriedImport = <E, R>(entries: Stream.Stream<TreeTransfer.Entry, E, R>) =>
  TreeTransfer.toVolume()(entries) satisfies Effect.Effect<
    Vfs.Volume,
    E | TreeTransfer.TransferError | Vfs.VfsError,
    R | Crypto.Crypto
  >
