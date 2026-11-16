// Compiled inside the disposable core checkout. Only single-directory candidates enter this experiment.
import { type Candidate, makeCallerTrial } from "@effect-vfs/effect-preview/durable-mkdir"
import type * as P from "@effect-vfs/effect-preview/VirtualFileSystem"
import { Effect, Predicate } from "effect"
import * as Hex from "effect/encoding/Hex"
import { type CommitProvider, Errors, State } from "./model.js"

export { resumeAllocator } from "@effect-vfs/effect-preview/durable-mkdir"

export const makeLiveMkdir = (initial: State.VolumeState, provider: CommitProvider<State.VolumeState>) => {
  let committed = initial

  const offer = Effect.fnUntraced(function*(candidate: Candidate) {
    const parent = State.getNode(committed, State.Ino(Number(candidate.parent.objectNumber)))

    if (parent?.kind !== "directory") throw new Error("Missing committed mkdir parent")
    const name = Hex.encode(candidate.name)
    const ino = State.Ino(Number(candidate.child.objectNumber))
    const revision = committed.revision + 1n

    const metadata = (record: Candidate["child"]) => ({
      kind: "directory" as const,
      ino: record.objectNumber,
      nlink: Number(record.nlink),
      size: 0n,
      uid: record.uid,
      gid: record.gid,
      mode: record.mode,
      atimeNs: record.atime,
      mtimeNs: record.mtime,
      ctimeNs: record.ctime,
      birthtimeNs: record.birthtime
    })

    const inodes = State.setNode(committed.inodes, {
      ...parent,
      entries: new Map(parent.entries).set(name, ino),
      metadata: metadata(candidate.parent),
      revision
    })

    const state: State.VolumeState = {
      ...committed,
      inodes: State.setNode(inodes, {
        kind: "directory",
        ino,
        parent: parent.ino,
        name,
        entries: new Map(),
        metadata: metadata(candidate.child),
        revision
      }),
      entries: committed.entries + 1,
      nextInode: State.Ino(Number(candidate.nextObject)),
      revision
    }

    const outcome = yield* provider.commit(state).pipe(Effect.orElseSucceed(() => "rejected" as const))

    if (outcome === "committed") committed = state

    return Predicate.isTagged(outcome, "Rejected") ? "rejected" : outcome
  })

  // eslint-disable-next-line effecttsgo/experimental-api-usage -- Compile against the trial preview caller.
  return (actor: P.VirtualFileSystem, target: P.Path, options: P.MkdirOptions) =>
    makeCallerTrial(actor, offer).mkdir(target, options).pipe(
      Effect.mapError((e) =>
        Predicate.isTagged(e, "StorageRejected") || Predicate.isTagged(e, "VolumeUnavailable")
          ? Errors.fsFailure(e._tag, "mkdir")
          : e
      )
    )
}
