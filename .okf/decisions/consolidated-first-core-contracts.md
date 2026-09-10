---
type: Decision
title: Consolidated first-core contracts
description: Fixes construction, directory, ownership, accounting, error, and commit semantics for the first core slice.
status: stable
tags: [core, contracts, concurrency]
generated: { by: codex/okf, at: "2026-09-10T00:00:00Z" }
---

# Consolidated first-core contracts

Root defaults to uid/gid 0 and mode 0755; the default caller is privileged with umask 0022. New directories inherit caller uid and parent gid from requested mode 0777 masked by umask. A volume captures its Effect Clock.

Core rejects shared-memory byte inputs. Root and implicit dot entries consume no entry quota; omitted quotas have no configured cap. Expected failures preserve state. Waiting is interruptible, commit publication is not, and interruption after publication does not imply rollback. Scoped acquisition closes the retention/finalizer interruption gap. Later behavior is detailed by the [implementation profile](./remaining-implementation-profile.md "refined by").
