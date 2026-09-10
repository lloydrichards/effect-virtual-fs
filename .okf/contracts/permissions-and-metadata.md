---
type: Contract
title: Permissions and metadata
description: Defines explicit identity-based access checks and owned metadata with nanosecond timestamps.
status: stable
tags: [permissions, metadata, timestamps]
sources:
  - resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Identity, access, and metadata implementation
  - resource: ../../packages/core/test/Metadata.test.ts
    title: Permission and metadata behavior tests
  - resource: ../../packages/memory/test/Timestamp.test.ts
    title: Adapter timestamp boundary tests
generated: { by: codex/okf, at: 2026-09-10T00:00:00Z }
---

# Permissions and metadata

Callers carry uid, gid, supplementary groups, explicit privilege, and umask. Traversal and operations apply owner, group, and other mode checks; new entries inherit the parent gid and apply the caller's umask.

Metadata includes file kind, identity, link count, size, ownership, mode, and bigint nanosecond timestamps. Returned metadata is copied. Core timestamps use the Effect clock without promising physical nanosecond precision.

The memory adapter converts timestamps to JavaScript `Date` values and reports typed `InvalidData` when a core timestamp cannot be represented.

This contract [depends on the resource and authority model](/contracts/resources-and-authority.md "depends on") and implements [explicit caller privilege](/decisions/explicit-caller-privilege.md "implements") and [adapter timestamp overflow](/decisions/adapter-timestamp-overflow.md "implements").
