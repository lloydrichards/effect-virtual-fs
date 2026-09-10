---
type: Decision
title: Path base selection
description: Resolves absolute paths from volume root and relative paths from a validated caller or directory base.
status: stable
tags: [paths, callers, authority]
generated: { by: codex/okf, at: "2026-09-10T00:00:00Z" }
---

# Path base selection

Absolute paths resolve from the invoking caller's volume root. Any supplied directory base is ignored, including its liveness and volume association, while caller and path validation still apply.

Relative paths use the caller's cwd or a supplied base that must be live and from the same volume. Lookup always uses the invoking caller's permissions. Two-path operations select each operand independently. Directory bases are routes to directory identity, not sandbox boundaries. Input spelling follows the [path input policy](./path-input-policy.md "constrained by").
