---
type: Decision
title: Snapshot search
description: Accepts snapshot-only search with Unicode globs, explicit native regex, typed Streams and bounded report collectors for issue 173; filename glob search is implemented; content search remains pending.
status: stable
tags: [core, search, glob, snapshots, agents, limits]
sources:
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/173
    title: Search and glob over a volume
  - id: research
    resource: ../research/search-and-glob.md
    title: Search research, retained evidence and implementation context
  - id: snapshot
    resource: ../../packages/core/src/internal/image.ts
    title: Immutable snapshot representation and current fixture traversal
  - id: capabilities
    resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Volume snapshots, caller authority and existing traversal contracts
  - id: adapter-glob
    resource: ../../packages/memory/src/internal/glob.ts
    title: Existing memory adapter UTF-16 glob syntax and matching
  - id: native-regexp
    resource: https://tc39.es/ecma262/multipage/text-processing.html#sec-regexp-regular-expression-objects
    title: JavaScript RegExp syntax, Unicode matching and execution
generated: { by: codex/okf, at: "2026-10-02T09:06:00+02:00" }
---

# Snapshot search

Accepted by the user on 2026-10-01 for [issue #173](https://github.com/lloydrichards/effect-virtual-fs/issues/173).
Filename glob search is implemented by [the snapshot search contract](../contracts/snapshot-search.md "implemented by").
The content functions and pattern classes below remain the implementation target for #257, not a publication claim.
The [research](../research/search-and-glob.md "evidenced by") retains the source findings and measurements.

## Ownership and authority

An optional `Search` module in `@effect-vfs/core` owns direct immutable-snapshot traversal and matching. It depends
only on Effect. No mandatory service, volume method, query session, index, persistent cache, host filesystem,
AI dependency or runtime worker is introduced. Reusable compilation remains internal initially. Package ownership
is [constrained by package boundaries](package-boundaries.md "constrained by"). Memory adaptation stays in memory.

Every query receives an explicit snapshot and directory root. One evaluation searches that snapshot, including an
overlay's merged snapshot, without modifying atime, namespace revisions, watches or durable storage. Repeating an
Effect or Stream searches the same snapshot with fresh counters and traversal state. Concurrent evaluations share
no mutable query state. Capturing a newer snapshot is explicit. Snapshot capture already shares immutable state;
the new visitor must filter paths and apply limits before copying payloads.[^snapshot]

A snapshot grants access to its reachable content. Search does not apply caller credentials, and selecting a root
is not a security restriction. Caller-authorized search is outside this decision and must not acquire a snapshot
through an internal shortcut. This distinction is [constrained by resources and authority](../contracts/resources-and-authority.md "constrained by")
and [mutation and observation](../contracts/mutation-and-observation.md "constrained by").

Resolve the explicit root as a directory using ordinary privileged snapshot lookup, including a final directory
symlink. Missing and non-directory roots fail through typed errors. Discovered symlinks are never followed and are
never content-search candidates. The root itself is excluded from results.

## Public workflows and patterns

Provide both plain result Streams and bounded report collectors, with equal documentation and verification:

| Collector           | Stream                  | Result meaning                                                     |
| ------------------- | ----------------------- | ------------------------------------------------------------------ |
| `Search.glob`       | `Search.scanGlob`       | Root-relative filename string                                      |
| `Search.lines`      | `Search.scanLines`      | One matching line, its first whole-match range and bounded excerpt |
| `Search.files`      | `Search.scanFiles`      | One filename per matching file path                                |
| `Search.countLines` | `Search.scanCountLines` | Exact matching-line count for one completely scanned matching file |

The Schema-backed `Pattern` tagged union has `Literal` and `Regex` cases for content-query interpretation.
Representative constructors are `Pattern.cases.Literal.make({ pattern: "TODO" })` and
`Pattern.cases.Regex.make({ pattern: "TODO|FIXME" })`. Keep `pattern: string` consistent across these variants. Literal
strings never become regex implicitly. Decode untrusted queries with Schema and preserve native Effect typed failures.

Literal patterns are nonempty and reject NUL, CR, LF and lone surrogates under the line-query policy. Regex sources
use native JavaScript `RegExp`, always with `u` and additionally `i` when the query's `ignoreCase` is true.
`ignoreCase` defaults to false and uses Unicode simple case folding without normalization. Accept no caller-supplied
flags, `g` or `y`. Empty regex sources and other zero-width matches are permitted; their first range can be `[0, 0)`.
Match each line independently, so regex syntax that denotes a newline cannot cross the removed LF separators.

Native regex follows the existing Effect precedent but has no bounded execution guarantee. Pattern, file and
line-evaluation caps limit inputs and the number of calls; they do not prevent catastrophic backtracking within one
call. Effect timeout and interruption cannot preempt that synchronous execution. Application agent tools must
explicitly opt into exposing regex. The library's explicit regex variant remains available to trusted applications.
Yield cooperatively between bounded traversal, classification and scanning steps; make no hard-deadline claim.[^native-regexp]

## Filenames and glob matching

Result paths are strict UTF-8 strings relative to the selected root, without a leading slash. Collectors retain the
selected root in their report. Preserve paths' exact
text without normalization or replacement decoding. Visit entries in depth-first preorder, with each directory's
children sorted by raw filename bytes, and lines in increasing line-number order. This is not globally sorted
full-path order. Every eligible hard-link name is considered independently, even if another alias is excluded.

Glob defaults include regular files, directories and symlinks; an explicit kind selector narrows them without changing
the string result type. Hidden names are included by default in Search. Content
search scans regular files only. Include and exclude globs are root-relative and case-sensitive. They support
`*`, `?`, character classes, brace alternatives, whole-segment `**`, directory-only trailing slash and escaping.
Literal dots remain ordinary pattern text. `?` consumes one Unicode code point, and classes operate on code points. Excluded directories
prune traversal. Applications own `.gitignore` discovery, nested precedence and tracked-file policy.

An invalid-UTF-8 filename is a counted skip, never replacement text. An invalid directory name makes its descendant
relative paths unrepresentable, so prune that subtree and report one skipped subtree. Do not estimate unseen file
counts. Invalid file and symlink names skip their entries. This is an intentional search boundary over the
[byte-preserving namespace](../contracts/paths-and-namespace.md "constrained by").

Preserve the existing memory `FileSystem.glob` UTF-16 wildcard semantics, strict conversion, sorting and errors.
Its collected traversal currently visits excluded subtrees before exclusion, so adding pruning would change its
observable failures. Internal orchestration cleanup and named options for the adapter's `at` helper must preserve
that behavior. Do not silently replace its matcher with Search's Unicode code-point dialect.[^adapter-glob]

## Text, ranges and excerpts

Before any content mode emits a result, classify the entire selected file for strict UTF-8 and NUL. Invalid UTF-8,
NUL-containing and oversized files are reported skips. A valid matching prefix cannot conceal an invalid or binary
tail. Preserve BOM. LF separates lines; CR immediately preceding LF is removed from returned line text, while a lone
CR remains content. A final LF creates no synthetic final empty line.

Each matching line returns only its first whole-match range, including a zero-width range. Ranges are half-open,
file-absolute UTF-8 byte offsets, and line numbers are 1-based. Do not expose an ambiguous character-column field.
`files` may stop matching a classified file after its first hit. `countLines` counts matching lines, not occurrences,
and emits a count only after completing that file.

Excerpts are bounded on UTF-8 boundaries and carry their original file-byte start and explicit truncation information.
A first match longer than the excerpt cap remains a result: return its full range and a bounded excerpt beginning at
the match. The range may extend beyond the excerpt text. Do not retain a full line in output or silently skip that
match to satisfy the excerpt bound. Native matching may need a complete bounded line string internally, constrained
by the selected-file limit. A zero-width end-of-line match may have an empty excerpt.

## Accepted defaults and accounting

Use a complete, finite default work policy. These accepted values are defaults, not universal performance guarantees:

| Bound                     | Default | Behavior                                                 |
| ------------------------- | ------- | -------------------------------------------------------- |
| Visited namespace entries | 100,000 | Stop before exceeding                                    |
| Scanned content           | 64 MiB  | Stop before starting a file that would exceed            |
| Selected file size        | 1 MiB   | Skip oversized selected files before classification      |
| Line matching evaluations | 100,000 | Stop before another matching call                        |
| Result rows               | 100     | Stop immediately when reached                            |
| Raw result payload        | 64 KiB  | Stop before allocating or emitting a row that cannot fit |
| Excerpt text              | 1 KiB   | Truncate on UTF-8 boundaries with explicit metadata      |
| Pattern source            | 4 KiB   | Reject an oversized literal, regex or glob source        |
| Depth                     | 256     | Stop before exceeding                                    |
| Root-relative path bytes  | 4 KiB   | Stop before exceeding                                    |

Count examined namespace entries even when a selector rejects them. Bound traversal preparation before allocating
sorted child lists or extending the pending stack; a visited-entry cap applied only after materializing an entire
directory is insufficient. Charge the full payload of a selected, size-eligible file when classification begins,
conservatively even when files mode finds an early match. Repeated hard-link scans are charged again. Content
policy skips may therefore consume scanned bytes. Glob-only queries never copy payloads or charge scanned content.

Raw result accounting includes UTF-8 path bytes, excerpt bytes and deterministic range storage, with 16 bytes per
range. It is not a JavaScript heap or escaped JSON size guarantee. Application tools separately cap serialized JSON.
The integrator must settle and test concrete aggregate glob-compilation limits before release, including pattern
lists, expansions and tokens; the per-source cap alone does not bound total compilation. The implemented filename
contract records the user-approved aggregate presets: 128 sources, 64 KiB source-list bytes, 1,024 alternatives,
65,536 tokens and 10 million matching operations. Additional numerical
compiler or query-memory caps from draft research were not accepted defaults.

Collectors return results, skip counters, work counters and `Complete | Stopped` completion. `Stopped` identifies
the actual bound using a finite field union and an available path. Stop immediately at the result cap, including
when the last possible result might have reached it; no lookahead is required. `Stopped` says completion was not
established, not that another match exists. Work-budget exhaustion preserves preceding collector results. Invalid
queries, pattern errors and filesystem failures remain typed failures; interruption remains interruption.

`Complete` means the eligible domain was exhausted under the chosen filename and content policies. Skips can still
be nonzero, so completion does not claim every original file was searched. An empty stopped report proves no absence
of matches. Returned file counts are exact, but their sum after skips or an early stop is only a lower bound for the
original query scope. Plain row Streams may emit earlier results then fail with a typed budget error. They have no
skip-summary channel or full-coverage assertion; use collectors when coverage matters. Manually taking a Stream
prefix proves no completion.

[^snapshot]: `image.ts` wraps immutable state and its fixture iterator copies payloads on pull, while representing later hard-link paths as links. The accepted visitor must avoid those transfer-specific costs and alias semantics.

[^adapter-glob]: `internal/glob.ts` uses `string.length` and `charAt`; its current wildcard unit is UTF-16. Compatibility is an adapter responsibility.

[^native-regexp]: The ECMAScript specification defines native matching behavior, not an interruptible or linear-time execution contract. See the retained research for the inspected Effect source precedent and rejected engine alternatives.
