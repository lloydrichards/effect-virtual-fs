import type { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Effect, Stream } from "effect"
import * as TreeTransfer from "../../src/TreeTransfer.js"

/** The transfer entries under `root` in a snapshot of `volume`, in stream order. */
export const snapshotEntries = (volume: Vfs.Volume, root: string) =>
  Effect.flatMap(volume.snapshot, (snapshot) => Stream.runCollect(TreeTransfer.fromSnapshot(snapshot, root)))
