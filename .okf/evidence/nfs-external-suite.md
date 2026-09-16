---
type: Evidence
title: NFS external suite baseline
description: Records the pinned pynfs NFSv4.1 run and the macOS 26 native-client run that support the read-only-local profile's experimental maturity.
status: stable
tags: [nfs, evidence, pynfs, conformance]
sources:
  - id: baseline
    resource: ../../apps/nfs-preview/CONFORMANCE.md
    title: Pinned run, procedure, and failure classification
  - id: fixture
    resource: ../../apps/nfs-preview/src/conformance.ts
    title: Conformance fixture server
  - id: pynfs
    resource: https://github.com/kofemann/pynfs
    title: pynfs NFSv4.1 server tester
  - id: profile-tests
    resource: ../../packages/nfs/test/ReadOnlyProfile.test.ts
    title: Read-only profile protocol tests
generated: { by: claude/okf, at: 2026-09-15T23:00:00+02:00 }
---

# NFS external suite baseline

On 2026-09-15 the pynfs NFSv4.1 server tests at commit `cd470182` ran against the conformance fixture with
`--minorversion 1 --security sys --noinit --nocleanup --force all noreboot nocourteous`. Of 179 selected tests, 102
passed and 77 failed. Every failure is classified in the baseline document: 61 are mutations refused on a read-only
export, 12 look up special-file kinds the core does not have, and 4 are suite-side limitations.[^baseline]

The durable conclusion is that the focused protocol suite alone missed several RFC 8881 rules that a raw-RPC client
exercised immediately: client-record replacement cases, CREATE_SESSION principal and channel-size checks, replay of
CREATE_SESSION through a SEQUENCE compound, the ignored open_owner clientid, and error precedence over `NFS4ERR_ROFS`.
Each is now covered by a focused test, and the external run remains the regression net for rules that focused tests
encode from memory.[^profile-tests]

The fixture raises client and session limits because pynfs opens a fresh client record per test and never destroys
it; the preview's default of sixteen client records is otherwise exhausted within seconds. That is a suite artifact,
not a defect, but it shows that unconfirmed records only leave through lease expiry.[^fixture]

A native-client run followed on 2026-09-15: the macOS 26.6.2 `mount_nfs` client mounted the rebuilt preview with `vers=4.1,sec=sys` and passed all fifteen scripted read-side checks (listing, reads, symlink traversal, hard-link identity, live update after the cache window, reopen, and rejected writes). The first attempt failed every file read because the client sets `OPEN4_SHARE_ACCESS_WANT_READ_DELEG` on OPEN and the server rejected it with `NFS4ERR_INVAL`; a loopback capture identified the operation, and the fix answers wants with `OPEN_DELEGATE_NONE_EXT`. That defect was invisible to both the focused tests and pynfs, which is the case for keeping a real client in the evidence ladder.[^baseline]

This baseline satisfies the pynfs requirement of the `experimental` maturity in the [NFS profile ladder](/decisions/nfs-profile-ladder.md "supports") and is cited by the [read-only-local profile](/profiles/nfs-read-only-local.md "supports"). It does not stand in for the Linux client mount that `preview` requires. Claims stay bounded by the [evidence and validation workflow](/workflows/evidence-and-validation.md "governed by").

[^baseline]: The baseline document pins the suite commit, Python dependencies, command line, and the three failure classes.

[^profile-tests]: The read-only profile tests cover each rule the external run surfaced.

[^fixture]: The fixture uses `maxClients` 4096 and a ten-second lease so unconfirmed records leave quickly.
