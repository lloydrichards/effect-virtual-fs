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
  - id: umask-rfc
    resource: https://www.rfc-editor.org/rfc/rfc8275.html
    title: NFS umask behavior
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
  - id: watch-tests
    resource: ../../../packages/core/test/Watch.test.ts
    title: Core watch event tests
generated: { by: codex/okf, at: 2026-09-20T10:55:46Z }
---

# NFS OPEN creation for issue 125

The internal writable handler supports `UNCHECKED4` and `GUARDED4` regular-file creation. It passes the mapped caller, parent reference, name, access, and supported size and mode attributes to `openChildReference`. Core creates and opens the exact object in one staged mutation. An expected-child guard checks the result of the NFS share and budget preflight against the actual child before mutation, including when a direct VFS caller changes the name between those steps. The adapter checks filehandle capacity before that mutation and retains the scoped handle for the NFS open state. The response uses the core directory transition and reports the attributes applied. Session replay returns the cached reply without repeating creation. Read-only exports still reject `OPEN4_CREATE` after structural checks.[^core][^adapter][^dispatcher][^tests]

For an existing `UNCHECKED4` file, the handler ignores create attributes except size zero, which truncates it; this includes unsupported attributes and invalid mode values. `GUARDED4` returns `EXIST` for an existing name before attribute support checks. New files reject unsupported attributes with `ATTRNOTSUPP`. An explicit NFS mode skips the caller's umask because the client has already applied one; core's permission policy still applies. Core's ordinary caller path still applies its configured umask. Filehandle admission permits an existing registered reference at capacity. Initial file sizing publishes one Create event without an earlier Update. Tests cover these boundaries alongside owner upgrades, share denial before truncation, mapped-caller authority, filehandle and file-size capacity, rejected and unknown storage outcomes, interrupted admission, replay, and reopening a confirmed live image. These are internal preparation; the [accepted writable scope](../../decisions/nfs/writable-export-scope.md "constrained by") and durability qualification still gate a public writable export.[^rfc][^umask-rfc][^tests][^watch-tests]

`EXCLUSIVE4` and `EXCLUSIVE4_1` remain open in issue #125. The current core settings have no exclusive verifier field or atomic match-on-existing result. The smallest required extension is a verifier stored in the same staged file candidate as the new object, with an atomic compare on a later open. `EXCLUSIVE4_1` must apply its allowed attributes in that candidate too. A separate lookup followed by a verifier write can leave a created file without its verifier after a failed commit.[^core][^rfc]

[^core]: `OpenChildReferenceSettings`, `Caller.openChildReference`, and the staged `coordinated` mutation.

[^adapter]: `NfsExport.openChild` holds the registry gate, checks capacity, and owns the handle scope.

[^umask-rfc]: RFC 8275 states that an NFS client applies umask before sending a mode attribute.

[^watch-tests]: `Watch.test.ts` checks that initial sizing emits only Create for the new file.

[^dispatcher]: `decodeOperation` and `case "Open"` in `nfs4.ts`.

[^tests]: `NfsOpenCreate.test.ts` exercises the internal writable flag; the public server does not enable it.

[^rfc]: RFC 8881 Section 18.16.3 defines ordinary, guarded, and exclusive create behavior.
