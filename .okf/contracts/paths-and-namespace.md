---
type: Contract
title: Paths and namespace
description: Defines byte-preserving paths, lookup bases, traversal limits, link behavior, and namespace mutation.
status: stable
tags: [paths, namespace, links]
sources:
  - resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Core virtual filesystem API and implementation
  - resource: ../../packages/core/test/Links.test.ts
    title: Link and path-resolution behavior tests
  - resource: ../../packages/core/test/Namespace.test.ts
    title: Namespace behavior tests
generated: { by: codex/okf, at: 2026-09-10T00:00:00Z }
---

# Paths and namespace

String paths must be valid UTF-8 without NUL or lone surrogates. `BytePath` preserves arbitrary non-NUL filename bytes. Absolute paths ignore a supplied directory base; relative paths require a live same-volume base when one is provided.

Resolution is component-by-component: dot components resolve during lookup, root `..` clamps, and symbolic links expand in traversal order. Components are limited to 255 bytes and symlink traversal to 40; total path length is unbounded unless `maxPathBytes` is configured.

The namespace supports directories, regular files, symbolic links, hard links, rename, and removal. Open files remain usable after rename or unlink until their handles close.

This contract is constrained by [strict string results](/decisions/strict-string-filename-boundary.md "constrained by"), [path-base selection](/decisions/path-base-selection.md "constrained by"), [path input policy](/decisions/path-input-policy.md "constrained by"), and the [optional total path limit](/decisions/optional-total-path-limit.md "constrained by").
