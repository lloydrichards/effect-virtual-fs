---
type: Decision
title: Snapshot-local file identity
description: Preserves hard-link relationships across snapshots without promising persistent runtime inode numbers.
status: stable
tags: [snapshots, identity, hard-links]
generated: { by: codex/okf, at: "2026-09-10T00:00:00Z" }
---

# Snapshot-local file identity

Snapshots use image-local identifiers to preserve file identity and hard-link relationships. Restore may assign fresh runtime inode numbers; numeric inode values are not persistent identifiers.

Aliases in one image restore to one shared file. Loading the same snapshot twice creates independent volumes and identity namespaces. This decision is encoded by [JSON and base64 snapshots](./json-and-base64-snapshots.md "implemented by") and retained by [checkpoint persistence](./named-checkpoint-persistence.md "preserved by").
