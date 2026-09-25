---
type: Research Report
title: NFS namespace and metadata mutations for issue 126
description: Records internal writable namespace and SETATTR handling, reference-based core boundaries, wire evidence, and the public durability gate.
status: draft
tags: [nfs, writable, namespace, setattr]
sources:
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/126
    title: Writable namespace and metadata operations
  - id: rfc
    resource: https://www.rfc-editor.org/rfc/rfc8881.html
    title: NFSv4.1 operations and attributes
  - id: core
    resource: ../../../packages/core/src/internal/virtualFileSystem.ts
    title: Coordinated reference-based mutations
  - id: adapter
    resource: ../../../packages/nfs/src/internal/export.ts
    title: Selected-caller NFS export adapter
  - id: dispatcher
    resource: ../../../packages/nfs/src/internal/nfs4.ts
    title: NFS operation decoder and dispatcher
  - id: namespace-tests
    resource: ../../../packages/nfs/test/NfsNamespace.test.ts
    title: Namespace wire tests
  - id: setattr-tests
    resource: ../../../packages/nfs/test/NfsSetattr.test.ts
    title: Metadata wire tests
generated: { by: codex/okf, at: 2026-09-20T12:11:27Z }
---

# NFS namespace and metadata mutations for issue 126

The internal writable dispatcher implements directory and symbolic-link `CREATE`, hard-link `LINK`, type-independent `REMOVE`, `RENAME`, and core-backed `SETATTR` for size, mode, owner, group, and access/modification times. Regular files continue to be created through `OPEN`. Unsupported CREATE types and attributes are rejected before mutation. Public exports remain read-only while the [writable export scope](../../decisions/nfs/writable-export-scope.md "constrained by") and durability qualification in #144 remain open.[^issue][^dispatcher]

Each namespace operation uses the mapped caller's reference-based core method. `CREATE` checks filehandle capacity before mutation, registers the resulting reference after success, switches the compound's current filehandle to that object, and returns atomic parent change information and the applied attribute bitmap. `LINK`, `REMOVE`, and `RENAME` return coherent directory changes. Core's `removeReference` chooses file or empty-directory removal inside one volume mutation, so a direct caller cannot change the entry type between an NFS lookup and removal. `mkdirReference({ exactMode: true, mode })` preserves an explicit wire mode rather than reapplying the caller's umask.[^core][^adapter][^dispatcher]

`SETATTR` follows the [decimal-only owner decision](../../decisions/nfs/writable-owner-strings.md "constrained by"). It validates all requested fields before changing state, applies supported fields in bitmap order, and returns `attrsset` on both success and failure. Ownership denial maps to `PERM`; malformed or out-of-range owner strings map to `BADOWNER`. Size changes require a writable open or lock stateid and reject deny-write share reservations. A later failure in a compound does not roll back an earlier successful operation.[^rfc][^dispatcher][^setattr-tests] The [atomic setattr decision](../../decisions/core/atomic-setattr.md "superseded by") later replaced the per-attribute calls with one core `setattr`, so `attrsset` is now all or nothing.

An adversarial review found two wire edge cases: supported read-only attributes sent to `SETATTR` must return `INVAL`, while unsupported attributes return `ATTRNOTSUPP`; and access and modification server-time setters must be applied together so a mapped non-owner writer can use core's permitted combined timestamp operation. Wire tests cover both cases.[^rfc][^setattr-tests]

Wire tests cover namespace identity and change information, mapped permissions, invalid operands, read-only rejection, ownership strings and authority, size stateids, timestamps, partial `attrsset`, and an injected committed live image reopened with namespace and metadata changes. That reopen proves internal image persistence for the injected store. It does not qualify physical power-loss durability or enable public writable NFS; those remain in #144 and #48.[^namespace-tests][^setattr-tests]

[^issue]: Issue #126 defines the operation set and completion criteria.

[^rfc]: RFC 8881 Sections 18.4, 18.9, 18.25, 18.26, and 18.30 specify the reply shapes and partial SETATTR behavior.

[^core]: Core implements coordinated reference mutations and exact directory mode handling.

[^adapter]: The export adapter selects the mapped caller and bounds filehandle admission.

[^dispatcher]: `nfs4.ts` decodes and executes these operations only when the internal writable option is enabled.

[^namespace-tests]: `NfsNamespace.test.ts` checks wire replies and committed-image reopen.

[^setattr-tests]: `NfsSetattr.test.ts` checks wire attributes, authority, stateids, and reply bitmaps.
