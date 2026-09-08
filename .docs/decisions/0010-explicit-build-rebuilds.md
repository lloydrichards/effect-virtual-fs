# Explicit build rebuilds

Status: accepted, 8 September 2026. Resolves rebuild triggering in D14.

## Decision

The initial build acceptance uses explicit build calls: build from the live volume, modify a dependency, invoke build
again, and verify changed output. Automatic watch-triggered rebuilds remain a follow-up integration.

This choice does not remove or weaken existing memory-adapter watch behavior. It does not require the initial build
integration to subscribe to events, schedule rebuilds, provide HMR, or demonstrate retained-cache invalidation.

## Example

The entry module imports a value from a relative dependency. The first build produces the initial value. After a
write changes that dependency in the same volume, a second explicit build produces the updated value. Both reads
use public core APIs; no virtual source files are staged on the host filesystem.

## Alternatives and basis

Automatic rebuilds would add event subscriptions, scheduling, and cache invalidation to the integration contract.
The user selected explicit rebuilds for the initial acceptance. This resolves the rebuild ambiguity in the
[design](../design/VirtualFileSystem-design.md) without reducing the separate adapter compatibility requirements.

## Remaining contracts and evidence

Pin tool versions and specify programmatic build configuration and output assertions when implementing the test.
Keep the basic relative-dependency case separate from the virtual package milestone in
[decision 0007](0007-virtual-package-acceptance.md). Its release gating remains open.

Required evidence includes two completed builds against the same live volume and assertions that their observable
results reflect the dependency contents at each build. The second build must not reuse stale virtual source data.
No build integration or tests were implemented or run for this decision.
