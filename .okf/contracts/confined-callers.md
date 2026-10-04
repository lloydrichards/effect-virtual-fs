---
type: Contract
title: Confined callers
description: Defines identity-rooted namespace confinement, independent imported boundaries, publication-time watches, and borrowed FileSystem bindings.
status: stable
tags: [authority, callers, confinement, watches]
sources:
  - resource: ../../packages/core/src/internal/confinement.ts
    title: Draft-aware live membership checks
  - resource: ../../packages/core/src/internal/resolution.ts
    title: Confined lookup and imported bases
  - resource: ../../packages/core/src/internal/virtualFileSystem.ts
    title: Caller, handle, and coordinated mutation integration
  - resource: ../../packages/core/src/internal/callerWatch.ts
    title: Publication-time watch selection
  - resource: ../../packages/core/test/Confinement.test.ts
    title: Escape, scope, staged removal, and rejected commit acceptance
  - resource: ../../packages/core/test/CallerWatch.test.ts
    title: Alias selection, terminal delivery, and imported authority acceptance
  - resource: ../../packages/memory/test/BindCaller.test.ts
    title: Borrowed adapter and temporary cleanup acceptance
generated: { by: codex/okf, at: "2026-10-04T21:24:00+02:00" }
---

# Confined callers

Scoped `Caller.withRoot(directory)` narrows authority to a directory identity and resets cwd. Absolute paths and symbolic links resolve from that root, and `..` stops there. `withDirectory` retains its cwd meaning and inherits the boundary. Root rename preserves identity; deletion permanently invalidates it. Removing or renaming one's own root fails `NotPermitted` before mutation.

Paths, references, entry directories, imported handles, recursive stages, and direct handle methods check live membership inside the operation's coordination gate through the draft-aware namespace. Directories use live parent chains; nondirectories require a live name inside the root. Privilege never bypasses confinement. Nested roots retain ancestor boundaries. Reopening a confined handle or deriving from it retains its restrictions independently of its creator's scope. A cwd caller derived from a narrower directory handle uses the narrower visible root. Shared hard-linked files can have independently authorized aliases in disjoint roots; imported handles require both authorities.

Outside targets fail `AccessDenied`. Root removal fails `ClosedCaller` for Caller operations and `InvalidHandle` for direct handles. Membership can restore access to live capabilities, but explicit close and root deletion remain permanent. Resource close and cleanup remain available after authority loss. These rules preserve [independent scoped lifetimes](../decisions/core/independent-resource-lifetimes.md "constrained by"). Namespace confinement does not isolate contents shared through hard links or revoke separately supplied unrestricted capabilities.

`root`, root `parent`, and `realPath` expose the caller namespace. Direct file references retain their existing `realPath` failure. `Caller.limits` exposes backing-volume configuration, not subtree quotas or usage.

`Caller.watch(target, options)` selects and rebases authorized names at publication using both namespace states. Default `alias: "all"` reports in-root aliases. `alias: "resolved"` follows the path-selected name through trusted rename journaling and ends on its unlink; direct nondirectory tokens cannot select an alias. Watched-target removal/departure emits final visible `Remove` and ends. Boundary removal or ancestor departure drains queued events before terminal failure. Terminal overflow emits one bounded `Rescan` and ends. Stopped watches never resume.

Borrowed `MemoryFileSystem.bindCaller(caller)` preserves root, cwd, credentials, and umask, requests resolved watches, and translates stream failures. It creates no directories. Default temporaries require an existing confined `/tmp`. Scoped cleanup follows directory identity, retries bounded path races, and skips expected authority, lifetime, or permission loss. Optional `remove(..., { expected: reference })` pins identity at every coordinated stage; replacements fail `VolumeBusy` without being removed. `force` suppresses missing targets only.

The [authority decision](../decisions/core/confined-caller-authority.md "justified by") explains identity, revocation, and performance tradeoffs. This contract does not claim data isolation or a universal performance ceiling.
