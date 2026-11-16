---
type: Decision
title: Final-state fixtures
description: Defines fixtures as validated final trees with deterministic metadata rather than ordered command replays.
status: stable
tags: [fixtures, testing, validation]
sources:
  - id: fixtures
    resource: ../../../packages/core/src/internal/fixture.ts
    title: Fixture validation and construction
generated: { by: codex/okf-dream, at: 2026-11-16T22:02:33Z }
---

# Final-state fixtures

Fixtures declare a completed filesystem tree with predictable metadata defaults. Declaration order cannot affect the result. The complete candidate is validated before a usable volume is exposed, so an invalid declaration cannot leak partial state.

Fixtures are not command replays and do not exercise creation order, permissions, or clock changes; tests needing those behaviors use normal filesystem operations. Hard-link references, topology, collisions, and resource limits are validated as a whole.
