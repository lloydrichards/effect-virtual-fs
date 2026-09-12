---
type: Decision
title: Optional total path limit
description: Makes total path byte limits opt-in per volume and applies them before collapsing and during symlink expansion.
status: stable
tags: [paths, limits, configuration]
generated: { by: codex/okf, at: "2026-09-12T00:00:00+02:00" }
---

# Optional total path limit

Volumes may configure positive `ByteSize.ByteSize` `maxPathBytes`; omission means no configured total-path cap. The limit counts encoded path bytes and separators before collapsing, and each target-plus-suffix formed during symlink expansion. Each operand is checked independently and over-limit mutation fails `PathTooLong` before publication.

Relative lookup does not prepend absolute ancestry. BytePath remains volume-independent and is checked on use. This [supersedes](./provisional-path-limits.md "supersedes") the rejected fixed 4096-byte direction, not the provisional component or traversal limits.
