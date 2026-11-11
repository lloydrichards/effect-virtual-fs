import type * as Vfs from "@effect-vfs/core/VirtualFileSystem"
import type { Effect, Stream } from "effect"
import type * as Digest from "effect/crypto/Digest"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import * as TreeTransfer from "../src/TreeTransfer.js"

export const curriedImport = <E, R>(entries: Stream.Stream<TreeTransfer.Entry, E, R>) =>
  TreeTransfer.toVolume()(entries) satisfies Effect.Effect<
    Vfs.Volume,
    E | TreeTransfer.TransferError | Vfs.VfsError,
    R | Digest.Digest | SecureRandom.SecureRandom
  >
