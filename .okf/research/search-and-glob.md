---
type: Research
title: Snapshot search and glob evidence
description: Records snapshot authority, fixture recipe limitations, Unicode distinctions, and native-regex execution boundaries grounded in current source and tests.
status: stable
tags: [core, memory, search, glob, agents, unicode]
sources:
  - id: design-issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/173
    title: Search and glob over a volume
  - id: search
    resource: ../../packages/core/src/internal/search.ts
    title: Snapshot selection, immutable traversal, and budgets
  - id: content
    resource: ../../packages/core/src/internal/searchContent.ts
    title: Whole-file classification and bounded content matching
  - id: filename-tests
    resource: ../../packages/core/test/Search.test.ts
    title: Filename selection, aliases, and no-copy tests
  - id: content-tests
    resource: ../../packages/core/test/SearchContent.test.ts
    title: Content classification, byte positions, and accounting tests
  - id: snapshot-model
    resource: ../../packages/core/src/Snapshot.ts
    title: Immutable snapshot model
  - id: snapshot-walk
    resource: ../../packages/core/src/internal/image.ts
    title: Shared snapshot state and copying fixture iterator
  - id: core-runtime
    resource: ../../packages/core/src/internal/virtualFileSystem.ts
    title: Snapshot capture, live reads, and relatime coordination
  - id: public-walk
    resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Caller walk and privileged snapshot-entry contracts
  - id: tree-transfer
    resource: ../../packages/memory/src/internal/treeTransfer.ts
    title: Transfer limits applied after snapshot entry emission
  - id: legacy-glob
    resource: ../../packages/memory/src/internal/glob.ts
    title: Existing UTF-16 glob grammar and matcher
  - id: adapter-glob
    resource: ../../packages/memory/src/internal/glob.ts
    title: Adapter glob compilation, collected traversal, exclusions, error mapping and sorted output
  - id: effect-regexp
    resource: https://github.com/Effect-TS/effect/blob/b5a2d4c1d62c9620a68d72b7f20248c69ef7663b/packages/effect/src/RegExp.ts#L37
    title: Effect 4 native RegExp constructor
  - id: effect-string
    resource: https://github.com/Effect-TS/effect/blob/b5a2d4c1d62c9620a68d72b7f20248c69ef7663b/packages/effect/src/String.ts#L690-L710
    title: Native string matching helpers
  - id: effect-check
    resource: https://github.com/Effect-TS/effect/blob/b5a2d4c1d62c9620a68d72b7f20248c69ef7663b/packages/effect/src/SchemaAST.ts#L4178-L4214
    title: Schema regex cloning and lastIndex ownership
  - id: effect-codec
    resource: https://github.com/Effect-TS/effect/blob/b5a2d4c1d62c9620a68d72b7f20248c69ef7663b/packages/effect/src/Schema.ts#L9217-L9238
    title: Typed regex compilation errors in the JSON codec
  - id: effect-pattern-policy
    resource: https://github.com/Effect-TS/effect/blob/b5a2d4c1d62c9620a68d72b7f20248c69ef7663b/packages/effect/src/SchemaRepresentation.ts#L2268-L2297
    title: Explicit trust policy for imported native regex
  - id: effect-pattern-docs
    resource: https://github.com/Effect-TS/effect/blob/b5a2d4c1d62c9620a68d72b7f20248c69ef7663b/packages/effect/SCHEMA.md#L6405-L6411
    title: Owning documentation on blocking native patterns
  - id: ecmascript
    resource: https://tc39.es/ecma262/multipage/text-processing.html
    title: Native regex indices, flags, case folding, and test semantics
  - id: text-decoder
    resource: https://encoding.spec.whatwg.org/#interface-textdecoder
    title: Fatal UTF-8 decoding and BOM handling
  - id: git-ignore
    resource: https://git-scm.com/docs/gitignore#_pattern_format
    title: Git ignore syntax and directory precedence
  - id: ripgrep
    resource: https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md#automatic-filtering
    title: Ripgrep application filtering defaults
generated: { by: codex/okf, at: "2026-10-02T10:00:00+00:00" }
---

# Snapshot search and glob evidence

Core implements snapshot filename and content queries. The [snapshot search decision](../decisions/snapshot-search.md "informs") owns the accepted design. The [snapshot search contract](../contracts/snapshot-search.md "constrained by") owns public behavior. This report retains source findings and boundaries that explain those choices.

## Snapshot authority and fixture recipes

Snapshot capture wraps an immutable `VolumeState` reference inside a coordinated observation. It does not traverse the tree or copy payloads. Retaining a snapshot retains its reachable state and payloads. Capture cost does not establish constant-cost traversal or unlimited retention.[^snapshot-model][^core-runtime] The [snapshot contract](../contracts/snapshots-and-fixtures.md "constrained by") defines the supported behavior.

The fixture iterator copies regular-file bytes before downstream filters run. `TreeTransfer.fromSnapshot` applies payload budgets after an entry is emitted. Filename queries built on fixture entries therefore copy payloads before selecting names.[^snapshot-walk][^tree-transfer] The [byte ownership contract](../contracts/byte-ownership.md "constrained by") explains why transfer copies bytes.

Fixture traversal serializes the first name of a shared file with content and subsequent names as hard-link entries. Search instead evaluates every eligible pathname as a regular file, including an alias whose first serialized name would be excluded. Current filename and content tests cover that distinction.[^snapshot-walk][^filename-tests][^content-tests] The [tree transfer contract](../contracts/tree-transfer.md "contrasts with") owns fixture serialization.

`snapshotEntries` has privileged snapshot authority. Live `Caller.walk` checks directory permissions and observes directories separately. A later `readFile` checks file authority and can refresh relatime, including a durable metadata commit. That recipe does not provide a single immutable tree or a no-atime content query.[^public-walk][^core-runtime] See [relatime reads](../decisions/core/relatime-reads.md "constrained by").

## Selection and Unicode

The memory adapter's legacy glob compiler operates on UTF-16 code units. Core snapshot globs operate on Unicode scalar characters. These are separate contracts. Adapter glob collects traversal before exclusions and output sorting, so exclusion does not prevent the earlier visit.[^legacy-glob][^adapter-glob]

Core selects filenames before inspecting payloads and checks directory preparation budgets before constructing sorted child lists. Filename tests guard payload access and exercise wide directories, Unicode matching, aliases, symlinks, exclusions, and stopped reports.[^search][^filename-tests]

The content scanner classifies the complete selected file before emitting results. Invalid UTF-8 or NUL makes the file ineligible, including when an otherwise matching prefix precedes an invalid tail. Tests cover tails beyond classification checkpoints and scalars that cross those checkpoints.[^content][^content-tests]

Fatal UTF-8 decoding rejects malformed input. `ignoreBOM: true` preserves the leading BOM. Native regex positions use UTF-16 indices, so the scanner maps positions back to original UTF-8 byte offsets, preserving BOM and newline bytes.[^text-decoder][^ecmascript][^content] Content tests cover emoji offsets, BOM, CRLF, lone CR, final lines, and zero-width matches.[^content-tests]

## Native regex execution boundaries

Effect's `RegExp.RegExp` aliases `globalThis.RegExp`. Its string matching helpers use native matching. Schema pattern checks clone expressions and reset their owned `lastIndex`. The JSON regex codec converts compilation errors into typed schema failures. These are precedents for native syntax, state ownership, and typed invalid-pattern errors.[^effect-regexp][^effect-string][^effect-check][^effect-codec]

Imported JSON Schema patterns have an explicit trust policy. Their default is rejection, with native matching available for trusted documents. Effect's owning documentation warns that native evaluation can block for unbounded time.[^effect-pattern-policy][^effect-pattern-docs]

Search caps constrain input sizes and surrounding work. They do not impose a deadline inside synchronous native regex execution. An Effect timeout on the same JavaScript thread cannot preempt that call. Applications accepting generated regex own the trust and execution policy.[^content][^ecmascript]

External RE2-derived engines were excluded by the accepted Effect-only dependency policy. Worker isolation would add runtime-specific worker ownership, copying, and termination. A bounded regex subset would add a grammar, compiler, Unicode policy, and correctness suite. Neither is part of the accepted design.

Explicit include and exclude globs do not implement `.gitignore`. Git rules include nested precedence, directory-only patterns, and re-inclusion restrictions. Ripgrep adds application filtering defaults. Ignore discovery and indexes remain separate from core search.[^git-ignore][^ripgrep]

## Evidence limits

Current tests establish payload-access boundaries, full-file classification, alias handling, byte-offset mapping, and observable accounting. They do not establish an allocation profile, universal performance advantage, worst-case regex latency, or physical memory bounds.[^filename-tests][^content-tests]

Historical timing scripts and reports are no longer retained. This concept makes no timing or mutation-audit claim from those removed artifacts. Future performance decisions need fresh reproducible measurements of the relevant workload.

[^snapshot-model]: `Snapshot.ts` and `image.ts` retain immutable snapshot state.

[^core-runtime]: Snapshot capture and live read relatime coordination in `virtualFileSystem.ts`.

[^snapshot-walk]: `image.ts` implements aliases, sorted child traversal, and copying fixture entries.

[^tree-transfer]: `treeTransfer.ts` applies transfer budgets to emitted entries.

[^public-walk]: Caller walk and privileged snapshot entry contracts in `VirtualFileSystem.ts`.

[^legacy-glob]: The adapter matcher uses `charAt` and UTF-16 string lengths.

[^adapter-glob]: Adapter glob collects its walk before exclusions and output sorting.

[^search]: `search.ts` owns bounded snapshot selection and traversal.

[^content]: `searchContent.ts` owns classification, original-byte mapping, and matching.

[^filename-tests]: Public filename search tests in `Search.test.ts`.

[^content-tests]: Public content search tests in `SearchContent.test.ts`.

[^text-decoder]: WHATWG Encoding defines fatal decoding and BOM preservation.

[^ecmascript]: ECMAScript defines regex positions, matching, and native execution semantics.

[^effect-regexp]: Effect's native regex constructor alias.

[^effect-string]: Effect's native string matching helpers.

[^effect-check]: Schema pattern checks clone and reset the expression before testing.

[^effect-codec]: The JSON codec reports regex constructor failure as a schema issue.

[^effect-pattern-policy]: Imported patterns default to rejection and allow trusted native application.

[^effect-pattern-docs]: Effect documents the blocking risk of native patterns.

[^git-ignore]: Git's pattern format and parent-directory re-inclusion rules.

[^ripgrep]: Ripgrep's automatic filtering is application behavior.
