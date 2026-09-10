---
type: Decision
title: Copying byte ownership
description: Copies mutable inputs at Effect execution and returns independent read buffers.
status: stable
tags: [bytes, ownership, effects]
generated: { by: codex/okf, at: "2026-09-10T00:00:00Z" }
---

# Copying byte ownership

Operations copy mutable byte inputs when their Effect executes, then operate on the owned copy. Mutation after consumption cannot change stored content. Reads return independent buffers, so callers must explicitly write back changes.

Constructing an Effect does not capture the input immediately: each execution consumes the input's value at that time. This prioritizes isolation over zero-copy performance and applies alongside [snapshot-local ownership](./snapshot-local-file-identity.md "complements").
