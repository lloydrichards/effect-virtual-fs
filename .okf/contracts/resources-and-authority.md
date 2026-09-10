---
type: Contract
title: Resources and authority
description: Separates shared volume state from caller authority and independently scoped file and directory capabilities.
status: stable
tags: [resources, authority, scope]
sources:
  - resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Core capability interfaces
  - resource: ../../packages/core/test/EffectReuse.test.ts
    title: Reusable Effect and capability tests
  - resource: ../../packages/core/test/VirtualFileSystem.test.ts
    title: Volume and caller behavior tests
generated: { by: codex/okf, at: 2026-09-10T00:00:00Z }
---

# Resources and authority

A volume owns namespace and file state. A caller carries credentials, supplementary groups, working-directory identity, and umask. File and directory handles are opaque capabilities with independent state and lifetimes.

Root callers need no scope. Derived callers and open handles are scoped. Explicit repeated close fails, while scope cleanup tolerates a resource already released. Metadata operations through handles use the invoking caller's authority; open-time file access remains usable after later permission changes.

Privilege is explicit and independent of uid. The convenient root caller defaults to privileged uid and gid zero, but this API-level authority is not a JavaScript sandbox.

See [explicit API and services](/decisions/explicit-api-and-effect-services.md "constrained by"), [independent resource lifetimes](/decisions/independent-resource-lifetimes.md "constrained by"), and [scope-free root callers](/decisions/scope-free-root-callers.md "constrained by").
