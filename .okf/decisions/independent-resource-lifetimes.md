---
type: Decision
title: Independent resource lifetimes and explicit authority
description: Separates caller and handle lifetimes while applying the invoking caller's authority to metadata and lookup.
status: stable
tags: [resources, lifetimes, authority]
generated: { by: codex/okf, at: "2026-09-10T00:00:00Z" }
---

# Independent resource lifetimes and explicit authority

Derived callers and handles belong to their acquiring scopes and can outlive the caller from which they were derived. Finalizing one owner does not revoke independently owned live resources. Explicitly closing a shared handle invalidates that handle for every holder.

Open-file I/O uses access granted at open. Authority-sensitive metadata changes and lookup from directory bases use the invoking caller's credentials, never privilege inherited from the opener. [Close semantics](./explicit-close-and-scope-cleanup.md "refined by") define exact release behavior.
