---
type: Evidence
title: NFS external suite baseline
description: Records the pinned, CI-repeated pynfs NFSv4.1 run, the macOS 26 native-client run, and the Linux kernel-client gate that together support the read-only-local profile's preview maturity.
status: stable
tags: [nfs, evidence, pynfs, conformance]
sources:
  - id: baseline
    resource: ../../apps/nfs-preview/CONFORMANCE.md
    title: Pinned run, procedure, and failure classification
  - id: known-failures
    resource: ../../apps/nfs-preview/conformance/known-failures.json
    title: Classified pynfs known failures
  - id: fixture
    resource: ../../apps/nfs-preview/src/conformance.ts
    title: Conformance fixture server
  - id: pynfs
    resource: https://github.com/kofemann/pynfs
    title: pynfs NFSv4.1 server tester
  - id: profile-tests
    resource: ../../packages/nfs/test/ReadOnlyProfile.test.ts
    title: Read-only profile protocol tests
  - id: linux-gate
    resource: ../../apps/nfs-preview/scripts/linux-mount-gate.sh
    title: Opt-in privileged Linux mount gate
generated: { by: claude/okf, at: 2026-09-24T09:00:00+02:00 }
---

# NFS external suite baseline

The pynfs NFSv4.1 server tests at commit `cd470182` run against the conformance fixture with
`--minorversion 1 --security sys --noinit --nocleanup --force all noreboot nocourteous`. On 2026-09-24, 100 of 179
selected tests passed and 79 failed. Every failure is classified in a machine-readable known-failures file: 62 are
mutations refused on a read-only export, 12 look up special-file kinds the core does not have, 2 request an NFSv4.2
attribute, and 3 are disputed because they contradict RFC 8881.[^baseline] The `nfs-pynfs` workflow repeats the run on
every pull request that can change wire behavior and fails on any difference from that file.

The first repeated run also showed why the gate is needed. The 2026-09-15 baseline recorded 77 failures and had not
been rerun after later session corrections. By then CREATE_SESSION already returned the RFC-required answers that
pynfs tests CSESS16, CSESS16a, and CSESS29 reject. Neither the focused tests nor anyone reading the old baseline had
noticed the drift.

The durable conclusion is that the focused protocol suite alone missed several RFC 8881 rules that a raw-RPC client
exercised immediately: client-record replacement cases, CREATE_SESSION principal and channel-size checks, replay of
CREATE_SESSION through a SEQUENCE compound, the ignored open_owner clientid, and error precedence over `NFS4ERR_ROFS`.
Each is now covered by a focused test, and the external run remains the regression net for rules that focused tests
encode from memory.[^profile-tests]

The fixture raises client and session limits because pynfs opens a fresh client record per test and never destroys
it; the preview's default of sixteen client records is otherwise exhausted within seconds. That is a suite artifact,
not a defect, but it shows that unconfirmed records only leave through lease expiry.[^fixture]

A native-client run followed on 2026-09-15: the macOS 26.6.2 `mount_nfs` client mounted the rebuilt preview with `vers=4.1,sec=sys` and passed all fifteen scripted read-side checks (listing, reads, symlink traversal, hard-link identity, live update after the cache window, reopen, and rejected writes). The first attempt failed every file read because the client sets `OPEN4_SHARE_ACCESS_WANT_READ_DELEG` on OPEN and the server rejected it with `NFS4ERR_INVAL`; a loopback capture identified the operation, and the fix answers wants with `OPEN_DELEGATE_NONE_EXT`. That defect was invisible to both the focused tests and pynfs, which is the case for keeping a real client in the evidence ladder.[^baseline]

That run mounted with the client-side `ro` option, so its rejected-write checks were answered by the kernel. A second run on 2026-09-16, after the Section 15.2 audit, mounted writable on the client and passed all sixteen checks of the current script, including `touch`, `mkdir`, and append refused by the server's `NFS4ERR_ROFS` with the file unchanged afterwards.

A Linux kernel-client run followed on 2026-09-16, and is now repeatable rather than manual. The
mount gate script starts the preview server, mounts
`127.0.0.1:/` with `nfsvers=4.1,tcp,sec=sys,port=2049,actimeo=1`, runs the same sixteen scripted checks the macOS run
used, and passed all sixteen against kernel `6.17.0-1022-azure` on Ubuntu 24.04.5 LTS with `nfs-utils` 2.6.4 (runner
image `ubuntu24` 20260907.300.1). Nothing in the read path behaved differently from macOS; the one substantive
difference was the client's cache cadence, so the live-mutation check now polls instead of sleeping once.[^linux-gate]

That run also closed a claim this repository had been making without evidence. The profile ladder states that
unsupported minor versions keep returning `NFS4ERR_MINOR_VERS_MISMATCH` so the Linux client ladder reaches 4.1, but
macOS cannot test it because it does not try 4.2. The gate therefore mounts a second time with no `vers=` option; the
client laddered down from 4.2 and `/proc/mounts` reported `vers=4.1`. That is the first direct confirmation of the
laddering behavior.

The client versions above are recorded rather than pinned, and the distinction matters when reading this as evidence.
The NFSv4.1 client is the host kernel, so neither a digest-pinned container nor an apt version pin would freeze the
code that speaks the protocol — only the `nfs-utils` userland. The gate prints the kernel, distribution, and
`nfs-utils` versions on every run and the runner is pinned to `ubuntu-24.04` rather than `ubuntu-latest`, so client
drift shows up as a changed recorded version rather than as a silent change in what was tested.

This baseline satisfies the pynfs requirement of the `experimental` maturity in the [NFS profile ladder](../decisions/nfs/nfs-profile-ladder.md "supports") and is cited by the [read-only-local profile](../profiles/nfs/nfs-read-only-local.md "supports"). With the Linux gate above, the native-client requirements of `preview` are met. Its sources and gates are fixed by the [interoperability and fault evidence decision](../decisions/nfs/nfs-interoperability-evidence.md "governed by"). Claims stay bounded by the [evidence and validation workflow](../workflows/evidence-and-validation.md "governed by").

[^baseline]: The known-failures file pins the suite commit, Python dependencies, and command line; the baseline document explains the four failure classes.

[^profile-tests]: The read-only profile tests cover each rule the external run surfaced.

[^fixture]: The fixture uses `maxClients` 4096 and a ten-second lease so unconfirmed records leave quickly.

[^linux-gate]: The gate runs on `workflow_dispatch` or on a pull request carrying the `nfs-gate` label, so privileged
    mounting stays out of the normal validation suite.
