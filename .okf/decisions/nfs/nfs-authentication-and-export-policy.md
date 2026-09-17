---
type: Decision
title: NFS authentication and export policy
description: Fixes the security boundary of the NFS profiles, excludes Kerberos permanently, and defines how trusted AUTH_SYS identity maps to VFS callers behind an application-supplied policy.
status: stable
tags: [nfs, security, identity, export, profile]
sources:
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/45
    title: Authentication, identity, and export policy design issue
  - id: rfc8881
    resource: https://www.rfc-editor.org/rfc/rfc8881.html
    title: RFC 8881 NFSv4.1
  - id: rfc5531
    resource: https://www.rfc-editor.org/rfc/rfc5531.html
    title: RFC 5531 RPC and auth_stat values
  - id: rpc
    resource: ../../../packages/nfs/src/internal/rpc.ts
    title: RPC credential handling
  - id: dispatcher
    resource: ../../../packages/nfs/src/internal/nfs4.ts
    title: Compound dispatcher, ACCESS, EXCHANGE_ID, SECINFO
  - id: server
    resource: ../../../packages/nfs/src/NfsServer.ts
    title: Server options and bound-address schemas
  - id: core
    resource: ../../../packages/core/src/internal/virtualFileSystem.ts
    title: Core caller creation and authorization
  - id: kerberos-npm
    resource: https://github.com/mongodb-js/kerberos
    title: mongodb-js kerberos native binding
  - id: buildbarn
    resource: https://github.com/buildbarn/bb-remote-execution
    title: Buildbarn userspace NFSv4.1 server
generated: { by: claude/okf, at: 2026-09-16T21:30:00+02:00 }
---

# NFS authentication and export policy

Accepted by the user on 2026-09-16 while resolving issue #45.[^issue] Authentication, owner strings, and VFS authority are related but distinct, and this concept fixes each for the two read-only profiles of the [NFS profile ladder](nfs-profile-ladder.md "refines").

## Security boundary

- `read-only-local` serves one trusted user on the same host. It accepts a socket bound to loopback TCP or to a UNIX-domain socket path; both are reachable only from the host, so both count as local.[^server] One application-supplied privileged caller performs every volume operation and `AUTH_SYS` fields never select authority.
- `read-only-networked` serves a trusted network: a segment the operator controls, where `AUTH_SYS` identity is accepted only from clients the application vouches for. RFC 8881 Section 21 constrains `AUTH_SYS` to exactly this setting.[^rfc8881] Exposure to an untrusted network is unsupported in every profile, because the protocol offers no stronger authentication than Kerberos and Kerberos is excluded below.
- Protocol authentication stays in `@effect-vfs/nfs`. Deciding which identities are trusted, and what VFS authority they receive, is the application's policy and crosses the package boundary through one function.

## Security flavors

- RPCSEC_GSS with Kerberos V5 is a server MUST in RFC 8881 Sections 2.2.1.1.1.1 and 2.2.1.1.1.2. It is recorded as a permanently unmet MUST. The only server-side building block in the JavaScript ecosystem is a native Kerberos binding that exposes context acceptance but not the per-message integrity and privacy primitives a server needs, and it drags in a system Kerberos library; the RPCSEC_GSS framing would be written from scratch.[^kerberos-npm] Consequently no profile ever claims conformance. The ladder describes every profile as _interoperable_ or _protocol-complete_. A future issue may reopen this if a viable acceptor appears.
- RPCSEC_GSS credentials are refused with `AUTH_TOOWEAK`, the RFC 5531 signal that the server requires different authentication.[^rfc5531][^rpc] Flavor 6 is refused on the flavor alone, without decoding a GSS credential envelope this server implements no part of. Unknown flavors and malformed `AUTH_SYS` credentials keep `AUTH_BADCRED`. A refused credential never dispatches a compound, so no rejection widens access.
- `AUTH_NONE` is a flavor the policy sees and decides, exactly like `AUTH_SYS`. SECINFO and SECINFO_NO_NAME advertise the flavors the policy declares it accepts, in server preference order: `[AUTH_SYS, AUTH_NONE]` for `read-only-local`, `[AUTH_SYS]` by default for `read-only-networked`. No anonymous identity constant lives in the package.

## Identity mapping

- The application supplies a policy function. Its input is the decoded credential (flavor, uid, gid, supplementary groups, machine name) and the peer (address, port, transport `tcp` or `unix`). Its output is deny or a VFS identity `{ uid, gid, groups, privileged }`. The package ships no client allow-list syntax; peer filtering is the policy's job.
- The server, not the application, mints callers. `read-only-networked` receives the `Volume` and calls `volume.caller` once per distinct identity, caching callers under a new bounded limit and failing closed under pressure rather than sharing a caller between identities.[^core] Root squash is therefore a policy that never returns `privileged: true`. The `caller` option remains the `read-only-local` shorthand.
- The client-record principal and the slot replay identity stay derived from the raw credential, as Linux nfsd does, so two credentials squashed to one identity do not share client ownership.[^dispatcher]
- ACCESS is advisory in `read-only-local`: it reports mode bits against the wire identity while OPEN and READ run through the privileged caller with no mode check. In `read-only-networked` ACCESS asks the mapped caller, so ACCESS and OPEN agree by construction. This also exposes that core skips authorization in two reference operations, which #76 owns.
- `owner` and `owner_group` stay bare decimal uid and gid strings in both read-only profiles. Core has no name source, numeric ids are exactly what `AUTH_SYS` carries, and both the Linux client under `sec=sys` and macOS accept them. Section 5.9 permits this form. Translating client-supplied strings and answering `NFS4ERR_BADOWNER` arrive with `writable` under #77.

## Binding

A non-loopback bind is accepted only when the options carry both the policy function and an explicit opt-in flag that acknowledges the trusted-network boundary; either one missing fails as a `ConfigurationError`. The flag exists so that supplying a policy alone cannot widen exposure unnoticed. The design follows the Buildbarn userspace server, which parses `AUTH_SYS`, runs an application policy over it, refuses every other flavor, and binds loopback or a UNIX socket by default.[^buildbarn]

## State protection

`SP4_MACH_CRED` and `SP4_SSV` require an RPCSEC_GSS integrity-protected EXCHANGE_ID (Section 18.35.3). The server rejects them with `NFS4ERR_INVAL` and `NFS4ERR_ENCR_ALG_UNSUPP`, the answers Linux nfsd gives, and only encodes `SP4_NONE` for `SP4_NONE` requests.[^dispatcher] With Kerberos excluded this rejection is permanent, so the ledger row moves from a gap to a rejection by design and connection association stays unconditional under Section 2.10.3.1.

## Consequences

The [read-only-networked profile](/profiles/nfs/nfs-read-only-networked.md "refined by") states the resulting boundary. Identity mapping lands under #74 and non-loopback binding under #75. Mapping external identity onto callers is [constrained by explicit caller privilege](/decisions/core/explicit-caller-privilege.md "constrained by") and by the [resources and authority contract](/contracts/resources-and-authority.md "constrained by"): privilege is a policy output, never inherited from a wire uid of zero. Row status lives in the [protocol rules ledger](/research/nfs/nfs-protocol-rules-ledger.md "evidenced by").

[^issue]: Issue #45 holds the original questions; the review session's decisions are recorded here.

[^rfc8881]: Sections 2.2.1.1, 2.6, 5.9, 18.29, 18.35.3, and 21.

[^rfc5531]: Section 9 defines `AUTH_BADCRED` (1) and `AUTH_TOOWEAK` (5).

[^rpc]: `decodeAuth` answers flavor 6 with `AUTH_TOOWEAK` and every other unsupported flavor with `AUTH_BADCRED`; decoded `AUTH_SYS` fields are documented as untrusted.

[^dispatcher]: `grantedAccess` documents the advisory ACCESS boundary; `principalKey` and `credentialsKey` derive from the raw credential; EXCHANGE_ID rejects `SP4_MACH_CRED` and `SP4_SSV`.

[^server]: `NfsServerAddress` accepts a loopback TCP address or a UNIX-domain socket path.

[^core]: `volume.caller` is the only way to set identity; callers are cheap, scope-free, and carry `uid`, `gid`, `groups`, and `privileged`.

[^kerberos-npm]: The binding offers `initializeServer` and `step` but no server-side `wrap`, `unwrap`, or MIC operations, and requires libkrb5 or Heimdal.

[^buildbarn]: `system_authenticator.go` parses `AUTH_SYS` into policy input and answers other flavors with `AUTH_BADCRED`; EXCHANGE_ID always returns `SP4_NONE`.
