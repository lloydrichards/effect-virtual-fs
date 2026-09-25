---
type: Decision
title: Layer-based test volume
description: Gives tests one public Testing module over the Volume and Caller layers, a fresh volume per test by default, and one NFS harness with a single lease-options constant.
status: stable
tags: [testing, services, layers]
sources:
  - id: testing
    resource: ../../../packages/core/src/Testing.ts
    title: layer, callerAs and collectChanges
  - id: testing-tests
    resource: ../../../packages/core/test/Testing.test.ts
    title: Behaviour of the Testing helpers
  - id: text
    resource: ../../../packages/core/test/support/text.ts
    title: Core test text helpers over the public BytePath toolkit
  - id: nfs-harness
    resource: ../../../packages/nfs/test/support/harness.ts
    title: NFS export, handler and session factory
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/183
    title: A layer-based test volume across packages
generated: { by: claude-code, at: "2026-09-26T10:20:00+02:00" }
---

# Layer-based test volume

Follows the [public API decision](public-api-targets-services-and-errors.md "follows"), which made `Volume` and `Caller` services with layers. The decisions were grilled on 2026-09-25 and recorded on [issue #183](https://github.com/lloydrichards/effect-virtual-fs/issues/183 "decided on").

## Context

Every suite built a volume and a caller by hand: core called `Vfs.make(` 159 times and `.caller(` 267 times, and 27 core files imported a `TestEffect.ts` whose only job was to provide `BunCrypto` to every test. Watch collection was copied 17 times, two tests built a whole `Clock` object inline, and five files imported `internal/bytePath` for a text helper. Memory kept six `it.layer(Layer.empty)` wrappers from a removed crypto shim. NFS repeated its handler options block 116 times and had five local factories.

## Decisions

1. **A public `@effect-vfs/core/Testing` subpath.** It is pure Effect with no test-runner dependency, so downstream applications get the same helpers. It holds plain functions over the service layers, not a new service: `layer(options?)` provides a fresh volume (empty or from a fixture) and a root caller on it, `callerAs(identity)` makes a caller on the volume in context, and `collectChanges(stream, n)` forks the collection into the scope and returns the join. `VolumeTestSeams` stays internal.
2. **Isolation.** `it.layer` builds once per describe block, so its tests share one volume. Tests that need their own state provide `Testing.layer()` per test, which is the default in every suite.
3. **Clock.** The two tests that count clock samples or feed invalid times keep a local clock helper in their own file. There is no shared clock layer.
4. **`TestEffect.ts` is deleted.** Crypto is optional after the public API change; the snapshot-delta suites and the one tracing test that run delta operations provide it themselves. Byte-path helpers use the public `BytePath` toolkit. Codec whitebox imports stay for #185, which rewrites those modules.
5. **NFS harness.** One factory in the test support module produces the export, the handler and the session from a caller, with the lease options as one shared constant and overrides for the options a test is about. Protocol whitebox tests stay.
6. **One pull request**, with a commit per package, this note and a minor changeset for the new subpath.

## Consequences

Constructors stay by hand where they are the subject: option validation, isolation between executions, clock capture, restores, overlays, fixtures, live volumes, a foreign second volume, volume facts, and the tracing of the constructor and of snapshot deltas. Every other test, including shared arrange fixtures, takes its volume from `Testing.layer`. Persistence needed no change, because every volume its suites build is such a subject.
