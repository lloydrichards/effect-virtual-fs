---
type: Decision
title: Writable NFS owner strings
description: Limits writable owner and owner_group translation to canonical decimal IDs and leaves ownership authority with the mapped core caller.
status: stable
tags: [nfs, writable, identity, setattr]
sources:
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/77
    title: Owner-string translation issue
  - id: rfc
    resource: https://www.rfc-editor.org/rfc/rfc8881.html#section-5.9
    title: RFC 8881 owner and owner_group interpretation
  - id: policy
    resource: nfs-authentication-and-export-policy.md
    title: NFS authentication and export policy
  - id: core
    resource: ../../../packages/core/src/internal/virtualFileSystem.ts
    title: Core caller ownership checks
  - id: encoder
    resource: ../../../packages/nfs/src/internal/nfs4.ts
    title: GETATTR owner-string encoder
generated: { by: codex/okf, at: 2026-09-20T12:00:00Z }
---

# Writable NFS owner strings

The first writable profile accepts only canonical, unsigned decimal strings for `owner` and `owner_group` on `SETATTR`: `0` or a nonzero digit followed by decimal digits, with no sign, whitespace, leading zero, or domain. The accepted range is `0` through `4294967295` inclusive, matching the unsigned 32-bit compatibility IDs in RFC 8881 Section 5.9. Core uses `Schema.Natural`, which admits larger IDs; that wider core range does not expand this NFS input range. After a successful ownership update, `GETATTR` must return the identical accepted string, unless ownership changes again. The existing encoder uses `String(metadata.uid)` and `String(metadata.gid)`, which preserves every accepted value exactly. [^encoder] Existing core IDs outside this range remain readable but are not accepted as writable owner strings. A malformed string, out-of-range value, or `name@domain` has no translation in this profile and returns `NFS4ERR_BADOWNER`. This matches the numeric representation already emitted by the [authentication and export policy](nfs-authentication-and-export-policy.md "refines").[^issue][^rfc]

No NFSv4 domain or application-supplied name mapper is introduced. RFC 8881 permits servers to choose numeric-string support and recommends `BADOWNER` when no translation exists. A name-mapping feature would need a separate policy and matching `GETATTR` representation so an accepted `SETATTR` value can be read back consistently.[^rfc]

Translating a string does not authorize a change. The existing application policy maps the connection's credential to a core caller; that caller's `chownReference` rule decides whether the requested uid or gid may be set. NFS maps an ownership restriction from this operation to `NFS4ERR_PERM`, while invalid or untranslatable owner strings return `NFS4ERR_BADOWNER`. The adapter must recognize `AccessDenied` from `chownReference` as `PERM`; the generic mapping remains `ACCESS`, as required by the [error-mapping decision](error-mapping.md "constrained by"). UID zero in a wire credential grants no privilege by itself, consistent with [explicit caller privilege](../core/explicit-caller-privilege.md "constrained by").[^core]

An unprivileged caller must own the object, cannot change its uid, and may set its gid only to the caller's primary or supplementary groups. A privileged caller may set either ID within the accepted range. Translation does not require a local account lookup.[^core]

This decision settles [#77](https://github.com/lloydrichards/effect-virtual-fs/issues/77) for implementation in [#126](https://github.com/lloydrichards/effect-virtual-fs/issues/126). Issue #126 owns implementation and tests for both attributes: exact `SETATTR` to `GETATTR` round trips at zero and the upper bound, malformed and out-of-range `BADOWNER` rejections, and ownership denials reported as `PERM`. Include leading zeros, signs, whitespace, fractions, exponent notation, empty strings, and names among rejection cases. Verify allowed primary and supplementary groups and that uid zero alone grants no privilege. This design does not enable writable dispatch or expand the read-only profiles.

[^issue]: Issue #77 records the deferred reverse-translation choice; the user accepted decimal-only translation on 2026-09-20.

[^rfc]: RFC 8881 Section 5.9 defines numeric-string support as optional, permits `BADOWNER` for values without translation, and asks the server to return accepted owner strings consistently.

[^core]: `Caller.chownReference` checks the mapped caller's privilege, ownership, primary gid, and supplementary groups.

[^encoder]: GETATTR encodes owner and owner_group with JavaScript String conversion.
