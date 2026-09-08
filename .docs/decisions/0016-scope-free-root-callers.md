# Scope-free root callers

Status: accepted, 8 September 2026. Resolves root-caller construction lifetime in D01 and D09.

## Decision

`volume.caller(options)` constructs a caller based at the volume root without requiring Scope. Root callers share the
volume's lifetime and expose no public close operation. They cannot be individually revoked.

Derived callers and directory handles remain scoped. Each owns its acquired directory reference independently under
[decision 0011](0011-independent-resource-lifetimes.md). A root caller does not own a cleanup registry for its children
or handles. Its lack of a close operation does not change explicit handle-close semantics.

The user accepted this construction model after reviewing the [first core slice](../context/first-core-slice.md).

## Consequences

Basic use can construct a volume and caller without opening a resource scope. The volume already owns its root
identity, so a root caller needs no separately releasable cwd reference. Scoped resources still require explicit
lifetime management through Effect Scope.

This decision does not introduce a volume shutdown API, promise immediate garbage collection, or settle configuration
and metadata defaults. Caller identity and root ownership remain separate. Exact naming and other construction
policies in the prototype are not accepted by this lifetime decision.

## Required evidence

Verify that root-caller construction composes without Scope and that leaving a scope used for a derived caller does
not invalidate the root caller. Verify independent lifetimes for derived callers and directory handles. The current
[declaration prototype](../contracts/README.md) represents the scope-free signature; runtime behavior remains unimplemented.
