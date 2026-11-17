---
type: Research
title: Core and memory v1 support proposal
description: Proposes a compatibility policy and release checklist for the community core and memory packages.
status: draft
tags: [release, compatibility, migration, effect]
sources:
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/278
    title: Support and migration policy requirements
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/273
    title: Community and upstream Effect scope
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/279
    title: Core and memory v1 release requirements
  - resource: https://github.com/lloydrichards/effect-virtual-fs/pull/408
    title: Packed candidate consumer and outstanding install checks
  - resource: ../../packages/core/package.json
    title: Core export map and Effect peer range
  - resource: ../../packages/memory/package.json
    title: Memory export map and Effect peer range
  - resource: ../../.github/workflows/core-memory-runtimes.yml
    title: Pinned built-package runtime matrix
  - resource: ../../.github/workflows/pr-validation.yml
    title: Pinned host contract and packed consumer checks
  - resource: ../../apps/docs/app/content/reference/compatibility-and-limits.mdx
    title: Current compatibility and migration reference
---

# Core and memory v1 support proposal

This proposal applies to the community `@effect-vfs/core` and `@effect-vfs/memory` packages. The stable export list
and dependency minimum remain release decisions in [#273](https://github.com/lloydrichards/effect-virtual-fs/issues/273)
and [#279](https://github.com/lloydrichards/effect-virtual-fs/issues/279). The Effect port has its own acceptance
and release steps. Its initial provider profile cannot set the community compatibility promise.

## Candidate community contract

| Group               | Candidate exports                                                                                            | Proposed commitment                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Core filesystem     | `VirtualFileSystem`, `BytePath`, `Caller`, `FileHandle`, `Metadata`, `Target`, `Volume`, `VfsError`, `Watch` | Preserve documented operations, public types, structured errors, caller authority, resource lifetimes, and watch behavior.                     |
| Core workspace data | `Fixture`, `Snapshot`, `SnapshotDelta`, `Search`, `Testing`                                                  | Preserve documented construction, capture, restore, search, delta, merge, and testing behavior. Format compatibility is a separate rule below. |
| Memory adapter      | `MemoryFileSystem`, `FileSystemTesting`, `TreeTransfer`                                                      | Preserve documented Effect `FileSystem` behavior, fixture and binding semantics, test hooks, and explicitly bounded transfer behavior.         |

Review named exports and subpaths against both manifests and the packed declarations before adopting this list.
Ask for an explicit stability decision on `LiveVolume` and the version-coupled `SynchronousAdapter` subpath before
including them. Continue to document their current contracts. The private preview and internal imports are outside
the proposed promise. Native Node integration, persistence backends, and NFS use their own package contracts and
qualification. Keep the community features deferred by the first upstream port until their own migration decisions.

For the adopted stable APIs, publish compatible fixes as patches and additive APIs as minors. A change that drops an
accepted Effect version, removes a supported runtime, or breaks documented types, behavior, errors, or defaults
requires a major release with migration instructions. Test both declaration compatibility and observable filesystem
semantics. A new supported runtime or an expanded Effect range requires evidence for that configuration. Document
support changes in the release notes alongside the new tested matrix.

## Release inputs and tested configurations

The current source manifests declare `effect: "~4.1.4"`. The lockfile pins Effect and the development providers
to `4.1.4`. The peer range is wider than the tested dependency pin. Select and test the lowest supported published
Effect version for the actual v1 candidate. Align both manifests, the lockfile, platform and test provider versions,
the built declarations, and installation examples before publishing. Neither a source checkout nor an unreleased
upstream manifest version establishes a peer minimum.

| Current check             | Pinned configuration                                                          | Evidence                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Built-package runtime     | Node.js 24.21.0 and Bun 1.4.4 on Ubuntu 24.04 x64                             | Tests the published import paths in built output with the matching Effect crypto layer and asynchronous WebCrypto. |
| Host and packed candidate | Node.js 24.21.0 on Ubuntu 24.04 x64 with `@effect/platform-node-shared` 4.1.4 | Runs the shared host contract and installs both candidate tarballs in a temporary external project.                |
| Browser target            | Browser-target bundle executed under Node.js                                  | Checks bundling and a Node smoke. Browser and Worker runtime support would need their own checks.                  |

Other operating systems and runtime versions need their own evidence. Keep the public Compatibility and limits reference
as the account of tested configurations and boundaries.

## Data compatibility

Snapshot v1 stores a filesystem tree using strict newline-delimited JSON with base64 byte fields. A portable delta
has its own `effect-vfs-delta` v1 JSON/base64 format and applies only to an exact semantic base. Its persisted
identity algorithm has a separate identifier, `effect-vfs-semantic-sha256-v1`. Neither wire version refers to the
npm package version. Follow the [snapshot contract](../contracts/snapshots-and-fixtures.md) and
[delta contract](../contracts/snapshot-deltas.md) for validation, ownership and budget rules.

For v1, retain representative encoded fixtures and prove that the selected release reads the formats it promises.
Treat an incompatible decoder or identity change as a format migration. Introduce a format version or identity
identifier as required by the relevant contract, and document a tested route from the old bytes to the new format.
For deltas, preserve or recover the matching base so a replacement delta can be generated from restored snapshots.
Keep export limits and application restore limits explicit. Snapshots do not carry active scopes, watches, volume
execution options or runtime object references. Live-store images and authenticated reference keys require separate
compatibility checks.

## Migrate a 0.x application

1. Inventory imports and runtime assumptions. Keep imports on the released export map and check extensions against
   the release's adopted list. Retain the community packages while comparing a prospective Effect replacement.
2. Upgrade core and memory together. Select an Effect version admitted by both manifests and qualified by the release.
   Supply the matching `NodeCrypto.layer` or `BunCrypto.layer`, or provide `Digest` and `SecureRandom` separately.
   Use the Effect migration sections of Compatibility and limits to update custom adapters and callers. Check crypto,
   bigint metadata, positioned reads, `noFollow`, `readDirectoryEntries`, glob, and watch registration.
3. Check layer and caller assumptions. An independent memory build has fresh state. A memoized build shares state
   within its layer graph. Use `Layer.fresh` for a separate build in that graph. `make` and `layer` provide a
   privileged default filesystem containing `/tmp`. `bind` and `layerFromFixture` create no entries. Use
   `bindCaller` when application code needs an existing confined caller. See the [memory adapter contract](../contracts/memory-adapter-compatibility.md).
4. Re-run a representative workload and verify it does not touch the host unexpectedly. Check byte and string path
   conversion, scoped cleanup, permissions, and platform-specific filesystem differences. Handle watch overflow by
   rebuilding from an authoritative observation. Check native regex input policy because synchronous matching cannot
   be preempted by an Effect timeout. Keep memory-only durability separate from any storage provider guarantee.
5. Restore retained snapshots and regenerate deltas where the release changes format compatibility. Recheck both
   volume and snapshot-processing budgets against the [measured workload policy](../decisions/core/measured-workload-policy.md).
   Retain the original data until the migrated workload and its rollback path pass.

## Release checks

| Gate                                                                                          | Required evidence                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host contract [#245](https://github.com/lloydrichards/effect-virtual-fs/issues/245)           | Pass the memory and host adapter contract on the pinned host. Preserve documented differences and resource cleanup.                                                                                                                                                                       |
| Clean installs and port [#274](https://github.com/lloydrichards/effect-virtual-fs/issues/274) | Compare the exact published baseline with the candidate tarballs and the accepted Effect port in isolated projects. The existing candidate packed check covers package contents, strict declarations and a seeded build workload. Record the published baseline and port runs separately. |
| Runtime matrix [#275](https://github.com/lloydrichards/effect-virtual-fs/issues/275)          | Run built-package smoke tests on the selected minimum Effect and the proposed runtime matrix. Name the runtime, operating system, and provider versions.                                                                                                                                  |
| Workload limits [#276](https://github.com/lloydrichards/effect-virtual-fs/issues/276)         | Check the measured small-workspace policy against the candidate. Qualify a larger policy only where the intended workload requires it.                                                                                                                                                    |
| Failure and cleanup [#277](https://github.com/lloydrichards/effect-virtual-fs/issues/277)     | Preserve failure, resource lifetime, interruption and rollback invariants. Record any known failures and their disposition.                                                                                                                                                               |
| Release documentation                                                                         | Reconcile the manifests, README setup, compatibility and migration reference, and owning contracts. Run docs checks against the actual candidate and verify examples use its public APIs.                                                                                                 |
| Published smoke                                                                               | After publication, install the exact released package and provider versions in a clean external project and repeat the consumer workload.                                                                                                                                                 |

The [release workflow](../workflows/release-readiness.md) owns publication order and shared validation. Confirm upstream
ownership and the exact tested release before adding upstream migration instructions. The current packed job does
not close the port or post-publication obligations.
