---
type: Decision
title: JSON and base64 snapshots
description: Selects a versioned newline-delimited JSON snapshot encoding with base64 byte fields while keeping the logical image separate.
status: stable
tags: [snapshots, encoding, json]
sources:
  - id: images
    resource: ../../../packages/core/src/internal/image.ts
    title: Snapshot version 1 codec
generated: { by: claude/okf, at: "2026-09-26T14:30:00+02:00" }
---

# JSON and base64 snapshots

The versioned snapshot format is newline-delimited JSON with base64 byte fields: a header line, then one line per node, so a snapshot streams in either direction a line at a time. The live image uses the same framing with its runtime block on the first line and stays one document for its store. A length-prefixed binary framing would avoid base64 and its size cost but gives up greppable lines, and is left for a later version. The logical snapshot model remains separate from this encoding, and [snapshot-local identifiers](snapshot-local-file-identity.md "depends on") preserve relationships.

One node per line makes the tree's nodes inspectable and base64 preserves arbitrary bytes, at the cost of encoded size and temporary memory. The encoder is deterministic for a given volume value, but the choice does not promise byte-identical encodings of equivalent trees, set workload limits, or require a second production codec.
