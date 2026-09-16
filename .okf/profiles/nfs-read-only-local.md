---
type: Implementation Profile
title: NFS read-only-local profile
description: States what the read-only loopback NFSv4.1 export must do, what it deliberately rejects, and what it currently lacks.
status: draft
tags: [nfs, profile, read-only]
sources:
  - id: dispatcher
    resource: ../../packages/nfs/src/internal/nfs4.ts
    title: NFSv4.1 compound dispatcher
  - id: server
    resource: ../../packages/nfs/src/NfsServer.ts
    title: Public server configuration and limits
  - id: readme
    resource: ../../packages/nfs/README.md
    title: NFS package README
  - id: rfc8881
    resource: https://www.rfc-editor.org/rfc/rfc8881.html
    title: RFC 8881 NFSv4.1
generated: { by: claude/okf, at: 2026-09-15T23:00:00+02:00 }
---

# NFS read-only-local profile

`read-only-local` is the first profile in the [NFS profile ladder](/decisions/nfs-profile-ladder.md "implements"). It is a protocol-complete read-only NFSv4.1 export of one live volume for a trusted local user. It is not a conformant NFSv4.1 server; RFC 8881 requires Kerberos, backchannels, and trunking that this profile excludes.[^rfc8881]

## Boundary

- Binds only to `127.0.0.1` or `::1`; the application owns the socket and platform adapter.[^server]
- One application-supplied privileged caller performs every volume operation. `AUTH_NONE` and `AUTH_SYS` credentials are decoded and never trusted; `RPCSEC_GSS` is refused.
- Sessions, client ids, and filehandles are volatile per server process. Restart requires a client remount.
- No backchannel, no delegations, no locks, no grace period, no pNFS.

## Required behavior

- Every REQUIRED operation in RFC 8881 Section 17 is decoded and answered with an operation-valid result. Mutating operations return `NFS4ERR_ROFS`. OPTIONAL operations and the five NFSv4.0 must-not-implement operations return `NFS4ERR_NOTSUPP`. `NFS4ERR_OP_ILLEGAL` is reserved for undefined opcodes.
- All fourteen REQUIRED attributes are returned with truthful values, and RECOMMENDED attributes are advertised only where the volume can report them without inventing values.
- Sessions provide exactly-once semantics for every request, and the compound, error, and string rules in the protocol rules ledger hold.
- Every error code emitted exists in NFSv4.1.

## Current state

Every REQUIRED operation has an operation-valid answer: the read path is implemented, mutating operations return `NFS4ERR_ROFS` after structural checks, the five NFSv4.0 operations and every unimplemented OPTIONAL operation return `NFS4ERR_NOTSUPP`, and only undefined opcodes return `NFS4ERR_OP_ILLEGAL`.[^dispatcher] Client records follow the EXCHANGE_ID cases of RFC 8881 Section 18.35.4, and no error code outside NFSv4.1 is emitted. Row-level status lives in the [operations ledger](/research/nfs-operations-ledger.md "evidenced by"), the [attributes ledger](/research/nfs-attributes-ledger.md "evidenced by"), and the [protocol rules ledger](/research/nfs-protocol-rules-ledger.md "evidenced by"). The remaining `gap` rows for this profile are the space and file-count attributes, which need live usage from core (#46), and `SP4_MACH_CRED` handling (#45).

This profile is `preview`: the focused protocol suites pass and the [external suite baseline](/evidence/nfs-external-suite.md "supported by") records a pinned pynfs run with every failure classified, a macOS 26.6.2 client run, and a repeatable Linux kernel-client gate, each passing every scripted read-side check. The Linux gate also confirmed that a bare mount ladders from 4.2 down to 4.1. It becomes `stable` once a third independent client, fault coverage, and a recorded Bake-a-thon participation exist. The package README states the current maturity.[^readme] The profile is [constrained by explicit caller privilege](/decisions/explicit-caller-privilege.md "constrained by") and reuses the core [object references](/research/object-references.md "depends on") and [mutation revisions](/research/mutation-revisions.md "depends on") for filehandle identity and change attributes.

[^rfc8881]: Sections 2.2.1.1.1, 2.10.3, 2.10.5, and 17.

[^server]: `LoopbackHost` accepts only the two literal loopback addresses, and limits are validated Effect schemas.

[^dispatcher]: The opcode table, executor switch, and `NFS4ERR_ROFS` fallthrough define current behavior.

[^readme]: The README states scope, the mount command, and the maturity label.
