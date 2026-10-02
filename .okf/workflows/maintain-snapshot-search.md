---
type: Workflow
title: Maintain snapshot search
description: Defines ownership, budget boundaries, and observable validation for snapshot filename and content search.
status: stable
tags: [search, glob, maintenance, validation]
sources:
  - id: public-search
    resource: ../../packages/core/src/Search.ts
    title: Public snapshot search schemas and queries
  - id: selection
    resource: ../../packages/core/src/internal/search.ts
    title: Snapshot filename traversal and budgets
  - id: content
    resource: ../../packages/core/src/internal/searchContent.ts
    title: Snapshot text classification and bounded matching
  - id: glob-tests
    resource: ../../packages/core/test/Search.test.ts
    title: Snapshot filename behavior and budgets
  - id: content-tests
    resource: ../../packages/core/test/SearchContent.test.ts
    title: Snapshot content behavior and accounting
  - id: existing-adapter
    resource: ../../packages/memory/src/internal/treeOperations.ts
    title: Private collected walk for recursive listings
  - id: adapter-glob
    resource: ../../packages/memory/src/internal/glob.ts
    title: Adapter glob operation owning compilation, traversal and matching
generated: { by: codex/okf, at: "2026-10-02T10:00:00+00:00" }
---

# Maintain snapshot search

The [snapshot search contract](../contracts/snapshot-search.md "constrained by") owns public query, accounting, and completion behavior. The [accepted design](../decisions/snapshot-search.md "implements") explains the API choices. [Research](../research/search-and-glob.md "grounded in") retains source findings and current test evidence.

## Preserve package ownership

Memory's internal `glob.ts` owns adapter glob compilation, traversal, and matching. `memoryFileSystem.ts` delegates to it. The private collected walk in `treeOperations.ts` supports recursive `readDirectory`. Preserve the adapter's collect-before-exclude error behavior, legacy UTF-16 matcher, dot rules, and final-symlink resolution options.

Core owns Unicode snapshot selection, immutable traversal, literal and native-regex content matching, and Stream/collector pairs. Keep matcher compilation internal. Define shared query/result schemas and accounting before changing traversal or scanning.

## Preserve bounded evaluation

Validate aggregate selector work, safe numerical arithmetic, malformed syntax, and limits before traversal. Preflight directory width against the remaining preparation budget before sorting or growing the stack. Count examined entries even when selectors reject them. Prune excluded or unrepresentable-name directories without inventing descendant skip counts. Filename search never inspects file payloads. Content scanning can borrow immutable bytes internally but cannot expose stored arrays.

Create evaluation-local state inside suspended Effects and Streams. Collector reports catch only the typed budget-stop condition. Other failures and interruption propagate. Never hold a live-volume admission permit through scanning. Add a query-local inode cache only when measurement justifies its cost and bounds its memory.

## Verify observable behavior

Run focused checks before package and repository validation under the [evidence workflow](evidence-and-validation.md "constrained by"). Read bundled Turbo docs before using Turbo commands, as AGENTS.md requires.

For filename queries, check Unicode wildcards and classes, hidden names, invalid-name subtrees, hard-link aliases, exclusions, kind filters, symlinks, deterministic prefixes, directory-width limits, and zero content copies. Check snapshot stability after live edits and merged overlay views. Check stopped reports, fresh repeated and concurrent evaluations, typed Stream limits, and collector preservation.

For content queries, check matching prefixes followed by invalid UTF-8 or NUL, oversized skips, BOM, CRLF, lone CR, final lines, emoji offsets, zero-width regex, bounded excerpts, and included aliases after excluded canonical names. Files mode must avoid line payloads. Count rows must be exact for completely scanned files. Scanned-byte, line-evaluation, and output accounting must agree across modes.

Verify that success, failure, limits, and interruption cause no atime change, revision, watch event, or durable commit. Check cooperative interruption in owned loops. An Effect timeout cannot preempt a synchronous native regex call. Document runtime-dependent regex grammar and application opt-in.

Check public compile-time consumers, root and subpath exports, NodeNext exports, runtime-neutral compatibility, generated API registration, runnable examples, release notes, and OKF. Compare implementation and recipe baselines on the same fixture, recording copied and scanned bytes alongside timings. Baseline timings do not establish heap limits or worst-case regex latency.
