---
type: Decision
title: Explicit build rebuilds
description: Uses repeated explicit build calls for initial rebuild acceptance rather than watch-driven rebuilds.
status: stable
tags: [consumer, builds, watches]
generated: { by: codex/okf, at: "2026-09-10T00:00:00Z" }
---

# Explicit build rebuilds

Initial build acceptance calls the build explicitly, mutates a dependency in the same live volume, calls the build again, and verifies changed output. Both builds read through public core APIs without host staging.

Automatic watch-triggered rebuilding, scheduling, HMR, and retained-cache invalidation are follow-up integration concerns. This does not weaken the memory adapter's separate watch compatibility requirements or the [virtual package milestone](./virtual-package-resolution-acceptance.md "complements").
