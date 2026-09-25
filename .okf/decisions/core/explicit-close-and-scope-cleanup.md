---
type: Decision
title: Explicit close and scope cleanup
description: Makes repeated explicit close fail while automatic scope cleanup remains safe after early release.
status: stable
tags: [resources, lifetimes, scope]
sources:
  - id: core
    resource: ../../../packages/core/src/VirtualFileSystem.ts
    title: Handle close and scoped acquisition
  - id: engine
    resource: ../../../packages/core/src/internal/virtualFileSystem.ts
    title: Handle scopes, shared release, and cleanup finalizers
  - id: tests
    resource: ../../../packages/core/test/HandleLifecycle.test.ts
    title: Handle lifecycle races, busy closes, and interrupted cleanup
generated: { by: codex/okf, at: "2026-09-25T00:00:00Z" }
---

# Explicit close and scope cleanup

Explicitly closing a live file or directory handle releases it; a repeated explicit close fails with the invalid-handle error. Automatic scope cleanup tolerates prior explicit release through a private finalization path. References and final storage reclamation occur exactly once.

Each handle owns a scope forked from the scope that opened it, and explicit close and scope cleanup run the same release. An open whose scope closes before it publishes is interrupted and releases what it acquired; one whose commit already published keeps its effect, so an interrupted exclusive create still leaves the file. An explicit close that was interrupted while waiting, or refused with `VolumeBusy`, leaves the handle open for a retry. A close whose commit fails still releases the handle and reports the failure. Scope cleanup is uninterruptible and does not need admission, so a busy volume or an interrupted scope close still releases the handle.[^engine][^tests]

The lifetime rule remains current, while [reusable capability effects](reusable-capability-effects.md "syntax superseded by") changed `close()` from callable syntax to an Effect property.

[^engine]: `acquireHandle`, `closeFile`, and the file and directory finalizers implement these rules.

[^tests]: The lifecycle suite races opens and closes against scope closes, fiber interruption, busy admission, and rejected commits.
