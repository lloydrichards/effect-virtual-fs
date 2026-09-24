---
type: Decision
title: NFS interoperability and fault evidence
description: Fixes which clients and external suites supply NFS evidence, which run in CI or as release gates, how suite failures are classified, and which fault cases each profile stage requires.
status: stable
tags: [nfs, evidence, pynfs, interoperability, faults]
sources:
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/51
    title: Interoperability and fault coverage issue
  - id: known-failures
    resource: ../../../apps/nfs-preview/conformance/known-failures.json
    title: Classified pynfs known failures
  - id: pynfs-gate
    resource: ../../../apps/nfs-preview/scripts/pynfs-gate.sh
    title: Pinned pynfs gate
  - id: pynfs-workflow
    resource: ../../../.github/workflows/nfs-pynfs.yml
    title: pynfs pull-request workflow
  - id: linux-workflow
    resource: ../../../.github/workflows/nfs-linux-mount.yml
    title: Label-gated Linux mount workflow
  - id: writable-app
    resource: ../../../apps/demo-r2-nfs/standalone-nfs.md
    title: Writable R2 gateway client and fault runs
  - id: rfc8881
    resource: https://www.rfc-editor.org/rfc/rfc8881.html
    title: RFC 8881 NFSv4.1
generated: { by: claude/okf, at: 2026-09-24T09:00:00+02:00 }
---

# NFS interoperability and fault evidence

Accepted by the user on 2026-09-24 while resolving issue #51.[^issue] The [profile ladder](nfs-profile-ladder.md "refines") says how much evidence each maturity needs. This decision says where that evidence comes from and how it is kept current.

## Clients and suites

| Source                                          | Pin                                                                                                          | Role                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| pynfs NFSv4.1 server tests                      | Commit, Python dependencies, and command line in the known-failures file[^known-failures]                    | Raw-RPC regression net for every profile                                       |
| Linux kernel client                             | Recorded, not pinned: the runner is `ubuntu-24.04` and the gate prints kernel, distribution, and `nfs-utils` | `preview` native client                                                        |
| macOS 26 `mount_nfs`                            | Recorded per run in the conformance baseline                                                                 | `preview` native client, manual                                                |
| FreeBSD or Windows `ms-nfs41-client`            | To be recorded on first run                                                                                  | Third independent client for `stable`                                          |
| cthon04, xfstests, fsx, LTP, nfstest, pjdfstest | None yet                                                                                                     | Need a writable kernel mount, so they apply from the `writable` profile onward |

A kernel client cannot be frozen by an image digest or package pin, because the kernel is the protocol implementation. Every client run therefore records its exact versions, and a changed version is visible in the record rather than silent.

## CI and release gates

- **Every pull request** runs the protocol test suites. When it changes `packages/core`, `packages/nfs`, or the preview app, it also runs the pinned pynfs gate. pynfs needs no mount or privilege, and the suite itself runs in under a minute.[^pynfs-workflow]
- **On demand or with the `nfs-gate` label**, the Linux mount gate runs. It needs `sudo` to mount, so it stays out of the default sequence.[^linux-workflow]
- **Release gates**, run by hand and recorded before a maturity claim: the macOS mount, the writable gateway's client and fault runs, the third client, and Bake-a-thon participation.[^writable-app]

## Classifying suite failures

External suites are evidence, not authority. RFC 8881 and its verified errata decide correctness.[^rfc8881] Each expected failure is listed in a machine-readable file with one of four classes:

| Class              | Meaning                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `read-only-export` | Deliberate exclusion: mutating setup returns `NFS4ERR_ROFS`                                                               |
| `object-kind`      | Deliberate exclusion: the core has no block, char, fifo, or socket objects                                                |
| `suite-limitation` | An assertion no NFSv4.1 server in this profile can satisfy, such as an NFSv4.2 attribute                                  |
| `disputed`         | An assertion another server may pass, but which contradicts RFC 8881 or a verified erratum; each entry must cite the rule |

Defects are never listed; they are fixed. The comparison is strict in both directions. An unlisted failure fails the gate as a defect until classified, and a listed test that now passes fails it as a stale entry. The first repeatable run showed why the gate is needed: three session answers corrected after the recorded baseline had turned into unrecorded pynfs failures.

## Fault cases by stage

Fault coverage grows with the state it exercises. A stage is not reached until its row has evidence.

| Stage                       | Required fault evidence                                                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read-only-local` `preview` | Focused tests for lease expiry, client and session exhaustion, slot replay, and stalled compounds                                                    |
| `writable` `experimental`   | Through a mounted client: process kill after an acknowledged write, and a lost storage reply that must surface as an error rather than false success |
| any profile at `stable`     | Through a kernel client: server restart, lease expiry, `nconnect>1`, and resource pressure                                                           |
| `stateful`                  | Reclaim within grace, plus the pynfs `reboot` and `courteous` groups                                                                                 |

## Recording evidence for a release

A release that states an NFS maturity lists the clients, suites, and versions behind it. The [conformance baseline](../../../apps/nfs-preview/CONFORMANCE.md) records the pynfs pin and every native-client run for the read-only profile. The writable gateway guide records the writable client and fault runs. The [evidence and validation workflow](../../workflows/evidence-and-validation.md "governs") and [release readiness workflow](../../workflows/release-readiness.md "governs") apply these rules.

[^issue]: Issue #51 holds the original questions.

[^known-failures]: The gate reads its pin from this file, so the recorded baseline and the CI run cannot name different suite revisions.

[^pynfs-workflow]: The workflow runs on `ubuntu-24.04` with Python 3.14.

[^linux-workflow]: Issue #39 owns the Linux gate.

[^writable-app]: The writable runs so far use macOS and Debian 12 against the R2 gateway.

[^rfc8881]: CSESS16 and CSESS16a conflict with Sections 18.33.3 and 18.36.3, and CSESS29 with Section 18.36.4 phase 2.
