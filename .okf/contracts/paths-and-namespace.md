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
generated: { by: claude/okf, at: "2026-09-25T22:30:00+02:00" }
---

# Paths and namespace

String paths must be valid UTF-8 without NUL or lone surrogates. `BytePath` preserves arbitrary non-NUL filename bytes. Its Effect equality and hash are derived from those bytes in order, and it supports Effect-style pipe composition. Absolute paths ignore a supplied directory base; relative paths require a live same-volume base when one is provided.

Resolution is component-by-component: dot components resolve during lookup, root `..` clamps, and symbolic links expand in traversal order. Components are limited to 255 bytes and symlink traversal to 40; total path length is unbounded unless `maxPathBytes` is configured.

The namespace supports directories, regular files, symbolic links, hard links, rename, and removal. Open files remain usable after rename or unlink until their handles close.

Path-addressed and entry-addressed operations share one mutation body and one check order per verb, Linux's: the directory resolves first, search permission on it is checked before any name in it is looked up, then a reserved or existing name, trailing slashes and rename's same-object and subtree rules are reported, then write permission is checked. A removed directory that a handle still holds takes no new children, and a string entry name must be well-formed like a string path. A dot or dot-dot final name renders by addressing mode: `AlreadyExists` for path `mkdir`, `link`, and `symlink`, `IsDirectory` for path `unlink` and `open`, `InvalidArgument` for path `rmdir` and `rename` and for every entry-addressed verb. A gone object is `NotFound` by path, `StaleReference` by reference, and `InvalidHandle` by handle. Trailing-slash rules exist only for paths and follow Linux: `mkdir` accepts one and `rmdir` ignores one, a slash on an existing name still reports that name, linking or symlinking onto a missing slashed name is `NotFound`, creating through a slashed name is `IsDirectory`, and a directory may move to a missing slashed name while a file may not. Path errors name the path as bytes; a symbolic link target that fails is named on both addressing modes; entry-addressed failures name no path, and no error names a path that a byte path could not hold, such as an empty one or one with a NUL. The [public API decision](../decisions/core/public-api-targets-services-and-errors.md "decided by") settled these codes, and a side-by-side test pins each namespace and metadata outcome.

This contract is constrained by [strict string results](../decisions/core/strict-string-filename-boundary.md "constrained by"), [path-base selection](../decisions/core/path-base-selection.md "constrained by"), [path input policy](../decisions/core/path-input-policy.md "constrained by"), and the [optional total path limit](../decisions/core/optional-total-path-limit.md "constrained by").
