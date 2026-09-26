---
"@effect-vfs/core": minor
---

Snapshot and live image bytes change shape, and bytes written by earlier releases no longer decode. A snapshot still encodes as `{ format: "effect-vfs", version: 1 }`, but its body is now one node per file, directory or symbolic link in inode order, each naming the directory entries that reach it, with file content as a tagged `Inline` value. `CheckpointStore` rows and `LiveImageStore` images saved before this release fail to load with `InvalidStructure`; there is no migration helper.

- **Capture copies nothing.** `volume.snapshot` and an overlay's `capture()` share the volume's immutable value instead of walking and encoding it, and `fromSnapshot` and `makeOverlay` start from that value, keeping only what a name reaches.
- **Inode numbers survive a restore.** A volume restored from a captured or decoded snapshot reports the inode numbers the snapshot holds, and allocates new ones above them.
- **Decode errors name the node.** A snapshot that breaks a graph rule fails `InvalidStructure` with the node's path as `field`, such as `nodes.1.links.0.parent`; a malformed document still names `document`. The decode budgets are checked first, so a snapshot over one fails `LimitExceeded` even when its graph is also broken.
- **Restored volumes list in name order.** A fixture's volume, a volume restored from a snapshot, decoded or not, and a reopened live image list each directory's entries in the byte order of their names, whatever order they were declared or created in.

### Migration

Regenerate stored snapshots and live images from the volumes or fixtures that produced them:

```ts
// before: bytes saved by an earlier release
const restored = yield * Vfs.decodeSnapshot(stored, limits) // now fails with InvalidStructure

// after: rebuild the volume, then save its snapshot again
const volume = yield * Vfs.fromFixture(fixture)
yield * checkpoints.save("baseline", yield * volume.snapshot)
```
