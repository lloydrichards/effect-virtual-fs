---
name: effect-development
description: Implement or review Effect TypeScript code in effect-virtual-fs using the installed Effect version, local contracts, and repository validation. Use for changes involving Effect APIs, services, schemas, layers, resources, streams, errors, or Effect tests.
---

# Effect development in effect-virtual-fs

Use targeted, version-matched guidance. Do not copy patterns from Effect's
current `main` branch without checking them against the installed version.

## Establish the local contract

1. Identify the behavior, Effect APIs, and package boundaries involved.
2. Inspect nearby implementation and tests. For durable filesystem semantics or
   architecture, read the relevant `.okf/` concepts and their cited sources.
3. Read `node_modules/effect/AGENTS.md` for the installed Effect version. Search
   it by API or concept and follow only the relevant links under
   `node_modules/effect/ai-docs/src/`.
4. If the packaged guide does not cover the question, inspect the installed
   source and declarations under `node_modules/effect/src/` and
   `node_modules/effect/dist/`.
5. Use upstream documentation only as a fallback, and verify that its advice
   applies to the version in `node_modules/effect/package.json`.

Do not load the whole documentation tree as ambient context. Before editing,
account for every material Effect API or establish that the installed guidance
does not cover it.

## Preserve this repository's design

- `@effect-vfs/core` exposes explicit capability objects whose operations return
  Effect values. Effect services are optional thin bindings over the same
  behavior; do not replace explicit volume, caller, or handle ownership with a
  service abstraction.
- Keep native Effect contracts at public interfaces. Convert to Promises,
  callbacks, platform errors, strings, or other runtime representations only at
  the boundary that requires them.
- Keep runtime-neutral core semantics separate from adapters. The memory
  package owns `FileSystem` integration, `PlatformError` translation, string
  conversion, and adapter-specific cursor behavior.
- Preserve typed failures, resource lifetimes, scope ownership, interruption,
  and concurrency semantics. Do not hide these behind defects or untyped
  exceptions.
- Parse untrusted boundary data with `Schema`. Prefer Effect's existing
  predicates and utilities to locally reinvented runtime type guards.
- Use `Effect.gen` for inline workflows. For reusable operations, follow the
  installed guidance and local convention: traced `Effect.fn("...")` at useful
  operation boundaries and `Effect.fnUntraced` for internal library helpers or
  hot paths. The repository's Effect-aware lint enforces part of this
  convention.
- Use `return yield*` for terminal Effect failures so control flow and types
  agree. Use Effect error and resource APIs instead of JavaScript `try` / `catch`
  around yielded Effects.

## Route common work

- Services and Layers: search
  `node_modules/effect/ai-docs/src/01_effect/03_services/`.
- Resource and `Scope` ownership: search
  `node_modules/effect/ai-docs/src/01_effect/05_resources/`.
- Streams and watch delivery: search
  `node_modules/effect/ai-docs/src/03_stream/` and inspect the existing watcher
  contract tests.
- Schema work: start with
  `node_modules/effect/ai-docs/src/01_effect/02_schema/` and installed Schema
  source or declarations. The package does not include the full `SCHEMA.md`.
- Effect tests: search `node_modules/effect/ai-docs/src/09_testing/` and inspect
  the nearest package tests. Use `@effect/vitest` assertions and `it.effect` for
  Effect-returning tests. Remember that `it.effect` and `it.live` already manage
  a scope. Use `TestClock` for clock-dependent behavior and avoid
  `Effect.runSync` inside Effect tests.
- Adapter compatibility: inspect `packages/memory/test/FileSystemTest.ts` and
  focused binding tests before changing observable `FileSystem` behavior.
- Public type composition: inspect and extend `packages/core/contracts/` when a
  change affects compile-time API contracts.

## Verify observable behavior

Use the narrowest check that proves the change, then widen in proportion to its
risk. Prefer a focused regression that fails for the intended defect before a
behavioral fix. For filesystem semantics, test through the public boundary and
cover state, error, resource, and scheduling behavior that could differ while
types still pass.

This repository uses Bun and Turbo; do not substitute Effect's upstream `pnpm`
commands.

- Focused runtime test: run the owning workspace's `test` script with the
  relevant test file or test name.
- Public type/API change: run the owning package's `type-check`, including its
  contract project where configured.
- Effect style diagnostics: `bun run lint:effects`. Check `scripts/lint-effects.sh`
  before assuming it covers the changed workspace.
- Repository checks, when warranted: `bun run format:check`, `bun run build`,
  `bun run lint`, `bun run lint:effects`, `bun run type-check`, and
  `bun run test`. Build before lint and type-check so workspace declarations are
  current.
- Documentation or generated API pages: run the relevant `apps/docs` scripts,
  including `docs:check` when public documentation is affected.

Report the exact commands run and keep conclusions no broader than their
evidence.

If behavior, architecture, public contracts, or accepted decisions changed,
use the repository `okf` skill to decide and perform any durable knowledge
update. If a published package's consumer-visible behavior or API changed, use
the Changesets workflow to decide whether a release note is required.
