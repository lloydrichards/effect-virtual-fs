---
type: Contract
title: Snapshots and fixtures
description: Defines final-state fixtures and isolated snapshots over the volume value, encoded as strictly validated JSON/base64 trees.
status: stable
tags: [snapshots, fixtures, serialization]
sources:
  - resource: ../../packages/core/src/Snapshot.ts
    title: Public snapshot model and limits
  - resource: ../../packages/core/src/internal/image.ts
    title: Snapshot handle and codec
  - resource: ../../packages/core/src/internal/tree.ts
    title: The tree schema, its graph check, and the value converters
  - resource: ../../packages/core/src/internal/fixture.ts
    title: Fixture fold into a volume value
  - resource: ../../packages/core/test/Snapshot.test.ts
    title: Snapshot and restoration tests
  - resource: ../../packages/core/test/SnapshotDecoding.test.ts
    title: Hostile image decoding tests
  - resource: ../../packages/core/test/SnapshotRoundTrip.test.ts
    title: Round-trip, budget, hostile-input and inode-range pins through the public API
generated: { by: claude/okf, at: "2026-09-26T11:30:00+02:00" }
---

# Snapshots and fixtures

Fixtures declare a final filesystem state rather than an ordered mutation script. Construction folds the declared entries into a volume value that starts from an empty root, validating the complete graph before exposing a volume and preserving hard-link topology. Each directory lists its entries in the byte order of their names, so declaration order does not change what a fixture's volume lists.

A snapshot is the immutable volume value it was captured from, so capture takes no walk and copies nothing, and it stays opaque. Snapshots exclude live callers, handles, watches, and unreachable files: a volume restored from one keeps only what a name reaches. Version 1 images are strict JSON trees with base64 byte fields, one node per object in inode order, keyed by inode number. Decoding rejects noncanonical encodings, unknown schema fields, invalid graphs, and exhausted work budgets; a graph failure names the node by its issue path. Encoded and decoded byte budgets use exact `ByteSize.ByteSize` values; record and entry budgets remain numeric, where a record is a node and an entry is a name, and decoded bytes count names, file contents and link targets. The budgets are counted before the graph is checked, so a tree over a budget fails `LimitExceeded` before any name or target is decoded. A decoded snapshot re-encodes to the same bytes. Each restore creates independent storage, keeps the snapshot's inode numbers, and applies destination limits. A restored volume, whether from a captured or a decoded snapshot, and a reopened live image list each directory's entries in the byte order of their names, so the restore path does not change a listing; a running volume lists entries in the order it created them.

This contract depends on [byte ownership](byte-ownership.md "depends on") and implements [snapshot-local identity](../decisions/core/snapshot-local-file-identity.md "implements"), [JSON/base64 snapshots](../decisions/core/json-and-base64-snapshots.md "implements"), [final-state fixtures](../decisions/core/final-state-fixtures.md "implements"), and [strict snapshot decoding](../decisions/core/strict-snapshot-v1-decoding.md "implements").
