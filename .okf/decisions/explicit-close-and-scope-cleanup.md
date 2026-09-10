---
type: Decision
title: Explicit close and scope cleanup
description: Makes repeated explicit close fail while automatic scope cleanup remains safe after early release.
status: stable
tags: [resources, lifetimes, scope]
generated: { by: codex/okf, at: "2026-09-10T00:00:00Z" }
---

# Explicit close and scope cleanup

Explicitly closing a live file or directory handle releases it; a repeated explicit close fails with the invalid-handle error. Automatic scope cleanup tolerates prior explicit release through a private finalization path. References and final storage reclamation occur exactly once.

The lifetime rule remains current, while [reusable capability effects](./reusable-capability-effects.md "syntax superseded by") changed `close()` from callable syntax to an Effect property.
