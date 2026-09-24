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
    resource: ../../../packages/nfs/package.json
    title: NFS package manifest
  - id: changesets
    resource: ../../../.changeset/config.json
    title: Changesets configuration
  - id: linux-gate
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/39
    title: Repeatable Linux mount gate
  - id: pynfs
    resource: https://github.com/kofemann/pynfs
    title: pynfs NFSv4.1 server tester
generated: { by: codex/okf, at: 2026-09-20T12:00:00Z }
---

# NFS profile ladder

Accepted by the user on 2026-09-15 while resolving issue #42.[^issue] This concept records the decisions; the coverage ledgers record per-requirement status.

## Two axes

A **capability profile** states what the server does. A **maturity** label states how much evidence supports a profile. The two are recorded separately. "Production-ready" is not a stage; it is a claim that a named profile reached `stable`.

Profiles, in delivery order:

| Profile               | Adds                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Owning issues      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `read-only-local`     | complete read path, bounded advisory read locks, `NFS4ERR_ROFS` on mutation and write locks, loopback binding, `AUTH_SYS` accepted as untrusted, backchannel, connection binding, trunking                                                                                                                                                                                                                                                                        | #43, #39, #44      |
| `read-only-networked` | trusted `AUTH_SYS` identity mapped to VFS callers by application policy, non-loopback binding behind that policy and an explicit opt-in                                                                                                                                                                                                                                                                                                                           | #74, #75           |
| `writable`            | create, write, rename, remove, synchronous durable `WRITE` and `COMMIT`, plus full share reservations and read/write advisory byte-range lock behavior; its accepted scope is the [writable export decision](writable-export-scope.md "refined by") and its core boundary is fixed by [reference-based mutations](../core/reference-mutations.md "refined by") and [volume durability and usage facts](../core/volume-durability-and-usage-facts.md "refined by") | #46, #47, #48, #49 |
| `stateful`            | grace and reclaim, restart recovery, persistent filehandles                                                                                                                                                                                                                                                                                                                                                                                                       | #50                |

Maturity labels are `experimental`, `preview`, and `stable`.

## Wording

RFC 8881 defines no read-only server profile; its read-only allowance in Section 17 applies to clients.[^rfc8881] Servers MUST support RPCSEC_GSS with Kerberos V5 and MUST support backchannels and trunking. Backchannels and trunking landed in `read-only-local` (#44) because the Linux client needs them to mount cleanly. Kerberos is the one MUST still unmet, and the [authentication and export policy decision](nfs-authentication-and-export-policy.md "refined by") excludes it permanently. Every profile is therefore described as a _protocol-complete read-only export_, _interoperable_, or similar, never as conformant.

## Scope exclusions

- NFSv4.0 and NFSv4.2 are excluded. Section 2.7 rule 11 recommends supporting earlier minor versions; the ledger records this SHOULD as deliberately unmet. Unsupported minor versions keep returning `NFS4ERR_MINOR_VERS_MISMATCH` so the Linux client ladder reaches 4.1.
- Filehandles stay volatile through `read-only-networked` and `writable`. Persistent handles are a `stateful` requirement and depend on durable identity work, which must not weaken [snapshot-local file identity](../core/snapshot-local-file-identity.md "constrained by").
- `AUTH_SYS` is the security floor for every profile. Kerberos is a permanently unmet MUST. RPCSEC_GSS fails closed with `AUTH_TOOWEAK`, other unsupported flavors with `AUTH_BADCRED`, and `SP4_MACH_CRED` and `SP4_SSV` are rejected because they require RPCSEC_GSS integrity.

## Publication

`read-only-local` is a publishable target. The package manifest permits public publication, and NFS joins the fixed Changesets group with core, memory, and persistence.[^nfs-package][^changesets] Maturity graduates in place without renaming the package or its exports. The public `writable: true` option is experimental and requires a `survives-power-loss` volume, an explicit identity policy, and one authorized identity. The default remains read-only.

## Evidence ladder

- `experimental`: the protocol test suite passes; every ledger row carries a status; a pinned pynfs 4.1 read-side run exists with a triaged known-failures file that classifies each failure as a deliberate exclusion, a suite assertion no server satisfies, or a disputed assertion that contradicts RFC 8881; defects are fixed rather than listed.[^pynfs]
- `preview`: `experimental` plus the repeatable Linux kernel-client mount running in CI and a documented manual macOS 26 mount with the exact `vers=4.1` command.[^linux-gate]
- `stable`: `preview` plus a third independent client, fault coverage for restart, lease expiry, multiple connections, and resource pressure, and one recorded Bake-a-thon participation.

Where each kind of evidence comes from, which checks run in CI, and which fault cases each stage needs are fixed by the [interoperability and fault evidence decision](nfs-interoperability-evidence.md "refined by"). Claims stay no broader than their evidence, following the [evidence and validation workflow](../../workflows/evidence-and-validation.md "governed by"). The first profile is specified by the [read-only-local profile](../../profiles/nfs/nfs-read-only-local.md "refined by"), and per-requirement status lives in the [operations](../../research/nfs/nfs-operations-ledger.md "evidenced by"), [attributes](../../research/nfs/nfs-attributes-ledger.md "evidenced by"), and [protocol rules](../../research/nfs/nfs-protocol-rules-ledger.md "evidenced by") ledgers. This decision supersedes the scoping paragraphs of the [NFS server research](../../research/nfs/nfs-server.md "supersedes").

[^issue]: Issue #42 holds the original questions and the decision summary.

[^rfc8881]: Sections 2.2.1.1.1 and 17 state the server MUSTs still unmet. Sections 2.10.3 and 2.10.5, backchannels and trunking, were met by #44.

[^nfs-package]: The manifest is publishable at the current source version, 0.1.0; publication itself is a separate release action.

[^changesets]: The fixed group defines which packages share a version.

[^linux-gate]: Issue #39 owns the Linux mount gate and retains the macOS 26.6 manual result from 2026-09-13.

[^pynfs]: pynfs speaks raw RPC, defaults to minor version 2 and `sec=sys`, and can run read-side test flags against a pre-populated tree without mounting.
