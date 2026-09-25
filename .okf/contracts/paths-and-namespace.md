---
type: Contract
title: Paths and namespace
description: Defines byte-preserving paths, lookup bases, traversal limits, link behavior, and namespace mutation.
status: stable
tags: [paths, namespace, links]
sources:
  - resource: ../../packages/core/src/BytePath.ts
    title: Public byte path model
  - resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Core virtual filesystem API and implementation
  - resource: ../../packages/core/test/BytePath.test.ts
    title: Byte path value behavior tests
  - resource: ../../packages/core/test/Links.test.ts
    title: Link and path-resolution behavior tests
  - resource: ../../packages/core/test/Namespace.test.ts
    title: Namespace behavior tests
  - resource: ../../packages/core/test/OperationFamilies.test.ts
    title: Side-by-side path and reference outcomes
generated: { by: claude/okf, at: 2026-09-25T12:00:00+02:00 }
---

# Paths and namespace

String paths must be valid UTF-8 without NUL or lone surrogates. `BytePath` preserves arbitrary non-NUL filename bytes. Its Effect equality and hash are derived from those bytes in order, and it supports Effect-style pipe composition. Absolute paths ignore a supplied directory base; relative paths require a live same-volume base when one is provided.

Resolution is component-by-component: dot components resolve during lookup, root `..` clamps, and symbolic links expand in traversal order. Components are limited to 255 bytes and symlink traversal to 40; total path length is unbounded unless `maxPathBytes` is configured.

The namespace supports directories, regular files, symbolic links, hard links, rename, and removal. Open files remain usable after rename or unlink until their handles close.

Path-addressed and reference-addressed operations share one mutation body per verb but validate separately, so some inputs fail with different codes. A dot or dot-dot final name fails as `AlreadyExists` for path `mkdir`, `link`, and `symlink`, as `IsDirectory` for path `unlink` and `open`, and as `InvalidArgument` for path `rmdir`, path `rename`, and every reference verb. Reference verbs validate their names before resolving any directory, while path verbs locate and authorize the parent first; `symlink` checks its target before coordination in both families. Trailing-slash rules exist only for paths, and they apply after an existing name is reported, so a slash on an existing name still fails as `AlreadyExists`; a reference name that contains a slash fails as `InvalidArgument`. A removed target fails as `NotFound` by path and as `StaleReference` by reference. Path errors name the path, except that `chmod` and `chown` name it only when the lookup fails. Reference errors name none, with two exceptions: reference lookup, parent, and directory-observation denials report a placeholder `/`, and an `openChildReference` that follows a final symbolic link names that link's entry when the lookup fails. Only reference verbs accept an exact mode, explicit creation times, an expected child, an initial size, or an owner. These codes are provisional. A side-by-side test pins each namespace and metadata outcome so it cannot change by accident, and the [public API redesign](https://github.com/lloydrichards/effect-virtual-fs/issues/186 "deferred to") decides whether to align them. Memory's recursive directory creation relies on the path `mkdir` dot-name code.

This contract is constrained by [strict string results](../decisions/core/strict-string-filename-boundary.md "constrained by"), [path-base selection](../decisions/core/path-base-selection.md "constrained by"), [path input policy](../decisions/core/path-input-policy.md "constrained by"), and the [optional total path limit](../decisions/core/optional-total-path-limit.md "constrained by").
