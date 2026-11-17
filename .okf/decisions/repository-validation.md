---
type: Decision
title: Repository validation policy
description: Defines Effect-aligned validation coverage, public contracts, tooling checks, and compiler qualification.
status: stable
tags: [tooling, effect, validation, public-api]
sources:
  - resource: ../../tools/checks/repository.mjs
    title: Workspace classification and export discovery
  - resource: ../../packages/config-typescript/base.json
    title: Shared Effect diagnostic policy and scoped exceptions
  - resource: ../../oxlint.config.ts
    title: Native Oxlint configuration derived from the shared diagnostic policy
  - resource: ../../tools/checks/effects.mjs
    title: Workspace-derived Effect diagnostics
  - resource: ../../tools/checks/boundaries.mjs
    title: Source import graph and package direction checks
  - resource: ../../tools/checks/consumers.mjs
    title: Packed consumer compiler checks
  - resource: ../../tools/oxlint/test/run.mjs
    title: Isolated custom lint fixtures
  - resource: ../../tools/oxlint/test/performance-semantics.test.mjs
    title: Array and reflection semantics that constrain lint advice
  - resource: ../../apps/docs/scripts/check-public-docs.ts
    title: Public declaration documentation checks
  - resource: ../../apps/docs/scripts/check-examples.ts
    title: Public example compiler and output checks
  - resource: ../../tools/oxlint/anti-slop/UPSTREAM.md
    title: Custom rule provenance and local contract
  - resource: ../../packages/effect-preview/upstream/manifest.json
    title: Imported engine provenance
generated: { by: codex/okf, at: "2026-11-17T20:15:02+00:00" }
---

# Repository validation policy

Follow Effect conventions with documented exceptions for VFS contracts and native integration requirements. Preserve
published names, export paths, signatures, brands, typed failures, service requirements and runtime behavior while tightening
validation. A breaking change needs a separate migration and release decision. Fix existing violations within each selected
scope before requiring a new check; do not accept new violations through a permanent historical baseline.

## Discover coverage from manifests

Workspace manifests discover packages and public exports. The policy registry classifies each workspace as a library,
application, generated snapshot or configuration package, records runtime requirements, and specifies allowed workspace
dependency directions. Missing classifications, stale entries and unexplained exclusions fail validation.

Each workspace declares how its tests run. The shared Bun suite derives its Vitest projects from the registry, and each
workspace test script selects its registered project. The registry also records workspace scripts for tooling suites,
dedicated runtime jobs and operator gates, or a reason for having no suite. Inventory validation checks that named
scripts exist in workspace manifests and that shared test scripts select their registered project. Entry points for
runtime jobs and operator gates follow the
[validation workflow](../workflows/evidence-and-validation.md).

Every published TypeScript module has a corresponding source, API page and packed-consumer import. Root barrels contain re-exports only and inherit
documentation from inventoried public defining modules. Local split exports are checked at their defining declarations. Configuration exports and package metadata have explicit dispositions.
Effect diagnostics run over every applicable workspace; JSON presets and generated preview code have reasoned exclusions.

## Check public contracts and the tooling itself

Public Effect operations state inputs, success values, typed failures and required services through an explicit binding type
or a supported fully annotated generator. Internal implementation helpers and tests do not need public API annotations.
An explicit internal alias annotation can express intentional identity ownership; consumer declaration checks determine
whether published types resolve. Do not reject all internal type names by string matching.

Require descriptions, stable-semver `@since` values and nonempty categories on public declarations. Members inherit metadata
from their owning declarations; re-exports require an inventoried public defining module. Validate supplied stability tags, but do
not invent stability promises for existing APIs. Local symbol links resolve to exports in the same module. HTTP links are checked for URL syntax, not remote existence.
Cross-module links and stricter member documentation can be added with corresponding checker coverage. Examples are compiled; examples with the supported output assertion convention are
executed and their output is compared under the selected runtime.

Custom lint rules have isolated accepted and rejected fixtures and a checked TypeScript implementation. Plain repository
tooling may use host filesystem APIs and process output. Native Node methods, Schema inputs, opaque identity and protocol
boundaries justify narrow exceptions when a general restriction would conflict with their contracts. A safety comment
explains an assertion; it does not prove it.

The array accumulator copy rule reports direct returns of a potentially growing concatenation when the reducer uses a fresh
array seed and its receiver resolves to an array literal. Native lint covers accumulating spreads. Review array fusion where
measurements warrant it. A rewrite must preserve sparse slots, callback order, callback indexes and the input array passed to
each callback. Use `Reflect.get` when the operation needs an explicit receiver, such as a proxy forwarding to an accessor.
These transformations require code review and have no automatic fixes.

## Share Effect diagnostic configuration

The shared TypeScript preset owns Effect diagnostic severities and per-file exceptions. The editor keeps language-service
`diagnostics: false` because Oxlint owns interactive reporting. The dedicated diagnostic runner reads the same plugin settings
and enables diagnostics only for its pass. Oxlint's typed configuration derives native rule names and scoped severity overrides
from that policy; do not maintain another independent severity list in the runner.

Use untraced Effect function suggestions for library work. Require `effectFnOpportunity`, `lazyEffect` and `allOfMapToForEach`.
Retain the existing opt-outs for native array/record/string APIs, global JSON, structural Schema classes, error payload names,
Result conversion style and strict layer provision. These are policy or compatibility choices, not authorization for automatic
source rewrites. Keep the Result conversions, nominal branding and published error-field changes in separate implementation
or compatibility work.

Unstable API usage remains disabled, matching the upstream tooling reference and the repository's pinned Effect dependencies.
Experimental APIs remain checked outside the existing core preview boundary. Scope its exception to the internal runtime,
synchronous adapter, durable storage, volume-watch bridge and preview-runtime contract test. The synchronous adapter alone
also permits nested Effect runners because its checked synchronous region implements the native filesystem boundary. Do not
replace these runners merely to satisfy a generic diagnostic or widen the exception to other modules.

Language-service override paths are relative to each workspace's tsconfig. All inventoried workspaces are two directories below
the repository root, so explicit `../../packages/core/...` paths identify the owning files. The native configuration translates
those paths to repository-relative paths. Use file patterns ending in actual filenames or file extensions; directory-only glob
patterns do not reliably select files in the TypeScript matcher. A policy regression must retain correctness errors inside the
excepted file and experimental-API warnings outside it.

Pin `@effect/tsgo` with compatible TypeScript, Oxlint and oxlint-tsgolint versions. Installation patches both the compiler and
Oxlint through `prepare`; do not introduce a separate compiler version or experimental tsrs backend as part of a tooling update.

## Preserve dependency and generated ownership

With `verbatimModuleSyntax`, statement-level `import type` and `export type` declarations have no runtime edge, while
inline type-only specifiers retain an empty module load. Preserve those loads in the cycle graph. Enforce the [package dependency model](../architecture/package-dependency-model.md "implements")
in manifests and source imports. Reject cross-package relative imports, unsupported private package entrypoints, and host
runtime dependencies in the engine. Core's private preview integration is intentional. Export maps remain explicit allowlists.

Generated preview files remain owned by the pinned snapshot and generator. Regeneration, checksum, type, consumer and runtime
checks qualify them separately from handwritten style rules. The tooling reference is open_effect revision
`da0c792bb2b636fd5ee2b7eeeeb780ba6c321e04`; it is distinct from the imported engine revision in the preview manifest. Reuse upstream tooling only with compatible dependencies and recorded provenance.
The local documentation checker uses the existing ts-morph parser rather than importing private upstream tooling whose
declared TypeScript peer range excludes the repository compiler.

## Qualify consumer compilers without widening runtime claims

Import every published entrypoint from packed output with strict declaration checking and `skipLibCheck: false`, using
TypeScript 5.9.3 and 7.0.2. Verify inference, errors, environments and deliberate invalid API calls alongside imports.
These are selected verified compiler versions, not proof of a continuous support range. Core, memory and NFS declarations
are checked without ambient Node types. Node and persistence use explicit Node types; persistence's exported AWS client
types require them. Preserve existing browser-bundle checks and runtime-specific qualification; a compiler result does not
prove a runtime capability.

The [validation workflow](../workflows/evidence-and-validation.md "implemented by") owns command order and runtime gates.
Source restructuring follows a demonstrated responsibility or dependency problem, not maximum-file-size rules or a universal
requirement to move all implementations into internal modules.
