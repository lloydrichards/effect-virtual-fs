// Build a detached v1 image from the trial transaction, including files pinned after unlink.
import { BytePath } from "@effect-vfs/effect-preview"
import { installStorage } from "@effect-vfs/effect-preview/durable-mkdir"
import * as P from "@effect-vfs/effect-preview/VirtualFileSystem"
import { Cause, Effect, Exit, Predicate } from "effect"
import type { CommitOutcome } from "../LiveVolume.js"
import { type CommitProvider, State } from "./model.js"
import { assemble, type NodeSpec } from "./volumeState.js"

export { cleanupError, resumeAllocator } from "@effect-vfs/effect-preview/durable-mkdir"

export const attachStore = (
  actor: Parameters<typeof installStorage>[0],
  initial: State.VolumeState,
  provider: CommitProvider<State.VolumeState>,
  freeze: () => void,
  frozen: () => boolean
) => {
  let committed = initial

  return installStorage(actor, (nodes, changed, next, operation) =>
    Effect.gen(function*() {
      const revision = committed.revision + 1n
      const links = new Map<bigint, Array<State.Link>>()
      const open = new Map<State.Ino, number>()
      const detached: Array<State.Directory> = []
      const specs: Array<NodeSpec> = []

      for (const node of nodes.values()) {
        if (node.kind !== "directory") continue

        for (const [name, entry] of node.entries.entries()) {
          const names = links.get(entry.object) ?? []
          names.push({ parent: State.Ino(Number(node.id)), name })
          links.set(entry.object, names)
        }
      }

      for (const node of nodes.values()) {
        const ino = State.Ino(Number(node.id))
        const names = links.get(node.id) ?? []

        const common = {
          ino,
          revision: changed.has(node.id) ? revision : State.getNode(committed, ino)!.revision,
          metadata: {
            mode: node.mode,
            uid: node.uid,
            gid: node.gid,
            atimeNs: node.atime,
            mtimeNs: node.mtime,
            ctimeNs: node.ctime,
            birthtimeNs: node.birthtime
          }
        }

        if (node.kind === "directory") {
          if (node.nlink === 0n) {
            // Keep the inode for its handle without adding its former name back to the tree.
            const prior = State.getNode(committed, ino)

            if (prior?.kind !== "directory") throw new Error("Missing prior directory")
            detached.push({
              ...prior,
              revision: common.revision,
              entries: new Map(),
              metadata: { ...prior.metadata, ...common.metadata, nlink: 0 }
            })
            open.set(ino, 1)
            continue
          }

          specs.push({
            ...common,
            kind: "directory",
            parent: State.Ino(Number(node.parent ?? node.id)),
            name: names[0]?.name ?? ""
          })
        } else if (node.kind === "file") {
          if (names.length === 0) open.set(ino, 1)
          specs.push({ ...common, kind: "file", links: names, data: node.data.slice() })
        } else {
          specs.push({ ...common, kind: "symlink", links: names, target: BytePath.toBytes(node.target) })
        }
      }

      const tree = assemble(specs)
      let inodes = tree.inodes

      for (const directory of detached) inodes = State.setNode(inodes, directory)
      const candidate = { ...tree, inodes, open, revision, nextInode: State.Ino(Number(next)) }

      const decision = yield* Effect.exit(
        Effect.suspend((): Effect.Effect<CommitOutcome, { readonly code: "StorageRejected" }> =>
          provider.commit(candidate)
        )
      )

      if (Exit.isSuccess(decision) && decision.value === "committed") {
        committed = candidate

        return
      }

      const rejected = Exit.isSuccess(decision)
        ? decision.value === "rejected" || Predicate.isTagged(decision.value, "Rejected")
        : decision.cause.reasons.length > 0 && decision.cause.reasons.every(Cause.isFailReason)

      if (!rejected || operation === "close") freeze()

      // eslint-disable-next-line effecttsgo/experimental-api-usage -- Scratch preview storage decision.
      return yield* new P.InvalidResource({ operation, reason: rejected ? "storageRejected" : "outcomeUnknown" })
    }), frozen)
}
