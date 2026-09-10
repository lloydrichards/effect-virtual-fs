---
type: Decision
title: Adapter timestamp overflow
description: Converts unrepresentable core timestamps into typed adapter InvalidData failures without altering core metadata.
status: stable
tags: [adapter, timestamps, errors]
generated: { by: codex/okf, at: "2026-09-10T00:00:00Z" }
---

# Adapter timestamp overflow

Memory adapter path and handle stat fail with typed `PlatformError` reason `InvalidData` when atime, mtime, or birthtime cannot be represented as JavaScript `Date`. The whole observation fails and identifies the field plus path or descriptor; core metadata stays unchanged.

Nanoseconds truncate toward zero to milliseconds. Exact positive and negative Date boundaries are valid, ctime is not converted, and successful observations own their Date objects. This prevents valid core values from becoming adapter defects or silently clamped dates.
