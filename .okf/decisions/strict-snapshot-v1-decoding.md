---
type: Decision
title: Strict snapshot version 1 decoding
description: Requires canonical base64 and integer spelling and rejects unknown fields throughout snapshot v1.
status: stable
tags: [snapshots, decoding, validation]
generated: { by: codex/okf, at: "2026-09-10T00:00:00Z" }
---

# Strict snapshot version 1 decoding

Snapshot v1 accepts only canonical standard padded base64 and canonical decimal integer strings. It rejects whitespace, noncanonical padding or unused bits, plus signs, leading zeros, `-0`, and unknown fields at every schema-defined object level.

New fields require a new format version rather than silent v1 acceptance. This strictness does not require canonical JSON whitespace, key or record order, deterministic image IDs, or stable hashes. It refines the [JSON/base64 format](./json-and-base64-snapshots.md "refines").
