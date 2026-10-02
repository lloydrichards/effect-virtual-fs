---
type: Workflow
title: Implement snapshot search
description: Divides the accepted snapshot search design into three reviewable PRs, with shared contracts, agent ownership and focused release checks.
status: stable
tags: [search, glob, implementation, agents, validation]
sources:
  - id: delivery
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/173#issuecomment-5941249055
    title: Accepted design and delivery tracker
  - id: adapter-slice
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/255
    title: Memory glob ownership and named target options
  - id: glob-slice
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/256
    title: Unicode snapshot glob streams and reports
  - id: content-slice
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/257
    title: Snapshot content search streams and reports
  - id: existing-adapter
    resource: ../../packages/memory/src/internal/treeOperations.ts
    title: Private collected walk for recursive listings
  - id: adapter-glob
    resource: ../../packages/memory/src/internal/glob.ts
    title: Adapter glob operation owning compilation, traversal and matching
generated: { by: codex/okf, at: "2026-10-02T07:57:50.958690+00:00" }
---

# Implement snapshot search

Implement the [accepted design](../decisions/snapshot-search.md "implements") in three PRs. All three slices are implemented on the review stack.
The [research](../research/search-and-glob.md "grounded in") owns measurements and source findings, rather than API rules.
Keep #173 open until all three slices are delivered. Each child issue includes its scope, exclusions and acceptance checks.

## Deliver three complete slices

| Slice                | Review claim                                                                           | Dependency                                                           |
| -------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| #255, memory cleanup | Existing adapter behavior survives internal glob ownership and named `at` options.     | None. Merge first as requested by the architecture review.           |
| #256, snapshot glob  | Unicode namespace selection, immutable traversal, limits and completion work together. | Merge after #255. There is no technical dependency on its internals. |
| #257, content search | Classification, byte positions, line matching and every content output mode agree.     | Technical dependency on #256's visitor and query contracts.          |

A single PR would mix a compatibility refactor with a new filename dialect and a new text scanner. Review each claim
separately. Keep matcher and snapshot traversal in #256 so it delivers a useful filename API. Keep literal and regex
matching, all three content modes, and their Stream/collector pairs in #257 because they share classification and
accounting. Docs, types, tests and release notes belong to the slice introducing the behavior.

In #255, `glob.ts` owns the internal adapter glob operation and `memoryFileSystem.ts` delegates to it.
`treeOperations.ts` retains a private collected walk for recursive `readDirectory`. Preserve collect-before-exclude error behavior, the
legacy UTF-16 matcher, dot rules and final-symlink resolution options.

## Fix shared contracts before splitting implementation files

Before parallel work on #256 or #257, have the integrator write the query/result schemas, the finite limit-field union,
default presets, raw result accounting and public type examples. Specify the visitor callback, scanner outcome and
budget-stop representation. Keep these concrete and internal. Export only implemented public functions.

Set finite glob pattern-list, aggregate expansion/token and matching-work caps. Validate safe numerical arithmetic,
source lengths, malformed syntax and limits before traversal. The accepted per-source cap does not bound an aggregate
selector. Earlier draft compiler and query-memory numbers are not accepted presets.

Preflight directory width against the remaining traversal preparation budget before sorting or growing the stack.
If it cannot fit, stop at that directory. Count examined entries even when selectors reject them. Prune excluded or
unrepresentable-name directories without inventing descendant skip counts. Filename search must never inspect file
payloads. Content scanning may borrow immutable bytes internally without exposing stored arrays.

Use fresh evaluation-local state inside suspended Effects/Streams. Catch only the typed budget-stop condition when
building a collector report. Propagate other failures and interruption. Never hold a live-volume admission permit
through scanning. Do not introduce a query-local inode cache until measurement justifies it and its memory is bounded.

## Assign file ownership

For #255, give one agent the memory glob orchestration, `adapterSupport.at` and every caller affected by its options.
That agent owns the compatibility checks and affected adapter OKF descriptions.

For #256, one agent can own the internal Unicode matcher and grammar checks, another the snapshot visitor and namespace
behavior. The integrator owns `Search.ts`, shared schemas, exports, public type contracts and docs. Agree on callbacks
before parallel edits. Keep matcher compilation internal unless a concrete public consumer needs it.

For #257, one agent can own classification, line iteration and byte mapping, another the native/literal matcher and
bounded excerpts. The integrator owns all six public content functions, collector/Stream completion, docs and releases.
Test integrated behavior through public queries. With fewer agents, keep the same dependency order and combine ownership.

The [snapshot search contract](../contracts/snapshot-search.md "implemented by") records #256 and #257's concrete public
query, accounting and completion behavior.

## Verify observable behavior

Each slice runs focused checks first, then its required package/repository validation. Follow the repository's
[evidence workflow](evidence-and-validation.md "constrained by") and installed Effect guidance. Read bundled Turbo docs
before using Turbo commands, as AGENTS.md requires.

For #256, verify supplementary-plane wildcards/classes, hidden names, invalid-name subtrees, aliases, exclusions, kind
filters, root and discovered symlinks, deterministic prefixes, directory-width limits, and zero content copies. Verify
snapshot stability after live edits and overlay merged views. Check empty stopped reports, immediate caps, fresh repeated
and concurrent evaluations, typed Stream limits and collector preservation.

For #257, verify matching-prefix/invalid-tail and matching-prefix/NUL-tail files emit no result in any mode. Check
oversized skips, BOM, CRLF, lone CR, final lines, emoji offsets, zero-width regex, excerpts shorter than a full match,
and included hard-link aliases after excluded canonical names. Files mode must avoid line payloads; count rows must be
exact for completely scanned files. Scanned-byte, line-evaluation and output accounting must agree across modes.

Verify no atime, revision, watch event or durable commit caused by search on success, failure, limits or interruption.
Verify cooperative interruption in owned loops. Do not run pathological regex as proof of cancellation or claim that
an Effect timeout preempts a synchronous native call. Document runtime-dependent grammar and application regex opt-in.

Include public compile-time consumers, root/subpath and NodeNext exports, runtime-neutral compatibility, generated API
registration, runnable examples, Changesets and OKF updates in each feature PR. Compare the final implementation with
the retained recipe baseline on the same fixture; record copied/scanned bytes as well as timings. Do not infer heap
limits or worst-case native regex latency from the baseline.

Promote delivered behavior into a focused contract when its implementation lands. Keep this decision's remaining scope
explicit until all slices are complete; do not mark all of Search implemented after filename search alone.
