---
type: Decision
title: Strict string filename boundary
description: Rejects lossy filename conversion while preserving exact byte-oriented access.
status: stable
tags: [paths, encoding, bytes]
generated: { by: codex/okf, at: "2026-09-10T00:00:00Z" }
---

# Strict string filename boundary

Core preserves raw filename bytes. A string operation that must return an unrepresentable filename fails with a structured error instead of replacing bytes, skipping entries, or inventing escapes. Raw-byte operations preserve and address every distinct name.

Valid named siblings remain accessible, but a string listing fails rather than returning an incomplete or lossy list. This output policy complements the [path input policy](./path-input-policy.md "complements").
