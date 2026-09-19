---
type: Implementation Profile
title: NFS read-only-networked profile
description: States what the read-only NFSv4.1 export must do once trusted AUTH_SYS identity is mapped to VFS callers by application policy and non-loopback binding is allowed behind that policy.
status: draft
tags: [nfs, profile, read-only, identity]
sources:
  - id: decision
    resource: ../../decisions/nfs/nfs-authentication-and-export-policy.md
    title: Authentication and export policy decision
  - id: server
    resource: ../../../packages/nfs/src/NfsServer.ts
    title: Public server options
  - id: rfc8881
    resource: https://www.rfc-editor.org/rfc/rfc8881.html
    title: RFC 8881 NFSv4.1
generated: { by: claude/okf, at: 2026-09-19T10:02:47Z }
---

# NFS read-only-networked profile

`read-only-networked` is the second profile in the [NFS profile ladder](../../decisions/nfs/nfs-profile-ladder.md "implements"). It extends the [read-only-local profile](nfs-read-only-local.md "refines") with per-identity VFS authority and a trusted-network boundary, as fixed by the [authentication and export policy decision](../../decisions/nfs/nfs-authentication-and-export-policy.md "implements"). It is not a conformant NFSv4.1 server: Kerberos is permanently excluded, so it is interoperable with clients using `sec=sys`.[^rfc8881]

## Boundary

- Serves a network segment the operator controls. `AUTH_SYS` identity is trusted only from clients the application's policy vouches for; exposure to an untrusted network is unsupported.
- The application supplies the `Volume`, a peer resolver for each accepted socket, and a policy function over the decoded credential and peer. TCP peers carry the remote address and port; UNIX peers carry null address and port plus the server socket path. The policy returns deny or a VFS identity; the server mints one caller per identity, caches callers under `maxIdentities`, and checks that caller's authority for file access.[^server]
- A non-loopback bind requires the networked policy and `allowNonLoopback: true`. Networked mode also requires a peer resolver on loopback TCP and UNIX-domain sockets. Local mode needs neither.
- Everything the local profile rejects stays rejected: mutation returns `NFS4ERR_ROFS`, RPCSEC_GSS answers `AUTH_TOOWEAK`, state protection other than `SP4_NONE` is refused, filehandles remain volatile.

## Required behavior

- Distinct identities receive exactly the VFS authority the policy assigned; a denied credential receives no access and never dispatches a compound.
- ACCESS is computed through the mapped caller, so it agrees with OPEN and READ.
- SECINFO and SECINFO_NO_NAME advertise the configured `acceptedFlavors`, `[AUTH_SYS]` by default. The policy can still deny any credential in an advertised flavor.
- Client records and replay slots remain keyed by the raw credential.
- `owner` and `owner_group` remain decimal uid and gid strings.

## Current state

Implemented at `experimental` maturity by #74 and #75. Focused protocol and live TCP/UNIX socket tests cover identity mapping, denial, peer context, and non-loopback configuration. A networked kernel-client gate is not yet recorded, so this profile has not reached `preview`.

[^rfc8881]: Sections 2.2.1.1, 2.6, 5.9, and 21.

[^server]: `NfsServerOptions` is a union of local `{ volume, caller }` and networked `{ volume, policy, peer }` options. `maxIdentities` bounds the caller cache; denial and exhaustion answer RPC `AUTH_FAILED`.
