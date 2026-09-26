---
"@effect-vfs/core": minor
"@effect-vfs/memory": patch
"@effect-vfs/persistence": patch
---

Snapshot and live image bytes are now newline-delimited JSON, so bytes written by earlier releases no longer decode: a header line `{"format":"effect-vfs","version":1}`, then one line per node in inode order, every line ending in a newline. Stored checkpoints and live images fail to load with `InvalidEncoding` at `text`, since an earlier release wrote one document without a final newline; regenerate them as for the previous format change.

- **Streaming codecs.** `encodeSnapshotStream` emits the encoding as chunks, and `decodeSnapshotSink(limits)` decodes chunks split anywhere; `encodeSnapshot` and `decodeSnapshot` are the same codecs over one array.
- **One line at a time.** Decoding checks each line as it ends and refuses input that breaks a limit or a rule before holding more than one line of it, and an unfinished line costs at most twice its bound however finely it is chunked. A line is refused at the byte where it first crosses `maxLineBytes` or `maxEncodedBytes`, so the field a refusal names does not depend on chunking. `DecodeLimits` gains an optional `maxLineBytes`, defaulting to `maxEncodedBytes`. A missing final newline, a carriage return, an empty line, a byte-order mark and malformed UTF-8 fail `InvalidEncoding`.
- **Encoding under limits.** `encodeSnapshot(snapshot, limits)` fails with `LimitExceeded` wherever `decodeSnapshot` would under the same limits. `CheckpointStore.save` uses it and no longer decodes what it saves.
- **Snapshot entries.** `snapshotEntries(snapshot, root)` streams a snapshot's tree as fixture entries without restoring a volume, and `TreeTransfer.fromSnapshot` now walks it.

```ts
const bytes = yield * Vfs.encodeSnapshot(snapshot, limits)
const decoded = yield * Stream.run(Stream.succeed(bytes), Vfs.decodeSnapshotSink(limits))
```
