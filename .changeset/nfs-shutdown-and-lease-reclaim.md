---
"@effect-vfs/nfs": patch
---

Stop a departing connection from waiting on an in-flight compound, and reclaim expired leases without another client's traffic.

The connection finalizer no longer takes the handler's state gate. `Effect.ensuring` runs a finalizer uninterruptibly and `Semaphore.withPermits` waits via `restore`, so a finalizer that took the gate could not be interrupted out of the wait and was held for as long as another connection's compound ran.

Expired lease state is now swept on the handler's own schedule rather than only when some other client sends a compound. An abandoned client's opens and retained replay bytes previously stayed charged until the handler scope closed, and because replay bytes come out of a global budget, enough abandoned sessions would refuse replay caching to healthy clients.
