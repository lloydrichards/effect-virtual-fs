# Virtual package resolution acceptance

Status: accepted direction, 8 September 2026. Extends the consumer acceptance plan in D14.

## Decision

Keep the initial standalone entry-module, relative-dependency, and rebuild test. Add a second acceptance milestone
in which the entry imports a package already stored under the volume's `node_modules` tree.

The second case must resolve and load the selected package from the volume through public core APIs, without staging
its source files on the host filesystem or silently resolving that package from host dependencies.
Resolution belongs to the consumer integration; core supplies filesystem behavior.

## Example

A fixture contains `/src/main.js`, `/node_modules/example/package.json`, and the package's JavaScript entry.
The source imports `example` by package name. The build succeeds using the virtual package and produces its expected
observable result. Specify the manifest and entry-point rules exercised before implementing this example.

## Scope and basis

The user identified dependency-heavy Vite projects as a useful workload and accepted the recommendation to add this
second case after the basic build test. This extends the acceptance plan in the
[design](../design/VirtualFileSystem-design.md), which originally requires only a relative dependency.

It does not require a virtual package manager, package downloading, arbitrary plugin compatibility, or complete Node
package-resolution semantics. Supported manifest fields, module format, and resolver integration remain open.

The accepted recommendation establishes the two-stage acceptance sequence. Whether the second milestone gates the
first core release remains open; the discussion did not explicitly choose between a release gate and a follow-up.

## Evidence

Retain the basic build/rebuild case as independent evidence. For the package case, assert the package's observable
result and prove the selected package was read from the volume. Missing virtual packages must fail without host
fallback for the namespace owned by this integration. Pin tool versions and record the manifest/resolution subset.

No package resolution or integration test was implemented or executed for this decision.
