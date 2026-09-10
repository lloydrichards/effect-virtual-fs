---
type: Decision
title: Reusable capability effects
description: Exposes zero-argument capabilities as reusable Effect properties whose executions observe fresh state.
status: stable
tags: [effect, api, resources]
generated: { by: codex/okf, at: "2026-09-10T00:00:00Z" }
---

# Reusable capability effects

DirectoryHandle exposes `stat` and `close`, FileHandle exposes `stat`, `sync`, and `close`, and Volume exposes `watch` and `snapshot` as Effect properties. Each execution observes current state; reuse caches neither observations, snapshots, subscriptions, nor close results.

Each watch execution acquires an independent scoped subscription. Repeated explicit close still fails and scope cleanup remains idempotent. This [supersedes callable syntax](./explicit-close-and-scope-cleanup.md "supersedes syntax in") without changing its lifetime and release rules.
