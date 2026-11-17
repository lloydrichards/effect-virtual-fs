---
type: Research Report
title: Static analysis policy opportunities
description: Separates verified lint behavior, proposed safeguards, and limits that constrain future tooling changes.
status: draft
tags: [tooling, effect, validation, maintainability]
sources:
  - resource: ../../oxlint.config.ts
    title: Root categories, presets, custom rules and file overrides
  - resource: ../../packages/config-typescript/base.json
    title: Shared Effect diagnostic policy
  - resource: ../../tools/checks/effects.mjs
    title: Standalone Effect diagnostic runner
  - resource: ../../tools/oxlint/test/run.mjs
    title: Existing isolated custom-rule fixture runner
  - resource: ../../tools/oxlint/anti-slop/UPSTREAM.md
    title: Vendored rule provenance and intentional local deviations
  - resource: ../../tools/checks/consumers.mjs
    title: Packed consumer checks and ambient declarations
  - resource: ../../.agents/skills/effect-development/SKILL.md
    title: Local Effect and application-owned tracing contracts
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/381
    title: Native and standalone diagnostic comparison
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/382
    title: Tracing fixture and proposed import-aware guard
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/385
    title: Vocabulary and syntax gate reassessment
  - resource: ../../tools/oxlint/anti-slop/rules/no-runtime-typeof.ts
    title: Runtime representation check matcher
  - resource: ../../tools/oxlint/anti-slop/rules/no-shape-in-symbol-names.ts
    title: Symbol substring matcher
  - resource: ../../tools/oxlint/anti-slop/rules/no-conditional-empty-object-spread.ts
    title: Empty-object spread matcher
  - resource: ../../tools/checks/repository.mjs
    title: Runtime checks for the manifest exports contract
  - resource: ../../packages/node/src/internal/conversions.ts
    title: String and number representations of native open flags
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/386
    title: Bounded unused-export investigation
  - resource: https://home-lab.tailc118cc.ts.net/reports/_releases/261117_effect-virtual-fs_static-analysis-audit/623afbe0625d43788544bd65325e717d/index.html
    title: Private static-analysis report with source excerpts and replayable probes
generated: { by: codex/okf, at: "2026-11-17T21:52:20+01:00" }
---

# Static analysis policy opportunities

The [repository validation policy](../decisions/repository-validation.md "governed by") remains authoritative. This research
records proposed improvements and demonstrated limits, not newly enabled checks. Issues own implementation scope and
acceptance criteria; the private report retains detailed probes. Creating an issue does not adopt a new restriction.

## Match enforcement to the guarantee

| Guarantee                                                          | Appropriate evidence                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------- |
| Effect error and service channels remain intact                    | Compiler contracts and type-aware diagnostics               |
| A local coding convention follows imported API identity            | Import-aware syntax rules with accepted and rejected cases  |
| Published declarations resolve for supported consumers             | Packed archives and the existing consumer compiler fixtures |
| Repeated effects observe fresh state and resources close correctly | Behavioral tests through public operations                  |
| Capabilities and abstractions have the right owner                 | Architecture review against existing decisions              |

Keep [explicit capabilities](../decisions/core/explicit-api-and-effect-services.md "preserves") and
[independent resource lifetimes](../decisions/core/independent-resource-lifetimes.md "preserves"). A syntax rule cannot prove
authority, freshness, cancellation or exactly-once release. A `SAFETY:` comment identifies a review obligation; it is not a
proof of a cast.

## Inspect the effective policy

With Oxlint 1.92.0 and Effect tooling 0.70.0, the root categories enable `unsafeEffectTypeAssertion`,
`anyUnknownInErrorContext` and `effectTryWithoutCatch` even though the selected presets and shared severity map do not name
them. The standalone runner uses different defaults. The retained paired examples establish disagreement between the two
entrypoints, not missing protection in the native lint gate. Proposed work makes the selected severities explicit in their
existing shared owner and tests both entrypoints.

Preset inspection alone is insufficient. Check expanded configuration and execute representative files, including scoped
exceptions. An ignored file is not a passing lint result. With `denyWarnings`, changing a rule to warning still fails the
normal lint command; a nonblocking trial needs a separate invocation.

## Preserve legitimate boundary code

An unknown input decoded through Schema differs from an unknown Effect error or service channel. Likewise, passing a known
union to a narrowing predicate does not erase the caller's type. The annotation-only `Target.of` probe demonstrates why
syntactic type spelling is an unreliable proxy for lost information. Parameter names, inline versus named types, and imported
aliases must not determine whether equivalent code is accepted.

Effect tag advice must identify both the imported API and the handler's subject. A scope-state check inside an error handler
is not necessarily a test of that error. Assign overlapping native and custom diagnostics one owner before removing a rule.

Performance advice also needs a semantic boundary. A fixed-size reducer window is not an unbounded accumulator copy.
Iterator fusion can change sparse-array results, callback order and indexes. `Reflect.get` with an explicit receiver is not
equivalent to ordinary property access. These rules do not currently autofix; the findings concern detection and remediation
advice, not demonstrated production corruption.

Application-owned tracing is already local policy. Untraced function suggestions and explicit public signatures do not
enforce it: annotated named functions and direct span calls pass the current checks. The proposed guard applies to handwritten
library implementations, while allowing consuming applications, tests and generated code at their existing boundaries.

## Vocabulary and syntax gates

The three rules are errors in the current root configuration. Isolated probes on checkout `812957e3` used
Bun 1.4.4 and Oxlint 1.92.0. The probes exercise matcher behavior. They do not establish that any rejected snippet
causes a runtime failure.

| Rule                                 | Reported by the probe                                                                                                      | Accepted by the probe                                                    | Recommendation                                                                                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no-runtime-typeof`                  | Representation narrowing in a known union, diagnostic formatting, and a string type guard                                  | A missing-global existence probe and a TypeScript type query             | Retire the blanket rule. Keep validation at external boundaries as the policy. Permit ordinary runtime checks that narrow or describe known representations.            |
| `no-shape-in-symbol-names`           | The imported `Shape` token aliased to `Geometry`, an owned geometric `Shape`, the generic name `InputShape`, and `reshape` | The local `Geometry` spelling                                            | Retire the substring rule. Suggest domain names during review when the proposed name obscures ownership. Preserve geometric vocabulary and imported or published names. |
| `no-conditional-empty-object-spread` | Ternary spread with an empty alternate                                                                                     | Logical-and spread with the same omitted own key for a boolean condition | Retire the syntax restriction. Review omission and evaluation order where they affect the contract.                                                                     |

Enabling `allowInTypeGuards` suppressed the predicate diagnostic alone. Known-union narrowing and diagnostic
formatting still reported. In production, `flagsOf` already narrows Node's string/number open flags and then validates
the numeric mask. In manifest tooling, `publicEntries` checks that export maps and targets are objects and validates
their declaration and import paths. Its existing suppressions allow those runtime checks. A replacement boundary
rule would need evidence that it detects missing validation while accepting these checks. An expression or identifier
alone does not identify such a boundary.

The trial emitted eight warnings and exited zero. Adding `--deny-warnings` preserved the eight diagnostics and
changed the exit code to one. If reviewers still want these style suggestions, run them explicitly with a separate
configuration and collect the findings outside CI. This report proposes the dispositions. The root rules and file
overrides remain in force until a reviewed policy change.

### Reproduce the vocabulary probes

From the repository root after the frozen install, create an isolated fixture and lint configuration.

```sh
mkdir -p .cache/lint-vocabulary
cat > .cache/lint-vocabulary/probes.ts <<'TS'
import type { Shape as Geometry } from "geometry"
export interface Shape { area(): number }
export type InputShape = { value: number }
export const area = (figure: Geometry) => figure.area()
export const reshape = (value: number) => value
export const render = (value: string | number) => typeof value === "string" ? value : String(value)
export const report = (value: unknown) => ({ kind: typeof value })
export const isString = (value: unknown): value is string => typeof value === "string"
export const hasOptionalGlobal = () => typeof optionalGlobal !== "undefined"
export type Render = typeof render
export const fromTernary = (present: boolean) => ({ ...(present ? { value: 1 } : {}) })
export const fromAnd = (present: boolean) => ({ ...(present && { value: 1 }) })
TS
bun -e '
  const rules = [
    "no-runtime-typeof",
    "no-shape-in-symbol-names",
    "no-conditional-empty-object-spread"
  ]
  await Bun.write(".cache/lint-vocabulary/oxlint.json", JSON.stringify({
    jsPlugins: [{ name: "anti-slop", specifier: process.cwd() + "/tools/oxlint/anti-slop/index.ts" }],
    categories: { correctness: "off" },
    rules: Object.fromEntries(rules.map((rule) => ["anti-slop/" + rule, "warn"]))
  }))
'
```

Run the probe once in isolation and again with `--deny-warnings` appended.

```sh
bunx --no-install oxlint --config .cache/lint-vocabulary/oxlint.json \
  --disable-nested-config --no-ignore --format json .cache/lint-vocabulary/probes.ts
```

Expect diagnostics on lines 1, 2, 3 and 5 for the name rule, lines 6–8 for the runtime check rule, and line 11
for the spread rule. To check the type-guard option, set the runtime rule in the temporary config to
`["warn", {"allowInTypeGuards": true}]` and repeat. The line 8 diagnostic disappears.

## Proposed rollout criteria

- Exercise a real rejected case and a nearby legitimate case before making a rule blocking. Include aliases, shadowed names
  and intended boundary exceptions when they affect the rule's meaning.
- Extend the existing fixture suite with actual configuration scopes and selected native/custom interactions. Check exact
  output and repeated-fix stability for fixers. Keep assertions focused on behavior rather than literal configuration text.
- Inspect and fix violations in the selected scope before enforcement. Preserve targeted exceptions rather than introducing
  a permanent baseline of historical failures.
- Recheck compiler and behavioral contracts after lint-driven rewrites. Style consistency does not establish correctness.

The [validation workflow](../workflows/evidence-and-validation.md "implemented through") continues to own command order,
build prerequisites and runtime qualification.

## Tool choices and rejected shortcuts

The installed stack already provides typed TypeScript and Effect lint. No demonstrated gap justifies adding a second typed
linter, a second dependency graph checker, or a package-analysis suite alongside the existing checks. API-diff tooling remains
deferred until a missed compatibility change shows value beyond generated API documentation and consumer contracts.

A no-DOM consumer gate is not compatible with the inspected Effect 4.1.4 declarations. Isolated consumers importing only
Effect fail without DOM declarations and pass with them under both selected compilers. This does not prove a VFS dependency
on browser runtime behavior. Revisit upstream declaration support before adding that gate; do not hide the failure through
`skipLibCheck` or synthetic globals.

Knip is a conditional NFS pilot, not an adopted dependency. Public export maps must remain entry roots even when no local
caller imports them. Compare production and test-inclusive reachability, account for generated and computed entries, and
measure useful findings against configuration cost. One unused internal helper does not justify a repository-wide gate.

## Implementation follow-ups

| Finding                                                  | Priority | Issue                                                                 |
| -------------------------------------------------------- | -------- | --------------------------------------------------------------------- |
| Allow useful narrowing and unknown decoder inputs        | P2       | [#378](https://github.com/lloydrichards/effect-virtual-fs/issues/378) |
| Resolve Effect bindings and handler subjects             | P2       | [#379](https://github.com/lloydrichards/effect-virtual-fs/issues/379) |
| Test default exports, rule integration and spacing fixes | P2       | [#380](https://github.com/lloydrichards/effect-virtual-fs/issues/380) |
| Align standalone and native Effect diagnostics           | P2       | [#381](https://github.com/lloydrichards/effect-virtual-fs/issues/381) |
| Enforce application-owned tracing in library source      | P2       | [#382](https://github.com/lloydrichards/effect-virtual-fs/issues/382) |
| Report stale suppressions and exercise policy scopes     | P2       | [#383](https://github.com/lloydrichards/effect-virtual-fs/issues/383) |
| Preserve semantics in performance and reflection rules   | P3       | [#384](https://github.com/lloydrichards/effect-virtual-fs/issues/384) |
| Reassess vocabulary and syntax gates                     | P3       | [#385](https://github.com/lloydrichards/effect-virtual-fs/issues/385) |
| Trial unused internal export analysis in NFS             | P3       | [#386](https://github.com/lloydrichards/effect-virtual-fs/issues/386) |

Share one root-configuration fixture group between the custom-rule and suppression work. Keep the Effect severity comparison
with its policy tests. The unused-export pilot is distinct from the completed XDR adapter cleanup in
[#361](https://github.com/lloydrichards/effect-virtual-fs/issues/361).
