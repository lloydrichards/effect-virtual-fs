---
type: Contract
title: Regular-file I/O
description: Defines access modes, offsets, partial writes, truncation, seeking, and handle lifetime for dense regular files.
status: stable
tags: [files, io, handles]
sources:
  - resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Core file and handle implementation
  - resource: ../../packages/core/test/File.test.ts
    title: Regular-file behavior tests
  - resource: ../../packages/core/test/WholeFile.test.ts
    title: Whole-file behavior tests
  - resource: ../../packages/core/test/ReferenceMutation.test.ts
    title: Reference-open and child-create behavior tests
generated: { by: codex/okf, at: 2026-09-18T16:40:52+02:00 }
---

# Regular-file I/O

Open supports read, write, or read-write access; creation modes; append and truncate for writable handles; and explicit final-symlink following. Separate opens have independent bigint offsets.

`openReference` opens an existing exact object for read, write, or read-write access, with optional append and truncate; omitting settings preserves read-only behavior. `openChildReference` atomically looks up or creates and opens one named child, returning its exact reference, whether it was created, and the parent directory revision transition. Initial mode and times apply only to a newly created file.

Handle operations support sequential and positional reads and writes, truncate, stat, sync, and seek from start, current position, end, data, or hole. Dense storage returns zero-filled gaps. Writes may return the prefix that fits a quota; zero progress fails. Whole-file writes and truncation preflight required growth.

Closing one handle does not close another. Unlinked open files remain alive and charged until their final handle closes.

The implemented choices are consolidated in [remaining implementation policy](../decisions/core/remaining-implementation-profile.md "constrained by").
