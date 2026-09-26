---
"@effect-vfs/core": minor
"@effect-vfs/memory": patch
"@effect-vfs/persistence": patch
---

Snapshot and live image bytes now use newline-delimited JSON. Bytes saved by earlier releases no longer load, even though the format header still says `version: 1`. Regenerate stored checkpoints and live images from their source volumes or fixtures before upgrading:

```ts
const volume = yield * Vfs.fromFixture(fixture)
yield * checkpoints.save("baseline", yield * volume.snapshot)
```

`encodeSnapshotStream` and `decodeSnapshotSink` process snapshot bytes in chunks. Existing `encodeSnapshot` and `decodeSnapshot` calls still work with a single byte array:

```ts
const bytes = yield * Vfs.encodeSnapshot(snapshot, limits)
const decoded = yield * Stream.run(Stream.succeed(bytes), Vfs.decodeSnapshotSink(limits))
```

`DecodeLimits` gains `maxLineBytes`, which defaults to `maxEncodedBytes`. `encodeSnapshot` now checks the same limits as decoding. Snapshot entries can also be read with `snapshotEntries(snapshot, root)` without restoring a volume.
