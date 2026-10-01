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
    resource: ../../../packages/core/test/FileHandle.test.ts
    title: Handle lifecycle races, busy closes, and interrupted cleanup
  - id: registry
    resource: ../../../packages/core/src/internal/tokenRegistry.ts
    title: Handle lifecycle, acquisition and one release operation
  - id: registry-tests
    resource: ../../../packages/core/test/internal/tokenRegistry.test.ts
    title: Direct lifecycle transition tests
generated: { by: codex/okf, at: "2026-10-01T12:45:00Z" }
---

# Explicit close and scope cleanup

Explicitly closing a live file or directory handle releases it; a repeated explicit close fails with the invalid-handle error. Automatic scope cleanup tolerates prior explicit release through a private finalization path. References and final storage reclamation occur exactly once.

The token registry owns the lifecycle and scope bookkeeping, while engine callbacks own inode retention, reclamation, and commit installation. Each handle owns a scope forked from the scope that opened it, and explicit close and scope cleanup run the same release. An open whose scope closes before it publishes is interrupted and releases what it acquired; one whose commit already published keeps its effect, so an interrupted exclusive create still leaves the file. An explicit close that was interrupted while waiting, or refused with `VolumeBusy`, leaves the handle open for a retry. A close whose commit fails still releases the handle and reports the failure. Scope cleanup is uninterruptible and does not need admission, so a busy volume or an interrupted scope close still releases the handle.[^engine][^tests]

Changed file and detached-directory cleanup candidates pass through the required commit provider while the volume is available, including cleanup that bypasses full admission. Confirmed cleanup installs the release immediately. A rejected, uncertain, or preparation-failed cleanup releases local resources and stops volume access. Explicit close reports its storage failure; automatic cleanup suppresses it. Once unavailable, cleanup releases locally without offering another storage commit. Directory close keeps its uninterruptible, admission-free behavior.

The lifecycle tags are `acquiring`, `open`, `releasedPendingCommit`, and `closed`. Finalization before acquisition publication leaves `releasedPendingCommit` with no inode. Late publication records the inode in that state, and rerunning the finalizer releases it. A failed acquisition becomes `closed` once coordination and cleanup finish without a retained inode. Closing a published handle marks it `closed` through the engine's release-publication callback.[^registry]

The lifetime rule remains current, while [reusable capability effects](reusable-capability-effects.md "syntax superseded by") changed `close()` from callable syntax to an Effect property.

[^engine]: `closeFile`, `releaseFileInode`, and the directory cleanup callbacks supply coordination, reclamation and commit behavior to the registry.

[^tests]: The lifecycle suite races opens and closes against scope closes, fiber interruption, busy admission, and rejected commits.

[^registry]: `tokenRegistry.ts` owns `acquire`, `release`, `finalize`, and the lifecycle union. Its direct tests exercise cleanup before publication and staged release; `FileHandle.test.ts` retains the engine race and failure coverage.
