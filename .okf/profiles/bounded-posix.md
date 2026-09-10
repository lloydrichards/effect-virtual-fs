---
type: Implementation Profile
title: Bounded POSIX profile
description: States the project's documented POSIX-based compatibility claim for its explicit filesystem subset and distinguishes it from full conformance.
status: stable
tags: [profile, posix, compatibility]
generated: { by: codex/okf, at: 2026-09-10T00:00:00+00:00 }
---

# Bounded POSIX profile

`VirtualFileSystem` implements documented POSIX.1-2024 semantics for an explicit subset covering regular files, directories, symbolic links, hard links, supported path traversal, file handles and I/O, metadata, permissions, and namespace mutation.

This is not full POSIX conformance or certification. It is not a C filesystem API, a mounted filesystem, a simulated process, or a promise that arbitrary native software can run against a volume. Typed Effect failures replace global `errno`, Effect scopes manage resources, and implementation limits and permitted behavior are part of the public contract.

The profile includes byte-preserving names, component-by-component lookup, directory-relative bases, scoped handles with POSIX-style bigint offsets, hard-link identity, explicit caller authority, logical capacity limits, coordinated atomic operation boundaries, and snapshot capture. Adapter behavior may deliberately differ where Effect's established `FileSystem` contract requires it.

Exact supported rules live in the focused contracts linked from the [implemented filesystem profile](implemented-filesystem.md "refined by"). The boundary is [grounded in the POSIX requirements research](/research/posix-requirements.md "grounded in"). Unsupported standards and integration surfaces remain [deferred capabilities](deferred-capabilities.md "excludes").
