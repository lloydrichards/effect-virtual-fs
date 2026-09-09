# Reusable capability effects

Status: accepted, 9 September 2026. The user approved the audited cleanup and migration of all seven
zero-argument core operations. There are no external consumers to preserve.

## Decision

DirectoryHandle exposes `stat` and `close` as Effect properties. FileHandle exposes `stat`, `sync`, and `close`
as Effect properties. Volume exposes `watch` and `snapshot` as Effect properties. Callers yield these values
directly, for example `yield* volume.snapshot`.

Each execution observes current state. Reusing an Effect does not cache metadata, a snapshot, a subscription,
or a close result. Explicit close still reports `InvalidHandle` when repeated; scope cleanup remains idempotent.
Each watch execution acquires its own subscription in the execution scope. Named tracing spans are retained.
This supersedes callable syntax in earlier lifetime decisions, including decision 0013, without changing those
lifetime rules. Historical proposed declarations remain dated evidence.

Internal generator functions use `Effect.fnUntraced`. Named public operations continue to use `Effect.fn`.
Callbacks that defer mutable reads, Promise/Stream bridges, and generators inside coordinated operations remain.
Directory acquisition prepares owned input before registering its finalizer, outside the volume permit. Its only
callers immediately yield acquisition inside their own generator, preserving that ordering after conversion.

## Tooling

`bun run lint:effects` runs the pinned TSGo diagnostics with the untraced function preference. Function opportunities,
lazy Effect factories, and array-map sequencing suggestions are errors. CI runs this alongside Oxlint; the shared
TypeScript language-service diagnostic setting does not control this check.

The unused blanket test exemption for async functions is removed. Host-module imports are allowed only in the
virtual-build integration test, and raw-JSON fixture inspection only in the snapshot test. The benchmark's two
inline host-import exemptions remain justified by its host input preparation. The seven lazy-effect suppressions
are removed. Historical evidence and deliberate negative contract examples retain their separate checks.

## Validation

`packages/core/test/EffectReuse.test.ts` covers fresh file/directory metadata, liveness after close, snapshot
isolation across repeated executions, and independent subscriptions across scope closure. The existing closed-scope
and acquisition-race tests also pass after the acquisition helper conversion.

The local suite passed 190 tests: 73 core, 114 memory, and 3 consumer tests. Dedicated TSGo diagnostics reported
zero errors, warnings, or suggestions across all four projects. Browser-target bundling is checked under Node,
not a browser runtime.
