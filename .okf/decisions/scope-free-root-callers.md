---
type: Decision
title: Scope-free root callers
description: Lets root callers share volume lifetime without a Scope or individual revocation.
status: stable
tags: [callers, lifetimes, api]
generated: { by: codex/okf, at: "2026-09-10T00:00:00Z" }
---

# Scope-free root callers

`volume.caller(options)` creates a root-based caller without requiring Scope. Root callers share the volume's lifetime, expose no close operation, and cannot be individually revoked.

Derived callers and directory handles remain independently scoped according to [resource lifetimes](./independent-resource-lifetimes.md "constrained by"). A root caller owns no descendant cleanup registry; the choice does not create a volume shutdown API or change handle-close rules.
