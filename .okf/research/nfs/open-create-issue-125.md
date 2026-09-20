---
type: Research Report
title: NFS OPEN creation for issue 125
description: Records all four internal writable OPEN create modes, atomic verifier storage, and the remaining public release gates.
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
  - id: exclusive-tests
    resource: ../../../packages/nfs/test/NfsCreate.test.ts
    title: Exclusive creation, stored verifier, and cancellation wire tests
  - id: watch-tests
    resource: ../../../packages/core/test/Watch.test.ts
    title: Core watch event tests
generated: { by: codex/okf, at: 2026-09-20T11:50:43Z }
---

# NFS OPEN creation for issue 125

The internal writable handler supports `UNCHECKED4`, `GUARDED4`, `EXCLUSIVE4`, and `EXCLUSIVE4_1` regular-file creation. It passes the mapped caller, parent reference, name, access, and supported initial size, mode, ownership, and timestamp attributes to `openChildReference`. Core creates and opens the exact object in one staged mutation. An expected-child guard checks the result of the NFS share and budget preflight against the actual child before mutation, including when a direct VFS caller changes the name between those steps. The adapter checks filehandle capacity before that mutation and retains the scoped handle for the NFS open state. The response uses the core directory transition and reports the attributes applied. Session replay returns the cached reply without repeating creation. Read-only exports still reject `OPEN4_CREATE` after structural checks.[^core][^adapter][^dispatcher][^tests]

For an existing `UNCHECKED4` file, the handler ignores create attributes except size zero, which truncates it; this includes unsupported attributes and invalid mode values. `GUARDED4` returns `EXIST` for an existing name before attribute support checks. New files reject unsupported attributes with `ATTRNOTSUPP`. An explicit NFS mode skips the caller's umask because the client has already applied one; core's permission policy still applies. Core's ordinary caller path still applies its configured umask. Filehandle admission permits an existing registered reference at capacity. Initial file sizing publishes one Create event without an earlier Update. Tests cover these boundaries alongside owner upgrades, share denial before truncation, mapped-caller authority, filehandle and file-size capacity, rejected and unknown storage outcomes, interrupted admission, replay, and reopening a confirmed live image. These are internal preparation; the [accepted writable scope](../../decisions/nfs/writable-export-scope.md "constrained by") and durability qualification still gate a public writable export.[^rfc][^umask-rfc][^tests][^watch-tests]

Both exclusive modes store the eight-byte verifier as two whole-second values in the new file's access and modification timestamps. The verifier, file, and initial attributes enter one core candidate and one storage commit. A matching retry opens the existing file without reapplying creation attributes. A different verifier returns `EXIST`. Later changes to the stored timestamps can end verifier matching. The reply reports `time_access` and `time_modify` as the verifier attributes.[^rfc][^exclusive-tests]

`EXCLUSIVE4_1` accepts initial size, mode, owner, and group. Its `suppattr_exclcreat` bitmap excludes the timestamp setters reserved for the verifier. Ordinary and guarded creation also accept timestamp setters. Owner values use the [canonical numeric format](../../decisions/nfs/writable-owner-strings.md "constrained by"); core enforces ownership authority. Existing exclusive files still require the mapped caller's requested access.[^dispatcher]

NFS observes the child before checking its share reservations and verifier. Core's `expectedChild` condition compares that exact reference, revision, and both timestamps under the volume gate before opening or mutating it. Timestamp comparison matters because reads can change access time without advancing the revision. A changed observation returns retryable `DELAY` without altering the replacement file.[^core][^adapter]

Tests use an injected live-image store to prove that confirmed creation reopens with its verifier, rejected commits publish no file or reservation, and unknown outcomes block access. Cancellation during commit releases any acquired handle and leaves a consumed replay slot. This evidence does not qualify physical power-loss durability or persistent NFS session recovery. Public writable integration remains in #48, storage qualification in #144, and session recovery in #50.[^exclusive-tests]

[^core]: `OpenChildReferenceSettings`, `Caller.openChildReference`, and the staged `coordinated` mutation.

[^adapter]: `NfsExport.openChild` holds the registry gate, checks capacity, and owns the handle scope.

[^umask-rfc]: RFC 8275 states that an NFS client applies umask before sending a mode attribute.

[^watch-tests]: `Watch.test.ts` checks that initial sizing emits only Create for the new file.

[^dispatcher]: `decodeOperation` and `case "Open"` in `nfs4.ts`.

[^tests]: `NfsOpenCreate.test.ts` exercises the internal writable flag; the public server does not enable it.

[^rfc]: RFC 8881 Section 18.16.3 defines ordinary, guarded, and exclusive create behavior.

[^exclusive-tests]: `NfsCreate.test.ts` exercises both exclusive modes, attribute restrictions, replay, stored-image recovery, and cancellation during commit.
