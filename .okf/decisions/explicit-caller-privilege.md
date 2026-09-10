---
type: Decision
title: Explicit caller privilege
description: Models privilege independently from user and group identity and never inherits it from the host process.
status: stable
tags: [authority, callers, permissions]
generated: { by: codex/okf, at: "2026-09-10T00:00:00Z" }
---

# Explicit caller privilege

Privilege is an explicit caller property, separate from uid, primary gid, and supplementary groups. UID zero alone does not grant privilege. The convenient default caller is privileged, while explicitly unprivileged callers receive normal permission checks.

Identity and privilege never come from the host process or mutable volume-global state. Privilege bypasses only documented permission checks, not invalid arguments, wrong file kinds, capacity limits, or every permission rule.
