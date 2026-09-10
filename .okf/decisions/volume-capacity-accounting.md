---
type: Decision
title: Volume capacity accounting
description: Accounts content once per inode and directory entries once per name, retaining charges for open unlinked files.
status: stable
tags: [capacity, storage, hard-links]
generated: { by: codex/okf, at: "2026-09-10T00:00:00Z" }
---

# Volume capacity accounting

Stored file-content bytes and directory entries have separate limits. Content is charged once per inode regardless of hard-link count; each directory name consumes an entry. An unlinked file remains charged while an open handle keeps it alive and is reclaimed after the last reference closes.

Snapshot copies and encoding memory are outside live-volume quota. These are logical usage limits, not JavaScript heap bounds. Concrete regular-file limits are refined in the [implementation profile](./remaining-implementation-profile.md "refined by").
