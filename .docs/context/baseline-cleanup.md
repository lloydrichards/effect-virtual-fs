# Baseline cleanup

Status: completed locally, 8 September 2026. Supersedes the failures in the
[initial evidence pass](preimplementation-evidence.md). This changes build/configuration and memory type annotations;
no core implementation was added.

## Changes

- Added tsup 8.5.1 to the memory package's build dependencies and generated bun.lock with Bun 1.2.21. A subsequent
  frozen install passed without changing the lock hash.
- Corrected the YAML plugin URL from `g-plane-pretty_yaml` to `g-plane/pretty_yaml`, retaining version 0.5.1.
  This matches the [official plugin URL structure](https://dprint.dev/plugins/pretty_yaml/).
- Made the base TypeScript configuration explicitly no-emit; library builds already override this for declarations.
  Added DOM library declarations to memory's source/test and build configs for its existing TextEncoder/TextDecoder
  usage. This supplies types, not proof of execution in browsers.
- Represented the resolver's root-retaining stack as nonempty and used lastNonEmpty. This removes the inferred
  undefined inode that propagated into many callers. Kept noUncheckedIndexedAccess enabled; bounded parser/matcher
  indexing now expresses existing invariants. String indexing uses charAt within checked bounds.
- Preserved the shared test layer's error type with a generic parameter and removed an unnecessary wrapping of a
  yieldable error. The one-result glob assertion still checks cardinality and the expected suffix.
- Excluded deliberate documentation-error examples and retained evidence from production lint. Added explicit
  declaration and executable model checks to CI so the prototype is still validated. Saved evidence is excluded
  from formatting to preserve raw lockfile/log hashes. Applied required import/code-block formatting elsewhere.

The memory changes preserve the existing algorithms and runtime contract. No tests were deleted, strict type checking
was not weakened, and no new core behavior was implemented.

## Executed checks

Environment: Bun 1.2.21 on PATH, Node 24.10.0, macOS arm64. This is local evidence, not an Ubuntu CI run.
The [result manifest](../evidence/baseline-fixed/results.json) records commands, exit codes, and the lockfile hash.

| Check                                           | Result                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                 | Pass; lock unchanged.                                                       |
| `bun run format:check`                          | Pass with the configured plugins.                                           |
| `bun run lint`                                  | Pass with warnings denied.                                                  |
| Contract TypeScript and executable model checks | Pass; now included in CI.                                                   |
| `bun run type-check`                            | Pass through the workspace task graph.                                      |
| `bun run test`                                  | Pass; memory executes 89 tests. Core/scratchpad have no tests.              |
| `bun run build`                                 | Pass, including declarations, NodeNext compatibility, and browser bundling. |

The ten negative consumer cases were also checked in a temporary copy with their suppressions removed: each failed
at its intended line, and restoring suppressions returned the type-check to passing. This remains separate from
filesystem behavior. Browser bundling and an empty core test task are not runtime or conformance evidence.

The full test run reports harmless missing-output warnings because Turbo expects coverage files while the test
commands do not enable coverage. The deep-volume test took about 28 seconds in this run; retain the log as timing
context, not a promised performance threshold. No unrelated task-output or timeout changes were made.

## Next boundary

The baseline is ready for further development. [Decision 0021](../decisions/0021-optional-total-path-limit.md) now
resolves the remaining total-path gate with an optional bound, omitted by default. The user subsequently authorized the first implementation; see the
[directory-slice evidence](first-core-implementation.md) for the current state.
