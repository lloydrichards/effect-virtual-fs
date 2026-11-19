---
"@effect-vfs/core": minor
---

Merge overlay captures so edits follow file renames. When two overlays move the same file to different destinations, the merge reports one conflict covering the original path and both destinations.

Create both overlays from the same base. After editing them, capture each overlay and merge the captures:

```ts
const handoff = Effect.gen(function*() {
  const ours = yield* Vfs.captureOverlayForMerge(leftOverlay)
  const theirs = yield* Vfs.captureOverlayForMerge(rightOverlay)
  const result = yield* Vfs.mergeOverlayCaptures(base, ours, theirs)

  if (result.conflicts.length !== 0) return { ours, theirs, conflicts: result.conflicts }

  return yield* Vfs.applySnapshotDelta(base, result.delta)
})
```

Keep the captures if you need to resolve conflicts. Retry with the same captures and pass `resolutions: [{ key, take }]` in the options. Use the returned conflict key and choose `"ours"`, `"theirs"`, or `"base"`. Captures are process-local. Include all previous choices on each retry.
