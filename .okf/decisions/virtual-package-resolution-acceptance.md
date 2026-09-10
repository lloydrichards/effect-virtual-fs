---
type: Decision
title: Virtual package resolution acceptance
description: Adds a bounded virtual node_modules import milestone after the basic relative-dependency build case.
status: stable
tags: [consumer, builds, packages]
generated: { by: codex/okf, at: "2026-09-10T00:00:00Z" }
---

# Virtual package resolution acceptance

Consumer acceptance has two stages: first build an entry with a relative dependency, then build an entry importing a package already present in the volume's `node_modules` tree. The package must be resolved through public core APIs without staging virtual sources or silently falling back to host dependencies.

Resolution belongs to the consumer integration. This milestone does not require a package manager, downloads, arbitrary plugin compatibility, or complete Node resolution semantics. Rebuilds follow the [explicit rebuild policy](./explicit-build-rebuilds.md "constrained by").
