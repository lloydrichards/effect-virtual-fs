---
type: Reference
title: Bounded POSIX requirements
description: Defines how POSIX.1-2024 requirements inform the virtual filesystem's deliberately bounded behavioral profile.
status: stable
tags: [posix, requirements, conformance]
sources:
  - id: posix-base-definitions
    resource: https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/contents.html
    title: POSIX.1-2024 Base Definitions
  - id: posix-system-interfaces
    resource: https://pubs.opengroup.org/onlinepubs/9799919799/functions/contents.html
    title: POSIX.1-2024 System Interfaces
generated: { by: codex/okf, at: 2026-09-10T12:00:00Z }
---

# Bounded POSIX requirements

POSIX.1-2024 Issue 8 is the behavioral reference for the supported filesystem subset. It is not a claim that this library is a complete POSIX implementation or a certified conforming environment.

For each supported operation, maintenance work should identify the applicable standard behavior, the project's chosen alternatives and limits, structured failure behavior, and executable evidence. Requirements cover path traversal, namespace mutation, handles and I/O, links, metadata, permissions, and failure atomicity. Host defaults must not silently define the virtual filesystem contract.

The project intentionally diverges where its API or runtime model differs from a C process filesystem. Paths are length-bearing strings or byte arrays and reject embedded NUL; configured byte limits therefore exclude a terminating NUL. Errors are typed `FsError` values rather than native errno numbers. Effect scopes complement explicit resource closure.

The path study produced one durable conclusion: observed dependency trees do not justify a universal total-path maximum, and an existing adapter regression uses a 12,000-byte path. The accepted policy therefore leaves total input-path length unbounded by default and allows a per-volume bound. This does not remove the separate component-length and symlink-traversal limits or imply an unlimited resource budget. See [optional total path limit](/decisions/optional-total-path-limit.md "refined by") and [capacity and limits](/contracts/capacity-and-limits.md "implemented by").

Current behavior and tests, rather than the original research ledger, determine what is implemented. The focused current contract is [paths and namespace](/contracts/paths-and-namespace.md "implemented by"). Use the [evidence and validation workflow](/workflows/evidence-and-validation.md "validated by") when changing a requirement or conformance claim.
