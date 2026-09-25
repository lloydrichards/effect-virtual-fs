---
type: Decision
title: Explicit API and Effect services
description: Makes explicit capability objects primary while supporting a thin Effect service layer over identical behavior.
status: stable
tags: [api, effect, ownership]
sources:
  - id: core
    resource: ../../../packages/core/src/VirtualFileSystem.ts
    title: Public API and Effect services
generated: { by: claude/okf, at: "2026-09-25T22:30:00+02:00" }
---

# Explicit API and Effect services

Core supports explicit volume, caller, and handle objects plus an optional thin Effect service layer. The explicit API exposes every capability; both styles return Effect values and use the same behavior and resource management.

Volume state, caller context, and handle lifetime remain separate. Supplying a caller through a service cannot replace its volume, credentials, or working directory. The [public API decision](public-api-targets-services-and-errors.md "extended by") names the services `Volume` and `Caller` and gives them the layers that wrap the explicit constructors. This API choice follows the [package boundary](../package-boundaries.md "constrained by") and does not itself define every export or operation.
