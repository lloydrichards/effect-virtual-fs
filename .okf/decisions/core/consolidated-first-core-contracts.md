---
type: Decision
title: Consolidated first-core contracts
description: Fixes construction, directory, ownership, accounting, error, and commit semantics for the first core slice.
status: deprecated
tags: [core, contracts, concurrency]
sources:
  - id: core
    resource: ../../../packages/core/src/internal/virtualFileSystem.ts
    title: Root defaults, quotas, and coordination
generated: { by: claude/okf, at: 2026-09-16T23:00:00+02:00 }
---

# Consolidated first-core contracts

Retained as the record of the first core slice's accepted defaults. Its rules are now owned by the focused contracts: [permissions and metadata](/contracts/permissions-and-metadata.md "superseded by"), [capacity and limits](/contracts/capacity-and-limits.md "superseded by"), [byte ownership](/contracts/byte-ownership.md "superseded by"), and [mutation and observation](/contracts/mutation-and-observation.md "superseded by").

Root defaults to uid/gid 0 and mode 0755; the default caller is privileged with umask 0022. New directories inherit caller uid and parent gid from requested mode 0777 masked by umask. A volume captures its Effect Clock.

Core rejects shared-memory byte inputs. Root and implicit dot entries consume no entry quota; omitted quotas have no configured cap. Expected failures preserve state. Waiting is interruptible, commit publication is not, and interruption after publication does not imply rollback. Scoped acquisition closes the retention/finalizer interruption gap. Later behavior is detailed by the [implementation profile](remaining-implementation-profile.md "refined by").
