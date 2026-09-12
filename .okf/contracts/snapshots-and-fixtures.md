---
type: Contract
title: Snapshots and fixtures
description: Defines final-state fixtures and isolated, strictly validated JSON/base64 snapshot images.
status: stable
tags: [snapshots, fixtures, serialization]
sources:
  - resource: ../../packages/core/src/Snapshot.ts
    title: Public snapshot model and limits
  - resource: ../../packages/core/src/internal/image.ts
    title: Snapshot image codec
  - resource: ../../packages/core/test/Snapshot.test.ts
    title: Snapshot and restoration tests
  - resource: ../../packages/core/test/SnapshotDecoding.test.ts
    title: Hostile image decoding tests
generated: { by: codex/okf, at: 2026-09-12T11:20:00Z }
---

# Snapshots and fixtures

Fixtures declare a final filesystem state rather than an ordered mutation script. Construction validates the complete graph before exposing a volume and preserves hard-link topology.

Snapshots own their contents and exclude live callers, handles, watches, and unreachable files. Version 1 images use strict JSON with base64 byte fields and image-local record identity. Decoding rejects noncanonical encodings, unknown schema fields, invalid graphs, and exhausted work budgets. Encoded and decoded byte budgets use exact `ByteSize.ByteSize` values; record and entry budgets remain numeric. Each restore creates independent storage and applies destination limits.

This contract depends on [byte ownership](/contracts/byte-ownership.md "depends on") and implements [snapshot-local identity](/decisions/snapshot-local-file-identity.md "implements"), [JSON/base64 snapshots](/decisions/json-and-base64-snapshots.md "implements"), [final-state fixtures](/decisions/final-state-fixtures.md "implements"), and [strict snapshot decoding](/decisions/strict-snapshot-v1-decoding.md "implements").
