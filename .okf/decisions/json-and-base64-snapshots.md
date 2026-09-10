---
type: Decision
title: JSON and base64 snapshots
description: Selects a versioned JSON snapshot encoding with base64 byte fields while keeping the logical image separate.
status: stable
tags: [snapshots, encoding, json]
generated: { by: codex/okf, at: "2026-09-10T00:00:00Z" }
---

# JSON and base64 snapshots

The initial versioned snapshot format is JSON with base64 byte fields. The logical snapshot model remains separate from this encoding, and [snapshot-local identifiers](./snapshot-local-file-identity.md "depends on") preserve relationships.

JSON makes record structure inspectable and base64 preserves arbitrary bytes, at the cost of encoded size and temporary memory. The choice does not promise deterministic bytes, set workload limits, or require a second production codec.
