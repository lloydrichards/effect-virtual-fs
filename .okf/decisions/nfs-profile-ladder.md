---
type: Decision
title: NFS profile ladder
description: Separates NFSv4.1 capability profiles from maturity labels, names the four profiles, and fixes the evidence each maturity level requires.
status: stable
tags: [nfs, profile, release, evidence]
sources:
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/42
    title: Profile definition issue
  - id: rfc8881
    resource: https://www.rfc-editor.org/rfc/rfc8881.html
    title: RFC 8881 NFSv4.1
  - id: nfs-package
    resource: ../../packages/nfs/package.json
    title: NFS package manifest
  - id: changesets
    resource: ../../.changeset/config.json
    title: Changesets configuration
  - id: linux-gate
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/39
    title: Repeatable Linux mount gate
  - id: pynfs
    resource: https://github.com/kofemann/pynfs
    title: pynfs NFSv4.1 server tester
generated: { by: claude/okf, at: 2026-09-15T17:30:00+02:00 }
---

# NFS profile ladder

Accepted by the user on 2026-09-15 while resolving issue #42.[^issue] This concept records the decisions; the coverage ledgers record per-requirement status.

## Two axes

A **capability profile** states what the server does. A **maturity** label states how much evidence supports a profile. The two are recorded separately. "Production-ready" is not a stage; it is a claim that a named profile reached `stable`.

Profiles, in delivery order:

| Profile               | Adds                                                                                                                                         | Owning issues |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `read-only-local`     | complete read path, `NFS4ERR_ROFS` on mutation, loopback binding, `AUTH_SYS` accepted as untrusted                                           | #43, #39      |
| `read-only-networked` | backchannel, connection binding, trunking, trusted `AUTH_SYS` identity mapped by application policy, non-loopback binding behind that policy | #44, #45      |
| `writable`            | create, write, rename, remove, `COMMIT` semantics, explicit durability statement                                                             | #46, #48, #49 |
| `stateful`            | share reservations, byte-range locks, grace and reclaim, restart model, persistent filehandles                                               | #47, #50      |

Maturity labels are `experimental`, `preview`, and `stable`.

## Wording

RFC 8881 defines no read-only server profile; its read-only allowance in Section 17 applies to clients.[^rfc8881] Servers MUST support RPCSEC_GSS with Kerberos V5 and MUST support backchannels and trunking. `read-only-local` therefore is described as a _protocol-complete read-only export_ or as _interoperable_, never as conformant. Only `read-only-networked` and later profiles may use "conformant", and only once those MUSTs are met.

## Scope exclusions

- NFSv4.0 and NFSv4.2 are excluded. Section 2.7 rule 11 recommends supporting earlier minor versions; the ledger records this SHOULD as deliberately unmet. Unsupported minor versions keep returning `NFS4ERR_MINOR_VERS_MISMATCH` so the Linux client ladder reaches 4.1.
- Filehandles stay volatile through `read-only-networked` and `writable`. Persistent handles are a `stateful` requirement and depend on durable identity work, which must not weaken [snapshot-local file identity](snapshot-local-file-identity.md "constrained by").
- `AUTH_SYS` is the security floor for both read-only profiles. Kerberos is recorded as an unmet MUST whose fate issue #45 decides. Unsupported flavors fail closed; `SP4_MACH_CRED` must be honored or rejected, never accepted and ignored.

## Publication

`read-only-local` is a publishable target. The package leaves `private` and publishes once the `experimental` evidence exists, and it joins the fixed Changesets group with core, memory, and persistence, so its first version follows that group.[^nfs-package][^changesets] Maturity graduates in place without renaming the package or its exports.

## Evidence ladder

- `experimental`: the protocol test suite passes; every ledger row carries a status; a pinned pynfs 4.1 read-side run exists with a triaged known-failures file that classifies each failure as a defect, a deliberate exclusion, or a suite assertion no server satisfies.[^pynfs]
- `preview`: `experimental` plus the repeatable Linux kernel-client mount running in CI and a documented manual macOS 26 mount with the exact `vers=4.1` command.[^linux-gate]
- `stable`: `preview` plus a third independent client, fault coverage for restart, lease expiry, multiple connections, and resource pressure, and one recorded Bake-a-thon participation.

Claims stay no broader than their evidence, following the [evidence and validation workflow](/workflows/evidence-and-validation.md "governed by"). The first profile is specified by the [read-only-local profile](/profiles/nfs-read-only-local.md "refined by"), and per-requirement status lives in the [operations](/research/nfs-operations-ledger.md "evidenced by"), [attributes](/research/nfs-attributes-ledger.md "evidenced by"), and [protocol rules](/research/nfs-protocol-rules-ledger.md "evidenced by") ledgers. This decision supersedes the scoping paragraphs of the [NFS server research](/research/nfs-server.md "supersedes").

[^issue]: Issue #42 holds the original questions and the decision summary.

[^rfc8881]: Sections 2.2.1.1.1, 2.10.3, 2.10.5, and 17 state the server MUSTs that a read-only loopback server cannot meet.

[^nfs-package]: The manifest currently declares the package private at version 0.0.0.

[^changesets]: The fixed group defines which packages share a version.

[^linux-gate]: Issue #39 owns the Linux mount gate and retains the macOS 26.6 manual result from 2026-09-13.

[^pynfs]: pynfs speaks raw RPC, defaults to minor version 2 and `sec=sys`, and can run read-side test flags against a pre-populated tree without mounting.
