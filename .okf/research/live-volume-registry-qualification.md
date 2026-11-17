---
type: Research
title: Live-volume registry retention qualification
description: Records the consumer prerequisite and a repeatable backend qualification plan for registry idle retention.
status: draft
tags: [persistence, resources, measurements]
sources:
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/287
    title: Consumer prerequisite and measurement scope
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/273
    title: Effect port scope and downstream ownership
  - resource: ../contracts/live-volume-registry.md
    title: Scoped registry and canonical key contract
  - resource: ../../apps/demo-alchemy/src/notebook.ts
    title: Request-scoped notebook volume and image deletion
  - resource: ../../apps/demo-alchemy/src/notebook-worker.ts
    title: Notebook request routes and layer lifetime
  - resource: ../../apps/demo-r2-nfs/src/gateway.ts
    title: One configured R2 image per NFS gateway
  - resource: ../../apps/docs/app/lib/playground/storage.ts
    title: Browser checkpoint persistence
  - resource: ../../packages/core/test/LiveVolumeRegistry.test.ts
    title: Registry lifecycle tests
  - resource: ../../packages/persistence/test/SqliteLiveImageStore.test.ts
    title: SQLite sharing and committed-content reopen
---

# Live-volume registry retention qualification

Issue [#287](https://github.com/lloydrichards/effect-virtual-fs/issues/287) remains open. The port scope in
[#273](https://github.com/lloydrichards/effect-virtual-fs/issues/273) keeps live volumes and durable stores downstream.
It has yet to identify a consumer that needs shared ownership of dynamically opened persistent volumes. The application
inventory at `993226c01b4f3ef58cf4ffba56d537ce9ec15318` identifies one candidate to revisit when the need is established.

| Application                   | Persistence and lifetime                                                                                                                  | Qualification gap                                                                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alchemy R2 notebook           | POST creates a fresh image, GET reads and pins an existing image before opening its request scope, and DELETE removes the image directly. | Repeated GETs might avoid decoding. Retention also needs a freshness and deletion contract, an owner spanning requests, and a workload with observed key reuse. The demo has no update route for an existing notebook. |
| R2-backed NFS gateway         | Startup opens one configured image. The gateway retains that volume for the listener lifetime.                                            | The gateway already uses the direct retained-owner strategy. It has no request-driven volume acquisition to compare.                                                                                                   |
| Browser filesystem playground | The browser stores a SQLite checkpoint in IndexedDB and reopens it on command.                                                            | The saved checkpoint is a snapshot. The editor has no keyed live-image store to borrow across requests.                                                                                                                |

Recheck the inventory with `git grep -n -E 'makeRegistry|LiveVolume\.open|\.layerLive\(' -- apps packages`. Inspect the
application setup and request handlers to determine which scope owns each volume. The [registry contract](../contracts/live-volume-registry.md)
and its tests establish sharing, capacity, and release behavior. The SQLite test covers immediate owner release and reopen
with committed content. Those checks leave backend acquisition cost, lock hold time during idle retention, and an
appropriate retention policy unmeasured.

## Qualify a selected consumer

1. Record the application, backend, runtime and driver versions, image sizes, and the expected freshness and ownership
   rules. Capture a representative, sanitized trace of idle gaps, concurrent borrowers, active key counts, and operation
   mix. Choose key aliases to test according to the consumer's real storage identities.
2. Restore the same seed images before each trial. Replay the same request schedule for direct ownership retained for
   the workload, a fresh scoped open per request, and registry borrowing with immediate release and finite idle timeouts.
   For overlap on the same key, keep the fresh-open strategy within the backend's ownership rules. Record contention and
   any time spent waiting for admission.
3. Separate warmup from measured runs. Repeat each strategy in fresh processes or equivalent isolated runtime instances.
   Use the same images, backend configuration, and concurrency in every run. Record physical store acquisitions and
   decodes, request latency percentiles, process memory after borrowers release and after expiry, and the duration from
   store acquisition through completed release. Report active and idle entries, capacity failures, and acquisition errors.
4. For SQLite, try an independent owner during retention and again after expiry. Check that content survives reopen and
   that ownership release precedes a new acquisition. For a remote backend, exercise ownership rejection or an uncertain
   commit while borrowers share a volume. Establish quiescence and reconcile remotely uncertain outcomes before reopening.
   Verify recovered content. Test backend ownership coordination separately from registry sharing.
5. Evaluate bounded capacity and finite timeout candidates against the trace, including idle gaps on either side of expiry,
   a burst of new keys at capacity, and canonical aliases. Keep lifetime and correctness assertions in repeatable tests.
   Retain backend timing samples with the experiment and leave absolute timing thresholds out of ordinary tests.

For the notebook candidate, resolve GET freshness and DELETE coordination before testing retention. A Worker-local
registry cannot coordinate owners across isolates. DELETE can remove an image while an idle entry still holds its
decoded volume. The registry exposes no invalidation operation. Across the deployment, a deleted notebook must read
as absent and a later GET must never recreate it. Defer timeout, capacity, and backend recommendations until a
selected consumer has evidence for those choices.
