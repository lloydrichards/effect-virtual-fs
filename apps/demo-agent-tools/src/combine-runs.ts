import { BytePath, SnapshotDelta, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Effect, Predicate, Schema } from "effect"
import { projectRoot } from "./workspace.js"

const source = "plans/draft.md"

const sourcePath = projectRoot + "/" + source

const prefix = projectRoot + "/"

const limits = SnapshotDelta.SnapshotDeltaLimits.constrained

const encodeDelta = Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes(limits))

const unsupported = (message: string) =>
  Effect.fail({ code: "UnsupportedRunCombination", operation: "combine_runs", message })

const rootedCaller = Effect.fnUntraced(function*(snapshot: Vfs.Snapshot) {
  const volume = yield* Vfs.fromSnapshot(snapshot)

  return yield* (yield* volume.caller()).withRoot(projectRoot)
})

const describeRun = Effect.fnUntraced(function*(
  base: Vfs.Snapshot,
  capture: Vfs.OverlayCapture,
  delta: SnapshotDelta.SnapshotDelta
) {
  const [change] = capture.changes

  if (
    capture.changes.length === 1 && Predicate.isTagged(change, "Updated") && change.kind === "file" &&
    change.differences.length === 1 && change.differences.includes("content") &&
    (yield* BytePath.toString(change.path)) === sourcePath
  ) {
    return { kind: "edit" as const, snapshot: capture.snapshot }
  }

  if (
    capture.changes.length === 1 && Predicate.isTagged(change, "Renamed") && change.kind === "file" &&
    change.differences.length === 0 && (yield* BytePath.toString(change.from)) === sourcePath
  ) {
    const destination = yield* BytePath.toString(change.to)

    if (!destination.startsWith(prefix)) return yield* unsupported("Both paths must be in the project.")

    // The raw capture proves lineage. The delta must independently show that the destination was absent.
    const changes = yield* Vfs.inspectSnapshotDelta(base, delta, {}, limits)
    const added = changes.find(Predicate.isTagged("Added"))

    if (
      changes.length === 2 && changes.some(Predicate.isTagged("Removed")) && added &&
      (yield* BytePath.toString(added.path)) === destination
    ) {
      return { kind: "rename" as const, snapshot: capture.snapshot, destination: destination.slice(prefix.length) }
    }
  }

  return yield* unsupported("Each run must only edit the seeded draft or rename it to a new path without editing it.")
})

// Callers supply only the immutable captures retained by this Code Mode instance, all from its one base.
export const combineRuns = Effect.fnUntraced(function*(
  base: Vfs.Snapshot,
  oursCapture: Vfs.OverlayCapture,
  theirsCapture: Vfs.OverlayCapture,
  take: "ours" | "theirs" | "base" | undefined
) {
  const oursDelta = yield* Vfs.diffSnapshots(base, oursCapture.snapshot, limits)
  const theirsDelta = yield* Vfs.diffSnapshots(base, theirsCapture.snapshot, limits)
  const ours = yield* describeRun(base, oursCapture, oursDelta)
  const theirs = yield* describeRun(base, theirsCapture, theirsDelta)
  const baseline = yield* Vfs.mergeSnapshotDeltas(base, oursDelta, theirsDelta, { limits })
  const baselineChanges = yield* Vfs.inspectSnapshotDelta(base, baseline.delta, {}, limits)

  let target = base
  let path = source
  let conflict = null

  if (ours.kind === "rename" && theirs.kind === "rename") {
    if (ours.destination === theirs.destination) {
      return yield* unsupported("The two renames must choose different destinations.")
    }

    if (take === "ours" || take === "theirs") {
      const selected = take === "ours" ? ours : theirs
      target = selected.snapshot
      path = selected.destination
    } else if (take === undefined) {
      conflict = { source, ours: ours.destination, theirs: theirs.destination }
    }
  } else {
    if (take !== undefined) return yield* unsupported("Choose a side only when the two renames conflict.")

    const moved = ours.kind === "rename" ? ours : theirs
    const edited = ours.kind === "edit" ? ours : theirs

    if (moved.kind !== "rename" || edited.kind !== "edit") {
      return yield* unsupported("The pilot needs one rename and one edit, or two different renames.")
    }

    const editor = yield* rootedCaller(edited.snapshot)
    const bytes = yield* editor.readFile(source)
    const volume = yield* Vfs.fromSnapshot(moved.snapshot)
    const destination = yield* (yield* volume.caller()).withRoot(projectRoot)
    yield* destination.writeFile(moved.destination, bytes, { access: "write", truncate: true })
    target = yield* volume.snapshot
    path = moved.destination
  }

  const delta = yield* Vfs.diffSnapshots(base, target, limits)
  const applied = yield* Vfs.applySnapshotDelta(base, delta, limits)
  const encoded = yield* encodeDelta(delta)

  const caller = yield* rootedCaller(applied)
  const content = yield* caller.readFile(path)

  return {
    entry: { path, content: new TextDecoder("utf-8", { ignoreBOM: true }).decode(content) },
    conflict,
    delta: new TextDecoder().decode(encoded),
    baseline: {
      changes: yield* Effect.forEach(
        baselineChanges,
        (change) =>
          BytePath.toString(change.path).pipe(Effect.map((absolute) => ({
            kind: change._tag,
            path: absolute.slice(prefix.length)
          })))
      ),
      conflicts: yield* Effect.forEach(
        baseline.conflicts,
        (conflict) =>
          BytePath.toString(conflict.path).pipe(Effect.map((absolute) => ({
            reason: conflict.reason,
            path: absolute.slice(prefix.length)
          })))
      )
    }
  }
})
