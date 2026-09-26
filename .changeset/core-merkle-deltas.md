---
"@effect-vfs/core": minor
---

Snapshot deltas change shape and their identities change value, so deltas encoded by earlier releases no longer decode or validate. A delta still encodes as `{ format: "effect-vfs-delta", version: 1 }`, but its body names the base and target identities and lists one `Added`, `Removed` or `Updated` change per path that differs, each carrying only the node it leaves.

- **Deltas follow the changes, not the tree.** A one-file edit in a 50,000-file tree is one change of about 500 bytes instead of every record in the target. A metadata-only change carries no payload, and a name joining a hard-link group points at the group's first path.
- **Identity is a Merkle tree.** A snapshot's identity covers each node's kind, metadata and payload, each directory's entries in name-byte order, and the hard-link groups. It keeps the name `effect-vfs-semantic-sha256-v1`, but its value differs from earlier releases for every snapshot.
- **Faster diff, inspect and apply.** Diffing skips subtrees whose digests agree. Inspecting and applying fold the changes over the base and digest only what they rewrote, so neither rebuilds the whole target.
- **Some limits count differently.** `maxDeltaRecords` counts changes. `maxOutputRecords` and `maxInheritedRecords` bound the applied target's nodes and the nodes it keeps from the base, and are checked when a delta is created or applied rather than when it is decoded. Every field name is unchanged.
- **Forged deltas fail by field.** A change the base does not bear out fails `InvalidStructure` at the change, such as `changes.2`, or at `changes.2.differences` for a forged difference list and at `parent` for a change under a missing directory. Changes that do not reach the target identity fail at `changes`. A broken rule in the document names the change the same way, such as `changes.1.node.to`.
- **Applying checks the target's own limits.** Inspecting or applying a delta fails `LimitExceeded` at `targetRecords` or `entries` when the target would exceed `maxTargetRecords` or `maxEntries`, as diffing to that target does.

### Migration

Compute stored deltas again from the snapshots they connect:

```ts
// before: bytes saved by an earlier release now fail to decode
const stale = Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes())(stored)

// after: diff the two snapshots again, then save the new bytes
const migrate = Effect.gen(function*() {
  const fresh = yield* Vfs.diffSnapshots(base, target)
  return yield* Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(fresh)
})
```
