---
type: Decision
title: Snapshot-local file identity
description: Preserves hard-link relationships across snapshots through the inode numbers a snapshot carries, without promising them across independent volumes.
status: stable
tags: [snapshots, identity, hard-links]
sources:
  - id: images
    resource: ../../../packages/core/src/internal/tree.ts
    title: Nodes keyed by inode number
generated: { by: codex/okf, at: "2026-09-10T00:00:00Z" }
---

# Snapshot-local file identity

Snapshots identify each object by its inode number, and a hard-linked file is one node listing every name that reaches it. Restoring a snapshot keeps those numbers and resumes the allocator past the largest, so a volume restored from a captured or decoded snapshot reports the inode numbers the snapshot holds. Fixtures and applied deltas number their objects in their own order, and independently built volumes share no numbering, so inode values still do not identify an object across volumes.

Aliases in one image restore to one shared file. Loading the same snapshot twice creates independent volumes and identity namespaces. This decision is encoded by [JSON and base64 snapshots](json-and-base64-snapshots.md "implemented by") and retained by [checkpoint persistence](../named-checkpoint-persistence.md "preserved by").
