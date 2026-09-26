---
type: Decision
title: Strict snapshot version 1 decoding
description: Defines the strict snapshot-v1 tree schema, whose shape replaced the original record layout under the same version literal.
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
    title: The tree schema and its graph check
  - id: metadata
    resource: ../../../packages/core/src/internal/metadata.ts
    title: Bounded timestamp decoding
generated: { by: claude/okf, at: "2026-09-26T11:30:00+02:00" }
---

# Strict snapshot version 1 decoding

Snapshot v1 is a tree: `{ format: "effect-vfs", version: 1, nodes }`, one node per reachable object in ascending inode order. Node variants use `_tag` as their discriminator: a `directory` names its `parent` and `name` (the root is inode 1, its own parent, with an empty name), and a `file` or `symlink` lists its `links`, each a parent and a name. A file's `content` is a tagged union: `Inline` carries the bytes, and `Ref` is reserved for content-addressed storage and fails `UnsupportedVersion` at `nodes.<n>.content`. `kind` remains the semantic filesystem entry kind in metadata, snapshot changes and overlay changes; it is not a node discriminator. Metadata holds the owner, group, permission-bit `mode` and the four timestamps; link counts and sizes are derived.

Snapshot v1 accepts only canonical standard padded base64 and decimal bigint timestamp strings with at most 128 digits, within the inclusive range `[-(10^128 - 1), 10^128 - 1]`. Timestamp spellings such as leading zeros and `-0` are accepted and normalize to bigint values; snapshots emitted by the encoder use JavaScript's canonical `String(bigint)` spelling. It rejects whitespace, noncanonical padding or unused bits, plus signs, oversized timestamp spellings, and unknown fields at every schema-defined object level.

The graph rules run once, as one check over the decoded tree: inode numbers ascend without repeats and stay at or below one less than the largest safe integer, every name is 1 to 255 bytes without NUL or slash and neither `.` nor `..`, every parent is a directory in the tree holding each name once, every directory reaches the root, every file and symbolic link has a name, and no symbolic link target holds a NUL. A broken rule fails `InvalidStructure` with the node's issue path as `field`, such as `nodes.1.links.0.parent`; a document of the wrong shape keeps `field: "document"`, failing `InvalidEncoding` when the failed check is an encoding check. The record, entry and decoded-byte budgets are counted from base64 lengths once the shape has decoded and before the graph check, so a tree over a budget fails `LimitExceeded` even when it also breaks a graph rule, and no name, target or content is decoded before the budgets accept it. The graph check reads a name's length from its base64 before decoding the name.

Snapshot version 1 is still being solidified. Its version remains 1 while the schema is corrected, and snapshots written with earlier schema revisions are not guaranteed to decode. On 2026-09-26 its shape was replaced by the tree above under the same literal: blobs in the earlier record layout, with walk-order string ids and per-directory entry lists, no longer decode, and there is no second decoder or migration helper. Applications must regenerate persisted snapshots after an incompatible schema correction. The encoder writes a value's nodes and links in one deterministic order, so a decoded snapshot re-encodes to the same bytes, but decoding does not require canonical JSON whitespace or key order, and inode numbers are not stable across independently captured volumes. It refines the [JSON/base64 format](json-and-base64-snapshots.md "refines").
