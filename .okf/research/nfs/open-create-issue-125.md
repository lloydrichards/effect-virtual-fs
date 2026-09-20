---
type: Research Report
title: NFS OPEN creation for issue 125
description: Records the staged ordinary and guarded OPEN creation path and the atomic verifier gap for exclusive modes.
status: draft
tags: [nfs, open, creation, replay]
sources:
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/125
    title: Regular-file creation through writable OPEN
  - id: rfc
    resource: https://www.rfc-editor.org/rfc/rfc8881.html#section-18.16.3
    title: RFC 8881 OPEN description
  - id: core
    resource: ../../../packages/core/src/internal/virtualFileSystem.ts
    title: Atomic child open and staged volume mutation
  - id: adapter
    resource: ../../../packages/nfs/src/internal/export.ts
    title: NFS export child-open adapter
  - id: dispatcher
    resource: ../../../packages/nfs/src/internal/nfs4.ts
    title: OPEN decoder and dispatcher
  - id: tests
    resource: ../../../packages/nfs/test/NfsOpenCreate.test.ts
    title: Internal writable OPEN wire tests
generated: { by: codex/okf, at: 2026-09-20T10:18:00Z }
---

# NFS OPEN creation for issue 125

The internal writable handler supports `UNCHECKED4` and `GUARDED4` regular-file creation. It passes the mapped caller, parent reference, name, access, and supported size and mode attributes to `openChildReference`. Core creates and opens the exact object in one staged mutation. An expected-child guard checks the result of the NFS share and budget preflight against the actual child before mutation, including when a direct VFS caller changes the name between those steps. The adapter checks filehandle capacity before that mutation and retains the scoped handle for the NFS open state. The response uses the core directory transition and reports the attributes applied. Session replay returns the cached reply without repeating creation. Read-only exports still reject `OPEN4_CREATE` after structural checks.[^core][^adapter][^dispatcher][^tests]

For an existing `UNCHECKED4` file, the handler ignores create attributes except size zero, which truncates it. `GUARDED4` returns `EXIST` for an existing name. Unsupported create attributes return `ATTRNOTSUPP`. Tests cover both modes, owner upgrades, share denial before truncation, mapped-caller authority, filehandle and file-size capacity, rejected and unknown storage outcomes, interrupted admission, replay, and reopening a confirmed live image. These are internal preparation; the [accepted writable scope](../../decisions/nfs/writable-export-scope.md "constrained by") and durability qualification still gate a public writable export.[^rfc][^tests]

`EXCLUSIVE4` and `EXCLUSIVE4_1` remain open in issue #125. The current core settings have no exclusive verifier field or atomic match-on-existing result. The smallest required extension is a verifier stored in the same staged file candidate as the new object, with an atomic compare on a later open. `EXCLUSIVE4_1` must apply its allowed attributes in that candidate too. A separate lookup followed by a verifier write can leave a created file without its verifier after a failed commit.[^core][^rfc]

[^core]: `OpenChildReferenceSettings`, `Caller.openChildReference`, and the staged `coordinated` mutation.

[^adapter]: `NfsExport.openChild` holds the registry gate, checks capacity, and owns the handle scope.

[^dispatcher]: `decodeOperation` and `case "Open"` in `nfs4.ts`.

[^tests]: `NfsOpenCreate.test.ts` exercises the internal writable flag; the public server does not enable it.

[^rfc]: RFC 8881 Section 18.16.3 defines ordinary, guarded, and exclusive create behavior.
