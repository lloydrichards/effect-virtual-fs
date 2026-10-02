---
type: Contract
title: Snapshot filename search
description: Defines implemented Unicode glob selection, bounded immutable namespace traversal, and Stream versus collector completion for core Search.
status: stable
tags: [core, search, glob, snapshots, limits]
sources:
  - id: public
    resource: ../../packages/core/src/Search.ts
    title: Search public schemas, defaults and paired operations
  - id: matcher
    resource: ../../packages/core/src/internal/glob.ts
    title: Bounded Unicode compiler and matcher
  - id: visitor
    resource: ../../packages/core/src/internal/search.ts
    title: Immutable namespace visitor and preparation accounting
  - id: tests
    resource: ../../packages/core/test/Search.test.ts
    title: Public behavior, limits, concurrency and side-effect evidence
generated: { by: codex/okf, at: "2026-10-02T09:22:00+02:00" }
---

# Snapshot filename search

`@effect-vfs/core/Search` implements `scanGlob(snapshot, query)` and `glob(snapshot, query)`.
It [implements the filename portion](../decisions/snapshot-search.md "implements") of the accepted search design.
Content search remains deferred to #257. The [memory adapter contract](memory-adapter-compatibility.md "contrasts with")
retains its separate UTF-16 matching, dot rules and collected failures.

## Query and namespace

A query requires a directory `root` and a nonempty `include` list, with optional `exclude`, `kinds` and `limits`.
Search uses privileged immutable snapshot lookup, including a final root symlink. Missing roots and non-directory roots
fail with filesystem errors. Discovered symlinks are reported without following them. The root itself is excluded.
Selecting a root is not caller authorization. The snapshot grants access to its reachable state.

Results are strict UTF-8 strings relative to the selected root, without a leading slash or normalization. Traversal
is depth-first preorder, with each directory's children sorted by raw name bytes. Every hard-link path is independent.
Defaults select files, directories and symlinks, including hidden names. Include and kind filters do not prune traversal;
excluded directories do. An invalid name increments `invalidNames`; an invalid directory also increments
`invalidNameSubtrees` once and prunes descendants without estimating their counts.

Patterns are root-relative and case-sensitive. `*`, `?` and classes operate on Unicode code points. Classes support
`!` negation and ascending numeric code-point ranges. Comma brace alternatives nest; whole-segment `**` spans zero or
more segments. A trailing slash selects directories. Backslash quotes the following scalar. Numeric brace and extglob
syntax has no special interpretation. Empty/absolute/dot segments, NUL, lone surrogates, malformed classes/braces,
dangling escapes, descending ranges and embedded globstars fail as `SearchQueryFailure`.

## Bounded work and completion

Public schemas define finite limits, work counters, skip counters and tagged completion. Compiler caps count sources
across include and exclude, source UTF-8 bytes, expanded alternatives and compiled tokens, including class atoms. Outer brace choices expand before nested choices,
so each syntactic alternative is counted without duplicating unrelated siblings.
Defaults are 128 sources, 64 KiB aggregate sources, 1,024 alternatives and 65,536 tokens, alongside the accepted 4 KiB
per-source cap. Matching charges DP transitions and class-atom checks before executing them, with a default 10 million
operations. Compiler failures are query failures, rather than stopped reports.

Namespace preparation checks directory width against the entry allowance after subtracting examined entries and already
prepared pending siblings, before enumerating or sorting children. A directory can therefore stop before any child is
visited. Examined entries include rejected selectors and invalid names. Depth and path limits fail before proceeding
past their bounds; a stop can identify the parent path when the child has not been decoded. The empty stop path is the
selected root. Selected directory children are prepared on the next pull, so immediate row caps need no lookahead.

The default policy also bounds 100,000 entries, depth 256, 4 KiB relative paths, 100 rows and 64 KiB raw result bytes.
Glob charges UTF-8 path bytes only and never accesses file payloads; content counters remain zero. Content limits and
skip fields are shared contracts for the next slice, without placeholder public content functions.

A Stream emits ordinary strings and can fail with `SearchBudgetExceeded` after earlier rows. A collector catches only
that typed failure, preserving rows and counters with `Stopped { limit, path? }`. Other errors and interruption remain
failures. Reaching the result cap stops immediately, even for the final possible match; zero rows yields an empty stopped
report after query/root validation. Exhausting the eligible namespace yields `Complete`, which can still contain skips.
Neither a stopped report nor a manually taken Stream prefix proves absence of further matches.

Each evaluation creates fresh compilation, traversal and counters. Repetition and concurrency use the same immutable
snapshot with independent work state. A captured snapshot retains its view after live writes; overlay snapshots include
the merged view. Search performs no caller reads, atime updates, revision changes, watch events or durable commits.
Owned loops yield cooperatively. Admitted directory sorting remains a bounded synchronous operation; no deadline is promised.
