---
type: Decision
title: Strict snapshot version 1 decoding
description: Defines the strict snapshot-v1 tree as newline-delimited lines read one bounded line at a time, whose shape replaced the original record layout under the same version literal.
status: stable
tags: [snapshots, decoding, validation]
sources:
  - id: base64
    resource: ../../../packages/core/src/internal/canonicalBase64.ts
    title: Canonical base64 decoding
  - id: images
    resource: ../../../packages/core/src/internal/image.ts
    title: Strict version 1 decoding
  - id: tree
    resource: ../../../packages/core/src/internal/tree.ts
    title: The tree schema, its line reader and its budget meter
  - id: lines
    resource: ../../../packages/core/src/internal/lines.ts
    title: The fatal UTF-8 line reader with its line bound
  - id: metadata
    resource: ../../../packages/core/src/internal/metadata.ts
    title: Bounded timestamp decoding
generated: { by: claude/okf, at: "2026-09-26T14:30:00+02:00" }
---

# Strict snapshot version 1 decoding

Snapshot v1 is a tree written as newline-delimited JSON: a header line `{ format: "effect-vfs", version: 1 }`, then one line per reachable object in ascending inode order. Every line, the last included, ends in a newline; a missing final newline, a carriage return before a newline, an empty line, a byte-order mark and malformed UTF-8 fail `InvalidEncoding` at `field: "text"`. The reader splits bytes, not text, and copies a line that spans chunks into one buffer before decoding it with a fatal decoder, so a UTF-8 sequence split across chunks decodes whole; Effect's `Stream.decodeText` is not fatal and drops a truncated final sequence, and `Stream.splitLines` has no bound and also splits on a lone carriage return, so neither is used. A header of this format with another version fails `UnsupportedVersion` at `version`; a missing, repeated or late header fails `InvalidStructure` at `document`. Bytes an earlier release wrote are one document without a final newline, so they fail `InvalidEncoding` at `text`; the same document ending in a newline fails `InvalidStructure` at `document`. Node variants use `_tag` as their discriminator: a `directory` names its `parent` and `name` (the root is inode 1, its own parent, with an empty name), and a `file` or `symlink` lists its `links`, each a parent and a name. A file's `content` is a tagged union: `Inline` carries the bytes, and `Ref` is reserved for content-addressed storage and fails `UnsupportedVersion` at `nodes.<n>.content`. `kind` remains the semantic filesystem entry kind in metadata, snapshot changes and overlay changes; it is not a node discriminator. Metadata holds the owner, group, permission-bit `mode` and the four timestamps; link counts and sizes are derived.

Snapshot v1 accepts only canonical standard padded base64 and decimal bigint timestamp strings with at most 128 digits, within the inclusive range `[-(10^128 - 1), 10^128 - 1]`. Timestamp spellings such as leading zeros and `-0` are accepted and normalize to bigint values; snapshots emitted by the encoder use JavaScript's canonical `String(bigint)` spelling. It rejects whitespace, noncanonical padding or unused bits, plus signs, oversized timestamp spellings, and unknown fields at every schema-defined object level.

The graph rules are one reader shared with the live image: inode numbers ascend without repeats and stay at or below one less than the largest safe integer, every name is 1 to 255 bytes without NUL or slash and neither `.` nor `..`, every parent is a directory in the tree holding each name once, every directory reaches the root, every file and symbolic link has a name, and no symbolic link target holds a NUL. A broken rule fails `InvalidStructure` with the node's path as `field`, such as `nodes.1.links.0.parent`, where `n` in `nodes.n` counts node lines; a line of the wrong shape keeps `field: "document"`, failing `InvalidEncoding` when the failed check is an encoding check. The record, entry and decoded-byte budgets, counted from base64 lengths, are charged as each line ends and before the rules that line can break, so a line over a budget fails `LimitExceeded` before any of its names or its target is decoded, and a name's length is read from its base64 before the name is decoded; the rules that span nodes, a name's parent being a directory, each name held once and every directory reaching the root, are checked after the last line, since a name may point at a directory a later line holds.

The hostile-input promise is that input breaking a limit or a rule is rejected before the reader allocates more than one line of it. `maxLineBytes` bounds that line and is checked as the line grows, before the reader holds more of it than the bound, and the unfinished line is held in one buffer that doubles as it fills, so however finely it is chunked it costs at most twice the bound; it is optional on `DecodeLimits` and defaults to `maxEncodedBytes`, and since a file's line carries its whole content it also bounds the largest file. What the accepted lines add up to is bounded by the other budgets, and the decoded value is kept while the rest is read, so peak memory is bounded by the budgets plus one line, not by one line alone. The input budget is charged a line at a time as well: a line is refused at the byte where it first crosses its own bound or the input's, so the field a refusal names does not depend on how the input was chunked. The same budget meter runs in the encoder when `encodeSnapshot` is given limits, so an encode under limits fails exactly where a decode under them would, naming the same field.

Snapshot version 1 is still being solidified. Its version remains 1 while the schema is corrected, and snapshots written with earlier schema revisions are not guaranteed to decode. On 2026-09-26 its shape was replaced by the tree above under the same literal: blobs in the earlier record layout, with walk-order string ids and per-directory entry lists, no longer decode, and there is no second decoder or migration helper. Applications must regenerate persisted snapshots after an incompatible schema correction. The encoder writes a value's nodes and links in one deterministic order, so a decoded snapshot re-encodes to the same bytes, but decoding does not require canonical JSON whitespace or key order, and inode numbers are not stable across independently captured volumes. Deltas stay one JSON document: they hold only what changed, their public codec is a Schema between bytes, and applying one needs its base in memory anyway. It refines the [JSON/base64 format](json-and-base64-snapshots.md "refines").
