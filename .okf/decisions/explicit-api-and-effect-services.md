---
type: Decision
title: Explicit API and Effect services
description: Makes explicit capability objects primary while supporting a thin Effect service layer over identical behavior.
status: stable
tags: [api, effect, ownership]
generated: { by: codex/okf, at: "2026-09-10T00:00:00Z" }
---

# Explicit API and Effect services

Core supports explicit volume, caller, and handle objects plus an optional thin Effect service layer. The explicit API exposes every capability; both styles return Effect values and use the same behavior and resource management.

Volume state, caller context, and handle lifetime remain separate. Supplying a caller through a service cannot replace its volume, credentials, or working directory. This API choice follows the [package boundary](./package-boundaries.md "constrained by") and does not itself define every export or operation.
