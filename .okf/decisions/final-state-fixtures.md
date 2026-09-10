---
type: Decision
title: Final-state fixtures
description: Defines fixtures as validated final trees with deterministic metadata rather than ordered command replays.
status: stable
tags: [fixtures, testing, validation]
generated: { by: codex/okf, at: "2026-09-10T00:00:00Z" }
---

# Final-state fixtures

Fixtures declare a completed filesystem tree with predictable metadata defaults. Declaration order cannot affect the result. The complete candidate is validated before a usable volume is exposed, so an invalid declaration cannot leak partial state.

Fixtures are not command replays and do not exercise creation order, permissions, or clock changes; tests needing those behaviors use normal filesystem operations. Hard-link references, topology, collisions, and resource limits are validated as a whole.
