# Implementation refactor

9 September 2026. This review started from clean `main` at `c720099`, after the implementation and compatibility
repairs landed. New work belongs to `codex/implementation-refactor`. The original design at `f06c2f0` describes the
outcome; accepted decisions and the implemented profile govern behavior. The completion ledger is historical
evidence, not proof that every edge case works.

## Lookup and copy policy

Internal lookup previously accepted three positional booleans. Calls such as `true, false, true` required reading
the resolver to understand which part of a path they selected. Named options now identify final-symlink following,
missing final entries, and parent lookup. The single traversal algorithm remains because dot components, link
expansion, permission checks, and exact suffix accounting must advance together. Separate resolvers or overloads
would add more places to maintain those rules. The optional lookup result remains internal.

The adapter repeated the atomic content-and-source-mode settings in three regular-file copy branches.
`writeCopiedFile` owns those shared settings. Each call still states whether creation is exclusive, whether a final
symlink is replaced, and which directory supplies the base. Identity checks, recursive traversal, and error mapping
remain with the operation that owns them.

The accepted `writeFile` controls `replaceFinalSymlink` and `finalMode` remain unchanged. A separate copy operation
could replace them publicly, but would change accepted callers and require a compatibility decision. Internally,
the single whole-file commit still protects failed replacement, destination identity, quota reuse, and one update
per reachable alias.

## Test and comment audit

| Test or cluster                      | Observable behaviour                                       | Current owner | Decision | Evidence and risk                                                                      |
| ------------------------------------ | ---------------------------------------------------------- | ------------- | -------- | -------------------------------------------------------------------------------------- |
| Core path, link and namespace suites | Traversal order, authority, path bases and atomic mutation | contract      | keep     | Named options preserve the existing resolver; public observations protect its behavior |
| `Replacement.test.ts`                | Atomic replacement, quota reuse and mode authority         | contract      | keep     | These cases protect accepted whole-file controls                                       |
| `AdapterCompatibility.test.ts`       | Root removal and copy state/event preservation             | regression    | keep     | Prior failures justify distinct adapter regressions                                    |
| `CoreBinding.test.ts`                | Shared volumes, watcher conversion and adapter cursors     | adapter       | keep     | Adapter offsets deliberately differ from core offsets                                  |
| `Snapshot.test.ts`                   | Isolation, strict validation and independent restoration   | contract      | keep     | Encoding refactors must preserve the wire format and ownership                         |

No existing tests were deleted, combined or renamed. Their public assertions are useful despite some large cases.
The finalizer-registration and interruption comments remain: they explain ordering that cannot safely be replaced
with routine acquisition boilerplate. The cohesive volume implementation remains together so state, accounting,
publication, and release share one coordinator; file size alone does not justify splitting it.

## Baseline

The forced baseline built successfully and executed all 177 tests. Formatting, lint, documentation compilation,
executable models, and forced workspace types also passed. Frozen installation succeeded using Bun 1.4.0 and Node
24.10.0 without dependency changes. The repository pins Bun 1.2.21; that runtime and Linux CI were not run here.
