---
type: Decision
title: Path input policy
description: Defines portable UTF-8 string and lossless byte paths without lexical or platform normalization.
status: stable
tags: [paths, encoding, portability]
generated: { by: codex/okf, at: "2026-09-10T00:00:00Z" }
---

# Path input policy

Well-formed string paths encode as UTF-8; lone surrogates, NUL, and empty paths fail. Byte paths preserve exact bytes but likewise reject NUL and emptiness. Slash is the separator on every runtime; backslash is ordinary data.

Lookup collapses repeated slashes and resolves dot and dot-dot, with root dot-dot staying at root, but preserves trailing-slash directory requirements. It performs no case folding, Unicode normalization, URI decoding, platform expansion, or premature lexical collapse. String output follows the [strict filename boundary](./strict-string-filename-boundary.md "constrained by").
