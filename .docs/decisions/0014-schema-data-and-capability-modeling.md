# Schema data and capability interfaces

Status: accepted for the documentation prototype, 8 September 2026. Refines D01, D05, and D11.

## Decision

Define reusable data models with Schema and derive their TypeScript types. This includes identities, configuration,
metadata, fixture records, and snapshot image records. Use Data.TaggedError for the filesystem, configuration, and
image error families while they have no required serialization contract.

Keep Volume, Caller, FileHandle, and DirectoryHandle as capability interfaces. Keep the optional Effect service thin.
BytePath and Snapshot remain opaque values with controlled construction. A decoded image record tree is not a Snapshot.

The user approved revising the documentation prototype after reviewing the
[Effect modeling research](../context/effect-modeling.md). This accepts the modeling approach, not every field,
numeric refinement, method name, or codec policy currently represented in that prototype.

## Consequences

Schema supplies reusable field validation and codecs without separately maintained data interfaces. Data errors supply
concrete tagged Error constructors that compose with Effect. Resource ownership, authority, graph validation, byte
copying, and resource limits still need explicit implementation. Neither choice makes an object deeply immutable.

A future requirement to encode errors may justify Schema errors. It does not justify serializing live resources.
The fixture schema factory requires a real path schema; the current string-only prototype does not validate opaque paths.

## Evidence

The [prototype guide](../contracts/README.md) records checks against effect@4.0.0-rc.112 and typescript@7.0.2.
Consumer typing, ten deliberate type rejections, field constraints, snapshot example roundtripping, and tagged error
handling were checked. No core filesystem implementation or filesystem behavior was tested.
