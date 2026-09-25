# Decisions

Architectural and behavioral decisions, grouped by domain. Accepted decisions are stable; a draft entry is a proposal awaiting acceptance on its tracking issue. Deprecated decisions are retained for their rationale; the linked contracts own their rules.

## Core filesystem

- [Explicit API and Effect services](core/explicit-api-and-effect-services.md)
- [Strict string filename boundary](core/strict-string-filename-boundary.md)
- [Explicit caller privilege](core/explicit-caller-privilege.md)
- [Snapshot-local file identity](core/snapshot-local-file-identity.md)
- [JSON and base64 snapshots](core/json-and-base64-snapshots.md)
- [Final-state fixtures](core/final-state-fixtures.md)
- [Volume capacity accounting](core/volume-capacity-accounting.md)
- [Independent resource lifetimes](core/independent-resource-lifetimes.md)
- [Copying byte ownership](core/copying-byte-ownership.md)
- [Explicit close and scope cleanup](core/explicit-close-and-scope-cleanup.md)
- [Schema data and capability interfaces](core/schema-data-and-capability-interfaces.md)
- [Strict snapshot version 1 decoding](core/strict-snapshot-v1-decoding.md)
- [Scope-free root callers](core/scope-free-root-callers.md)
- [Path base selection](core/path-base-selection.md)
- [Path input policy](core/path-input-policy.md)
- [Provisional path limits](core/provisional-path-limits.md)
- [Optional total path limit](core/optional-total-path-limit.md)
- [Reusable capability effects](core/reusable-capability-effects.md)
- [Reference-based mutations](core/reference-mutations.md) adds directory-reference-and-name mutation operations beside the path operations and keeps share reservations and locks in adapters.
- [Volume durability and usage facts](core/volume-durability-and-usage-facts.md) gives a volume a durability tier, an incarnation token, readable limits, and a live usage query.
- [Watch event overflow](core/watch-event-overflow.md) defines bounded per-subscriber watches, a rescan marker, and retryable volume admission.
- [Persistent tree rebuild](core/persistent-tree-rebuild.md) rebuilds the engine on a persistent volume value with one transition runner, composes staging, overlay, and watch over it, and stages the remaining serialisation and public API work as design issues.
- [Public API on targets, services, and one error family](core/public-api-targets-services-and-errors.md) addresses every verb by a Target or an Entry, provides Volume and Caller as services with layers, replaces the five error classes with one VfsError, and drops Crypto from construction.
- [Permission mode and typed mode](core/permission-mode-and-typed-mode.md) keeps `Metadata.mode` as permission bits and derives the POSIX `st_mode` from the kind through `Metadata.typedMode`.
- [Consolidated first-core contracts](core/consolidated-first-core-contracts.md) is deprecated; the focused contracts own its rules.
- [Remaining implementation profile](core/remaining-implementation-profile.md) is deprecated; the focused contracts own its rules.

## Overlay workspaces and snapshot deltas

- [Staged overlay delivery](overlay/staged-overlay-delivery.md) is the entry point for accepted overlay scope and focused decisions.
- [Overlay base and writable-state ownership](overlay/overlay-base-ownership.md)
- [Overlay content sharing](overlay/overlay-content-sharing.md)
- [Overlay final-difference summary](overlay/overlay-final-difference-summary.md)
- [Portable snapshot delta interface](overlay/portable-snapshot-deltas.md)

## NFS export

- [NFS profile ladder](nfs/nfs-profile-ladder.md) separates NFSv4.1 capability profiles from maturity labels and fixes the evidence each level requires.
- [NFS authentication and export policy](nfs/nfs-authentication-and-export-policy.md) excludes Kerberos, and maps trusted `AUTH_SYS` identity to VFS callers behind an application-supplied policy.
- [NFS filesystem error mapping](nfs/error-mapping.md) defines the core-error map and writable operation overrides.
- [Writable NFS export scope](nfs/writable-export-scope.md) records the accepted authority, operation, lock, durability, and restart milestones.
- [NFS interoperability and fault evidence](nfs/nfs-interoperability-evidence.md) fixes the pinned clients and suites, the CI and release gates, the five suite-failure classes, and the fault cases each stage needs.

## Packages, adapter, persistence, and build consumer

- [Package boundaries](package-boundaries.md)
- [Adapter timestamp overflow](adapter-timestamp-overflow.md)
- [Named checkpoint persistence](named-checkpoint-persistence.md)
- [Tree transfer](tree-transfer.md) moves directory trees as streams of fixture entries with bounded sources, rejecting sinks, and atomic new volumes.
- [Virtual package resolution acceptance](virtual-package-resolution-acceptance.md)
- [Explicit build rebuilds](explicit-build-rebuilds.md)
