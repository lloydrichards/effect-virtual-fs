# Decisions

Accepted architectural and behavioral decisions, grouped by domain. Deprecated decisions are retained for their rationale; the linked contracts own their rules.

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
- [Watch event overflow](core/watch-event-overflow.md) is a draft proposing a bounded watch hub with an in-band rescan marker; four choices remain open.
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

## Packages, adapter, persistence, and build consumer

- [Package boundaries](package-boundaries.md)
- [Adapter timestamp overflow](adapter-timestamp-overflow.md)
- [Named checkpoint persistence](named-checkpoint-persistence.md)
- [Virtual package resolution acceptance](virtual-package-resolution-acceptance.md)
- [Explicit build rebuilds](explicit-build-rebuilds.md)
