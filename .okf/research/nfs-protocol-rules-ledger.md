---
type: Reference
title: NFS protocol rules ledger
description: Tracks cross-cutting RFC 8881 requirements, binding and watched errata, and the client interoperability matrix for the NFS profiles.
status: draft
tags: [nfs, ledger, conformance, errata, clients]
sources:
  - id: rfc8881
    resource: https://www.rfc-editor.org/rfc/rfc8881.html
    title: RFC 8881 NFSv4.1
  - id: rfc8881-errata
    resource: https://www.rfc-editor.org/errata/rfc8881
    title: RFC 8881 errata
  - id: rfc5661-errata
    resource: https://www.rfc-editor.org/errata/rfc5661
    title: RFC 5661 errata
  - id: rfc5662
    resource: https://www.rfc-editor.org/rfc/rfc5662.html
    title: RFC 5662 NFSv4.1 XDR
  - id: rfc8178
    resource: https://www.rfc-editor.org/rfc/rfc8178.html
    title: RFC 8178 minor versioning rules
  - id: dispatcher
    resource: ../../packages/nfs/src/internal/nfs4.ts
    title: Compound dispatcher and session state
  - id: rpc
    resource: ../../packages/nfs/src/internal/rpc.ts
    title: RPC and authentication handling
  - id: nfs-man
    resource: https://man7.org/linux/man-pages/man5/nfs.5.html
    title: Linux nfs(5) mount options
  - id: mount-nfs-macos
    resource: https://keith.github.io/xcode-man-pages/mount_nfs.8.html
    title: macOS mount_nfs(8)
  - id: linux-gate
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/39
    title: Linux mount gate and retained macOS result
generated: { by: claude/okf, at: 2026-09-15T17:30:00+02:00 }
---

# NFS protocol rules ledger

Cross-cutting requirements that no single operation row captures. Status vocabulary comes from the [NFS profile ladder](/decisions/nfs-profile-ladder.md "implements"). Section numbers refer to RFC 8881.[^rfc8881]

## Cross-cutting requirements

| Rule                                                                                                                                          | Section                      | Level        | Required by         | Status                        | Current behavior                                                                                                                            | Intended behavior                                                                                                                                         | Issue |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------ | ------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Sessions mandatory; exactly-once semantics for every request including idempotent ones                                                        | 2.10, 2.10.6                 | MUST         | read-only-local     | supported                     | Slot replay cache, byte-identical retries, SEQ_FALSE_RETRY, RETRY_UNCACHED_REP                                                              | Same                                                                                                                                                      |       |
| TCP transport; port 2049 default; no UDP                                                                                                      | 2.9                          | MUST         | read-only-local     | supported                     | Loopback TCP; application binds the port                                                                                                    | Same                                                                                                                                                      |       |
| Every emitted error code exists in NFSv4.1                                                                                                    | 15, 16                       | MUST         | read-only-local     | gap(#43)                      | `NFS4ERR_RESOURCE` (10018) is emitted from fifteen sites; RFC 8881 does not define code 10018 and RFC 5661 verified erratum 2328 removed it | Replace per site with `NFS4ERR_DELAY`, `NFS4ERR_REQ_TOO_BIG`, `NFS4ERR_TOO_MANY_OPS`, `NFS4ERR_SERVERFAULT`, or `NFS4ERR_INVAL` as the situation warrants | #43   |
| Unsupported minor version returns MINOR_VERS_MISMATCH with zero results                                                                       | 16.2.3                       | MUST         | read-only-local     | supported                     | Only minor version 1 accepted                                                                                                               | Same; keeps the Linux 4.2-first ladder working                                                                                                            |       |
| SEQUENCE first; permitted first operations are SEQUENCE, BIND_CONN_TO_SESSION, EXCHANGE_ID, CREATE_SESSION, DESTROY_SESSION, DESTROY_CLIENTID | 18.46.3 and erratum 7386     | MUST         | read-only-local     | supported                     | All listed except BIND_CONN_TO_SESSION, which is an unknown opcode                                                                          | Add BIND_CONN_TO_SESSION in `read-only-networked`                                                                                                         | #44   |
| Lease renewed on successful SEQUENCE; not expired mid-compound                                                                                | 8.3                          | MUST         | read-only-local     | supported                     | Sweep before each compound under the state gate; renewal after success                                                                      | Same                                                                                                                                                      |       |
| EXCHANGE_ID flag rules: exactly one pNFS role, CONFIRMED_R, INVAL on undefined bits, NOT_ONLY_OP                                              | 18.35.3, 13.1                | MUST         | read-only-local     | supported                     |                                                                                                                                             | Same                                                                                                                                                      |       |
| CREATE_SESSION channel attributes only decreased; separate replay cache                                                                       | 18.36.3, 18.36.4             | MUST         | read-only-local     | supported                     |                                                                                                                                             | Same                                                                                                                                                      |       |
| State protection honored: SP4_MACH_CRED enforced or rejected                                                                                  | 2.10.8.3, 18.35.3            | MUST         | read-only-local     | gap(#45)                      | SP4_MACH_CRED parsed, reply always SP4_NONE                                                                                                 | Reject with an operation-valid error or enforce                                                                                                           | #45   |
| Servers MUST support backchannels                                                                                                             | 2.10.3                       | MUST         | read-only-networked | deferred(read-only-networked) | CONN_BACK_CHAN ignored; reply flags zero                                                                                                    | Bind a backchannel and send CB_NULL                                                                                                                       | #44   |
| Servers MUST support session and client-id trunking; BIND_CONN_TO_SESSION                                                                     | 2.10.5                       | MUST         | read-only-networked | deferred(read-only-networked) | none                                                                                                                                        | Support both trunking forms                                                                                                                               | #44   |
| Servers MUST support RPCSEC_GSS integrity, authentication, privacy, and Kerberos V5                                                           | 2.2.1.1.1.1, 2.2.1.1.1.2, 21 | MUST         | none                | gap(#45)                      | RPCSEC_GSS refused with AUTH_BADCRED; AUTH_SYS accepted as untrusted[^rpc]                                                                  | Unmet MUST. Issue #45 decides whether it is ever met; no profile claims conformance while unmet                                                           | #45   |
| AUTH_SYS identity never widens access beyond policy; unsupported flavors fail closed                                                          | 21                           | SHOULD       | read-only-local     | supported                     | AUTH_SYS fields feed only replay identity; a single privileged caller acts                                                                  | Same; `read-only-networked` maps identity by application policy                                                                                           | #45   |
| Grace period: reject READ and WRITE with NFS4ERR_GRACE unless safe                                                                            | 8.4.2.1                      | MUST         | stateful            | deferred(stateful)            | No grace period; RECLAIM_COMPLETE is a flag                                                                                                 | Safe today because no locks or share denials exist, which 8.4.2.1 recognizes                                                                              | #50   |
| Persistent filehandles survive restart when declared                                                                                          | 4.2.2                        | MUST         | stateful            | deferred(stateful)            | Volatile declared; restart requires remount                                                                                                 | Persistent handles with durable identity                                                                                                                  | #50   |
| Equal filehandles refer to the same object; hard links share a handle                                                                         | 4.2.1                        | MUST, SHOULD | read-only-local     | supported                     | Same object reference for aliases                                                                                                           | Same                                                                                                                                                      |       |
| ACCESS reports only permissions actually checked                                                                                              | 18.1.3                       | MUST         | read-only-local     | gap(#43)                      | Requested mask echoed                                                                                                                       | Consult mode bits                                                                                                                                         | #43   |
| Invalid UTF-8 returns INVAL; `.` and `..` return BADNAME                                                                                      | 14.5                         | SHOULD       | read-only-local     | gap(#43)                      | INVAL for both cases; BADNAME defined but never emitted                                                                                     | Distinguish the two                                                                                                                                       | #43   |
| READDIR cookies 0, 1, 2 reserved; NOT_SAME on stale verifier; TOOSMALL                                                                        | 18.23.3                      | MUST         | read-only-local     | supported                     | Cookies start at 3                                                                                                                          | Same                                                                                                                                                      |       |
| Owner strings: `user@domain` or numeric; BADOWNER on untranslatable input                                                                     | 5.9                          | SHOULD       | read-only-local     | supported                     | Numeric strings returned; SETATTR never reaches translation                                                                                 | Same; domain mapping in `read-only-networked`                                                                                                             | #45   |
| Support minor versions 0 through X-1                                                                                                          | 2.7 rule 11, RFC 8178        | SHOULD       | none                | excluded                      | NFSv4.0 and 4.2 rejected                                                                                                                    | Deliberately unmet; documented as NFSv4.1 only                                                                                                            |       |
| Read-only session SHOULD NOT request PERSIST; server MUST NOT set PERSIST without a persistent reply cache                                    | 18.36.3                      | MUST         | read-only-local     | supported                     | PERSIST never set                                                                                                                           | Same                                                                                                                                                      |       |
| Callback RPC program from csa_cb_program; version 1 per RFC 5661 erratum 2291 (text says 4)                                                   | 18.36.3                      | MUST         | read-only-networked | deferred(read-only-networked) | none                                                                                                                                        | Use version 1                                                                                                                                             | #44   |

## Errata

Binding for this project: verified errata on RFC 8881 and verified errata on RFC 5661, because RFC 8881 states that deferred RFC 5661 reports "remain relevant to implementors".[^rfc8881-errata][^rfc5661-errata]

| Erratum                                                                                              | RFC  | Status   | Effect on this server                                                                     |
| ---------------------------------------------------------------------------------------------------- | ---- | -------- | ----------------------------------------------------------------------------------------- |
| 7386                                                                                                 | 8881 | verified | DESTROY_CLIENTID may be a first operation; already matched                                |
| 7324                                                                                                 | 8881 | verified | Editorial `FH4_VOLATILE_ANY` name; matched                                                |
| 2328                                                                                                 | 5661 | verified | `NFS4ERR_RESOURCE` removed from NFSv4.1; see the gap above                                |
| 2291                                                                                                 | 5661 | verified | Callback RPC version is 1; applies in `read-only-networked`                               |
| 6015                                                                                                 | 5661 | verified | CB_SEQUENCE is REQUIRED; applies in `read-only-networked`                                 |
| 3379                                                                                                 | 5661 | verified | CLIENTID_BUSY rule; matched                                                               |
| 5040                                                                                                 | 5661 | verified | Same as 7386; matched                                                                     |
| 2005, 2006, 2062, 2249, 2280, 2299, 2324, 2326, 2327, 2330, 2548, 3208, 3558, 4215, 4711, 5467, 6324 | 5661 | verified | Naming, pNFS, ACL, or client-side clarifications with no server change for these profiles |

Watch items with no conformance weight: RFC 8881 reported errata 6308, 6337, 6865, 8021 (OPEN result seqid 1, touches the stateid code), 8022, 8705, 8716, 6611; RFC 5662 reported errata 7667 and 7669;[^rfc5662] and the in-progress `draft-ietf-nfsv4-rfc8881bis` and `draft-dnoveck-nfsv4-rfc5662bis`, which would change the citation base. No RFC formally updates RFC 8881; RFC 8178 applies by reference.[^rfc8178]

## Client matrix

| Client                  | NFSv4.1              | Default negotiation                                                  | Notes for this server                                                                                                                                                                                                                              | Evidence                             |
| ----------------------- | -------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Linux kernel            | yes                  | tries 4.2, then 4.1, then 4.0, then v3[^nfs-man]                     | Rejects EXCHANGE_ID replies without exactly one pNFS role; retries BIND_CONN_TO_SESSION three times if it asked for a backchannel and was refused; treats FHEXPIRED as a stale handle; accepts numeric owners under `sec=sys`; `nconnect` up to 16 | pending #39[^linux-gate]             |
| macOS 26                | yes, new in macOS 26 | v3 unless `vers=4.1` is passed; `vers=4` means 4.0[^mount-nfs-macos] | Finder probes absent names; one-second attribute cache used in the preview                                                                                                                                                                         | manual mount 2026-09-13[^linux-gate] |
| FreeBSD                 | yes                  | highest minor the server offers                                      | Candidate third client for `stable` via a CI virtual machine                                                                                                                                                                                       | none                                 |
| Windows built-in client | no, v2 and v3 only   |                                                                      | Not a target                                                                                                                                                                                                                                       | none                                 |
| Windows ms-nfs41-client | yes                  |                                                                      | Unsigned driver; candidate third client                                                                                                                                                                                                            | none                                 |

Per-operation rows live in the [operations ledger](nfs-operations-ledger.md "refines") and attribute rows in the [attributes ledger](nfs-attributes-ledger.md "refines"). The session, replay, and lease behavior summarized here is implemented in the dispatcher.[^dispatcher]

[^rfc8881]: RFC 8881 obsoletes RFC 5661 and is the base text for every section number above.

[^rfc8881-errata]: Two verified and eight reported errata as of 2026-09-15.

[^rfc5661-errata]: Twenty-two verified, seventeen held for document update, and three rejected errata as of 2026-09-15.

[^rfc5662]: RFC 5662 remains the normative XDR; RFC 8881 Section 5.6 treats it as authoritative for attribute-number conflicts.

[^rfc8178]: RFC 8178 updates RFC 5661 and RFC 7862 with minor-versioning rules that RFC 8881 adopts by reference.

[^rpc]: Credential flavors other than AUTH_NONE and AUTH_SYS are denied with AUTH_BADCRED; AUTH_SYS values are documented as untrusted.

[^dispatcher]: Session, slot, lease, and first-operation rules are enforced in `executeCompound` and the SEQUENCE handler.

[^nfs-man]: nfs(5) documents the version ladder and `nconnect`.

[^mount-nfs-macos]: mount_nfs(8) documents minor versions 0 and 1 and the v3 default.

[^linux-gate]: Issue #39 retains the macOS result and owns the Linux client evidence.
