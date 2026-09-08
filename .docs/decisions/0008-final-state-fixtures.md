# Final-state fixtures

Status: accepted, 8 September 2026. Resolves the fixture construction model in D13.

## Decision

Fixtures declare a finished filesystem tree with predictable metadata defaults. Declaration order does not change
the resulting filesystem. Validate the complete candidate before returning a usable volume; invalid declarations
must not expose partial state.

Tests that need to exercise operation order, permission checks, or timestamp changes use ordinary filesystem
operations. Fixture loading is not a replay of creation commands.

## Example

A fixture declares one file and two hard-link aliases. All three names reference one file in the resulting volume,
regardless of the order of the declarations. An alias referencing an absent file causes fixture construction to fail
without returning a partially populated volume.

## Alternatives and basis

Replaying declarations as filesystem commands would make their order affect outcomes and couple setup to creation
permissions and clock behavior. The user accepted final-state declarations with predictable metadata defaults instead.
This refines fixture creation in the [design](../design/VirtualFileSystem-design.md).

## Remaining contracts and evidence

Choose the fixture syntax, hard-link reference representation, exact metadata defaults, parent-directory declaration
rules, and error types. Define how explicitly supplied metadata interacts with defaults. Predictable defaults must
not depend implicitly on host credentials or wall-clock time.

Validation must include references, name collisions, topology, and resource limits. Shared validation with snapshots
is an implementation option, not a requirement to expose the snapshot wire format as fixture syntax.

Required tests reorder equivalent declarations and compare observable contents, metadata, and hard-link relationships.
Do not require identical runtime inode numbers. Test defaults for reproducibility and invalid fixtures for failure
without a usable partial volume. See the [snapshot and fixture requirements](../context/snapshots-and-consumers.md).
No fixture implementation or tests were added for this decision.
