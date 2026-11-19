---
"@effect-vfs/core": minor
---

Merge two overlays so edits to a file follow its rename. When two overlays move the same file to different destinations, the merge reports one conflict covering the original path and both destinations.

Start both overlays from the same snapshot. Capture them after editing, then merge and apply the delta if there are no conflicts.

```ts
const handoff = Effect.gen(function*() {
  const ours = yield* Vfs.captureOverlayForMerge(leftOverlay)
  const theirs = yield* Vfs.captureOverlayForMerge(rightOverlay)
  const result = yield* Vfs.mergeOverlayCaptures(base, ours, theirs)

  if (result.conflicts.length !== 0) return { ours, theirs, conflicts: result.conflicts }

  return yield* Vfs.applySnapshotDelta(base, result.delta)
})
```

Keep the captures in the same process to resolve conflicts. Retry with the same base and captures in the same order. Pass every choice so far in `resolutions`. Each choice pairs a returned conflict `key` with `take` set to `"ours"`, `"theirs"`, or `"base"`.
