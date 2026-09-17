---
type: Decision
title: Strict snapshot version 1 decoding
description: Defines the strict snapshot-v1 schema while its record and validation rules are being solidified.
status: stable
tags: [snapshots, decoding, validation]
sources:
  - id: base64
    resource: ../../../packages/core/src/internal/canonicalBase64.ts
    title: Canonical base64 decoding
  - id: images
    resource: ../../../packages/core/src/internal/image.ts
    title: Strict version 1 decoding
  - id: metadata
    resource: ../../../packages/core/src/internal/metadata.ts
    title: Bounded timestamp decoding
generated: { by: codex/okf, at: "2026-09-18T06:04:59Z" }
---

# Strict snapshot version 1 decoding

Snapshot v1 record variants use `_tag` as their discriminator. `kind` remains the semantic filesystem entry kind in metadata, snapshot changes and overlay changes; it is not a snapshot-record discriminator.

Snapshot v1 accepts only canonical standard padded base64 and decimal bigint timestamp strings with at most 128 digits, within the inclusive range `[-(10^128 - 1), 10^128 - 1]`. Timestamp spellings such as leading zeros and `-0` are accepted and normalize to bigint values; snapshots emitted by the encoder use JavaScript's canonical `String(bigint)` spelling. It rejects whitespace, noncanonical padding or unused bits, plus signs, oversized timestamp spellings, and unknown fields at every schema-defined object level.

Snapshot version 1 is still being solidified. Its version remains 1 while the schema is corrected, and snapshots written with earlier schema revisions are not guaranteed to decode. Applications must regenerate persisted snapshots after an incompatible schema correction. This strictness does not require canonical JSON whitespace, key or record order, deterministic image IDs, or stable hashes. It refines the [JSON/base64 format](json-and-base64-snapshots.md "refines").
