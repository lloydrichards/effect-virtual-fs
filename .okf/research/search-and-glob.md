---
type: Research
title: Snapshot search and glob evidence
description: Retains measured recipe costs, immutable-state and alias constraints, Unicode findings, and Effect's native-regex precedent for issue 173.
status: stable
tags: [core, memory, search, glob, agents, unicode]
sources:
  - id: design-issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/173
    title: Search and glob over a volume
  - id: benchmark
    resource: ../../docs/research/issue-173/benchmark.ts
    title: Reproducible public-API recipe benchmark
  - id: glob-benchmark
    resource: ../../docs/research/issue-173/glob-benchmark.ts
    title: Implemented glob versus recipe benchmark
  - id: glob-measurements
    resource: ../../docs/research/issue-173/glob-benchmark-results.json
    title: Recorded filename query comparison
  - id: content-benchmark
    resource: ../../docs/research/issue-173/content-benchmark.ts
    title: Implemented content modes versus recipe benchmark
  - id: content-measurements
    resource: ../../docs/research/issue-173/content-benchmark-results.json
    title: Recorded content scan and copy comparison
  - id: measurements
    resource: ../../docs/research/issue-173/benchmark-results.json
    title: Historical Bun baseline and alias/laziness probes
  - id: content-regressions
    resource: ../../docs/research/issue-173/content-regression-evidence.json
    title: Targeted safe content regression checks
  - id: core-package
    resource: ../../packages/core/package.json
    title: Core public imports resolve to built dist files
  - id: memory-package
    resource: ../../packages/memory/package.json
    title: Memory public imports resolve to built dist files
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
  - id: effect-router
    resource: https://github.com/Effect-TS/effect/blob/b5a2d4c1d62c9620a68d72b7f20248c69ef7663b/packages/effect/src/http/FindMyWay/internal/router.ts#L470-L493
    title: Native route matching before captured-parameter length checks
  - id: effect-cli
    resource: https://github.com/Effect-TS/effect/blob/b5a2d4c1d62c9620a68d72b7f20248c69ef7663b/packages/effect/src/cli/internal/lexer.ts#L49-L55
    title: Fixed developer-authored CLI numeric pattern
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
generated: { by: codex/okf, at: "2026-10-02T07:57:50.958690+00:00" }
---

# Snapshot search and glob evidence

Issue #173 asks whether filename/content search can use a snapshot Stream recipe or needs a dedicated API.
This note retains source findings and executed probes. The [snapshot search decision](../decisions/snapshot-search.md "informs")
owns the accepted design: core ownership, only Effect as a dependency, snapshot authority, Unicode
string globs, native JavaScript regex, and explicit exclusions. Filename and content `Search` are implemented. Earlier engine, byte-glob, and API-shape proposals are superseded by that decision.

## Implemented foundations and recipe limitations

Snapshot capture wraps the immutable `VolumeState` reference inside a coordinated observation. It does not walk the
tree or copy payloads. Admission and wrapper allocation still occur; retaining a snapshot retains old reachable
state and payloads. This supports cheap capture, not constant-cost traversal or unlimited snapshot retention.[^snapshot-model][^core-runtime]
The owning [snapshot contract](../contracts/snapshots-and-fixtures.md "constrained by") remains authoritative.

The fixture iterator is lazy and uses one-entry chunks. On pulling a regular file it executes `current.data.slice()`;
downstream path filters run after that copy. `TreeTransfer.fromSnapshot` applies file/payload budgets after the entry
is emitted. A filename-only or selective search built on those entries therefore still pays for excluded payload
copies. Sorting one directory also allocates its entire child array: laziness alone does not bound wide-directory
preparation.[^snapshot-walk][^tree-transfer] This follows the [byte ownership contract](../contracts/byte-ownership.md "constrained by").

Fixture traversal emits the first name of a shared object with content and subsequent names as `hardLink` entries.
An executed fixture containing `/a.bin` with `needle` and alias `/z.ts` produced zero `.ts` matches when the recipe
accepted only `kind === "file"`; live `Caller.walk` exposed the alias as a regular file and produced one. A path-oriented
search must evaluate every eligible name independently instead of inheriting transfer's first-name representation.[^measurements]
The [tree transfer contract](../contracts/tree-transfer.md "contrasts with") owns that serialization behavior.

Existing `snapshotEntries` resolves its root with privileged semantics and has no live caller identity. Its paths are
rebased to `/`, and traversal is depth-first preorder with each directory's children sorted by raw name bytes.
That is not a global sort of complete paths. Discovered symbolic links are emitted without recursive traversal.
The accepted search API's root/output conventions are separate decisions, not properties to infer from transfer.[^public-walk]

Live `Caller.walk` checks caller directory permissions, observes each directory separately, and refreshes no access
time. Following it with `readFile` checks file authority but can refresh relatime, including a durable metadata commit.
That recipe avoids reads of excluded payloads, but does not provide one immutable tree or a no-atime content query.
Possessing a snapshot grants whole-snapshot authority; it is not a permission-filtered caller capability.[^public-walk][^core-runtime]
See [relatime reads](../decisions/core/relatime-reads.md "constrained by").

## Retained measurement baseline

The benchmark used public snapshot/transfer/caller APIs. `git ls-files` supplied fixture inventory, and host bytes
were imported before query timing; no host search command supplied matches. The historical run used Bun 1.4.0,
Effect 4.0.0, core/memory 0.7.1, Apple M4 Pro, macOS arm64, and revision
`159fc0da58d522b4ab81416d22ebdf5374a496b5`. The real fixture contained 511 tracked files and 4,729,558 bytes.
Its path/content SHA-256 is `ddaf9d1ef8001d6c832dee34a65d4c853dcbdba25824a4f5910c54498e0c995a`.[^measurements]

Each operation had two warmups and five samples, with forced GC before each measured sample. Queries counted results
with `Stream.runFold`; they did not retain a result array. The literal query selected `.ts` files and searched for
`Effect.gen` with replacement UTF-8 decoding. Medians, in milliseconds:[^benchmark][^measurements]

| Fixture                            | Snapshot capture | First content result | Complete content query | Ten repeated queries |
| ---------------------------------- | ---------------: | -------------------: | ---------------------: | -------------------: |
| Tracked repository, 511 files      |            0.109 |                0.763 |                  1.623 |               14.385 |
| 10,000 synthetic files, 4 KiB each |            0.061 |                0.160 |                 16.871 |              181.743 |

The real complete query found 92 matching files, copied all 4,729,558 payload bytes, and decoded 2,827,008 bytes from
217 selected `.ts` files. Its first result followed 163 emitted entries and 791,969 copied bytes. A selective synthetic
fixture of 1,000 files at 64 KiB each copied 65,536,000 bytes to decode 655,360 bytes. Reusing the snapshot did not cache
those copies or decoded text. The alias probe and a small-file/oversized-file probe also verified that an early pull
can succeed before a later `LimitExceeded` failure.[^measurements]

These results do not justify indexing or a new API on speed alone. They support direct scanning as a starting point;
alias correctness and filtering before copying remain concrete reasons for a dedicated helper. Five samples on one
machine are not tail-latency, allocation, peak-memory, browser, regex, or worst-case cancellation evidence. Synthetic
matches occurred near the beginning. End-minus-start process memory deltas are not an allocation profile. The
replacement decoder and simple recipe do not validate the accepted strict-text search contract.[^benchmark]

On a fresh checkout, install workspace dependencies and build core and memory before reproducing from the repository
root. Their public imports and types resolve to built `dist` files.[^core-package][^memory-package]

```sh
bun install --frozen-lockfile
bunx turbo run build --filter=@effect-vfs/core --filter=@effect-vfs/memory
bun run docs/research/issue-173/benchmark.ts
bunx tsc --project docs/research/issue-173/tsconfig.json --noEmit
```

The retained JSON is unchanged historical evidence; its command points to the former scratchpad location. The
relocated benchmark writes a fresh result to the OS temporary directory as
`effect-vfs-issue-173-benchmark-latest.json`. It reads current tracked working-tree bytes, so changed tracked files alter
the fixture hash. It measures the existing recipe. The separate filename comparison below measures the implemented glob design.[^benchmark]

## Implemented filename comparison

The [filename contract](../contracts/snapshot-search.md "evidenced by") is tested with guarded payload access and
preparation enumeration. The new `docs/research/issue-173/glob-benchmark.ts` compares `Search.scanGlob` with
`snapshotEntries` followed by a `.ts` filename filter, against the same imported fixture and raised output caps.
Build core first and run the script from the repository root. Both use Stream result counts, two warmups and five
samples. The retained `glob-benchmark-results.json` records fixture identity and working-tree provenance.

On Bun 1.4.0, Apple M4 Pro, the recorded tracked fixture returned 218 matching paths for both queries. Recipe median
was 1.039 ms and Search median 16.230 ms; the recipe copied 4,818,420 payload bytes while Search accessed none.
For 1,000 files at 64 KiB each, selecting ten `.ts` paths, medians were 2.085 ms and 9.495 ms; the recipe copied
65,536,000 payload bytes. Neither query decoded content. Search's work reports charge zero scanned content bytes.
Search's current explicit bounded matching incurs more CPU work in these cases; this evidence supports its alias,
policy and no-copy contract, not a speed improvement. Timings are bounded observations on one machine, not allocation
profiles or deadline guarantees.

## Unicode and text findings

The existing memory glob compiler accepts relative POSIX patterns with `*`, `?`, classes, comma braces capped at
256 expansions, and whole-segment `**`. It uses `charAt` and string lengths, so wildcard units are UTF-16 code units.
The executed Bun probe found `?.ts` versus `😀.ts` false, `??.ts` true, and `[😀].ts` false. ASCII examples confirmed
`*.ts` excludes nested `src/a.ts`, while `**/*.ts` includes it; numeric braces and extglobs are literal syntax.[^legacy-glob]

The adapter collects traversal before exclusions and output-string sorting. Excluding a subtree therefore does not
prevent visiting it or converting names first. The accepted Unicode glob behavior must be implemented deliberately;
extracting the legacy matcher unchanged would not produce scalar-character or arbitrary-byte matching. Keeping
`BytePath` results lossless does not itself define which names a string glob can match.[^adapter-glob]

An executed decoder probe showed `new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })` preserves leading U+FEFF;
default BOM handling removes it. Fatal decoding rejects malformed bytes instead of inserting replacement characters.[^text-decoder]
Classify an entire selected file before emitting any line if invalid UTF-8/NUL makes the file ineligible; a stream
cannot retract a valid-prefix match after an invalid tail. The shared content scanner enforces this whole-file classification.

Native regex `exec` reports UTF-16 positions even with `u`. Both Node 24.21.0 and Bun 1.4.0 returned `[2, 3)` for `x`
in `😀x`; its UTF-8 range is `[4, 5)`. Map byte ranges against preserved original content, including BOM and newline
bytes. Do not publish an unqualified `column` or treat `u` as a byte-index flag.[^ecmascript]

## Effect's native-regex precedent and its limits

Read-only inspection used Effect 4.0.0 revision `422930c96a90a53fa70269765a1e08e43b1ad772`. Cited source files were
identical to official upstream commit `b5a2d4c1d62c9620a68d72b7f20248c69ef7663b`; GitHub's API confirmed that commit.
The sources use upstream permalinks rather than machine-local checkout paths.

`RegExp.RegExp` deliberately aliases `globalThis.RegExp`; `String.match` and `matchAll` delegate to native methods.
`SchemaAST.isPattern` clones the caller's expression and resets its owned `lastIndex` before testing. The JSON RegExp
codec catches compilation errors as `SchemaIssue.InvalidValue`. These are precedents for native syntax, state
ownership, and typed invalid-pattern failures, not alternate execution engines.[^effect-regexp][^effect-string][^effect-check][^effect-codec]

Imported JSON Schema patterns have an explicit trust policy: `patterns: "error"` is the default, `"apply"` uses
native Unicode regex for trusted documents, and `"ignore"` skips constraints with documented semantic consequences.
Owning documentation explicitly warns that native evaluation may block for unbounded time.[^effect-pattern-policy][^effect-pattern-docs]
The HTTP router executes native regex before checking captured parameter lengths; that setting is not a regex-time
bound. CLI lexical matching uses a fixed developer-authored expression.[^effect-router][^effect-cli]

The accepted design follows Effect's native convention. Source/line/scan/result caps constrain inputs and surrounding
work; they do not enforce a deadline inside a synchronous native match. `Effect.timeout` cannot preempt that call on
the same JavaScript thread. Applications exposing agent-generated regex still own their trust/execution policy.
Do not infer a project-wide safety guarantee from ordinary native-regex usage.

Tiny, safe constructor and matching probes agreed across Node 24.21.0 and Bun 1.4.0:

- `u` did not match `é` against `É`; `ui` did. Atomic probes also matched Kelvin and sigma variants under `iu`, but
  did not expand `ß` into `ss`, normalize decomposed accents, or apply Turkic locale folding.
- Bare `(?i)todo` failed with `SyntaxError`; scoped `(?i:todo)` matched `TODO`. Scoped `(?-i:...)` can override outer `i`.
  The earlier RE2 bare-modifier proposal is superseded.
- `\p{Letter}+` matched `café`; `(?<=a)b` matched `b` in `ab`. These are tested runtime capabilities, not a browser
  compatibility promise for every native syntax feature.
- On line body `x\ry`, `^x.y$` with `u` failed and with `us` matched; `^x$` with `u` failed and with `um` matched `x`.
  Scoped `(?s:...)` and `(?m:...)` also worked with outer `u`. Restricting exposed flags to `u`/`i` does not prohibit
  runtime-supported scoped modifiers or make lone CR irrelevant.

For modes needing only existence, `.test` returns a boolean instead of exposing captures to the scanner. It does not
prove zero internal capture allocation or bounded execution; the specification invokes `RegExpExec` and converts its
result to boolean.[^ecmascript] No dangerous native patterns, browser execution, or heavy adversarial workload was run.

## Alternatives and application policy

External RE2-derived engines were excluded by the accepted Effect-only dependency policy. Vendoring an engine would
retain third-party code and maintenance costs despite removing its package dependency; it is not the chosen workaround.

Worker-isolated native regex would add runtime-specific worker ownership, copying, termination, and serverless
capability requirements. An owned bounded regex subset would add a grammar, compiler, prioritized matcher, Unicode
policy, and correctness/complexity suite. Native single-scalar predicates showed a possible way to reuse runtime
Unicode data, but did not establish a hard native-call bound. None is part of the accepted implementation direction.

Explicit include/exclude globs are not `.gitignore` semantics. Git rules involve anchoring, nested precedence,
comments/escapes, directory-only patterns, and re-inclusion restrictions; ripgrep adds hidden/binary/ignore defaults.
Application ignore discovery and indexes remain separate from core search. Claiming ripgrep parity would publish a
larger contract than this issue establishes.[^git-ignore][^ripgrep]

[^snapshot-model]: `Snapshot.ts` public model and `image.ts` lines 39–55 store the immutable state reference.

[^core-runtime]: Snapshot capture at line 3174, relatime machinery around lines 232–240 and 732–736, and `Caller.readFile` at line 2815.

[^snapshot-walk]: `image.ts` lines 178–230 implement aliases, sorted child preparation, copied payloads, and one-entry chunks.

[^tree-transfer]: `treeTransfer.ts` lines 248–265 check limits after snapshot entry emission.

[^public-walk]: Caller walk documentation around line 1133 and privileged snapshot entries around line 2238.

[^benchmark]: Retained source owns fixture construction, sampling, replacement decoding, counters, and relocated output.

[^measurements]: Historical JSON owns fixture identity, samples, byte counters, and alias/oversized-file probes.

[^core-package]: Core's public package exports and type declarations point into `dist`; its build script produces those files.

[^memory-package]: Memory's public package exports and type declarations point into `dist`; its build script produces those files.

[^legacy-glob]: `glob.ts` uses `charAt` around lines 189, 231, and 322; brace expansion is capped before compilation.

[^adapter-glob]: Adapter glob collects its walk before exclusions and output sorting.

[^text-decoder]: WHATWG Encoding defines fatal decoding and `ignoreBOM: true`; the local probe confirmed preservation.

[^ecmascript]: `RegExpBuiltinExec`, `Canonicalize`, modifier grammar, and `RegExp.prototype.test`; runtime probes establish only listed observations.

[^effect-regexp]: Native constructor alias at line 37.

[^effect-string]: Native matching at lines 690–691 and 710.

[^effect-check]: Clone/reset/test at lines 4209–4214.

[^effect-codec]: Typed constructor failure at lines 9223–9233.

[^effect-pattern-policy]: Default rejection and trusted application at lines 2268–2297.

[^effect-pattern-docs]: Blocking risk and ignore consequences at lines 6405–6411.

[^effect-router]: Native execution at line 471 precedes capture-length checks at line 487.

[^effect-cli]: Fixed pattern at line 49 and test at line 55.

[^git-ignore]: Git pattern format and parent-directory re-inclusion rules.

[^ripgrep]: Automatic filtering is application behavior, not a VFS default.

## Implemented content comparison

Build core and run `bun run docs/research/issue-173/content-benchmark.ts` from the repository root. The script imports
one tracked working-tree fixture and one selective synthetic fixture. It compares the retained snapshot recipe with
all three content Streams, verifies matching filenames and line totals, and records counters with two warmups and five
samples. The recipe fully decodes and splits selected valid text; files mode stops matching after the first hit.
These are equivalent results with different internal work. Native fixture loading is outside the timed searches.

The retained `content-benchmark-results.json` records Bun 1.4.0 on Apple M4 Pro. The tracked fixture produced 98 matching
files and 1,787 matching lines. The recipe copied 4,977,053 payload bytes before selection; Search charged 2,935,469
selected bytes. Recipe/files/lines/count medians were 4.361/45.850/98.093/94.058 ms.

For 1,000 synthetic 64 KiB files selecting ten TypeScript paths, all modes agreed on ten matching files and lines.
The recipe copied 65,536,000 payload bytes; Search classified 655,360 selected bytes, with ten line calls in files mode
and twenty in lines/count mode. Recipe/files/lines/count medians were 2.316/10.518/14.038/13.288 ms. Search is slower in
these workloads. The evidence supports selection before payload copying and deliberate coverage semantics, not a speed claim.

Guarded tests establish borrowing without `.slice` payload copies and no excerpt views in files/count mode. The scanner
still allocates bounded line and excerpt strings. `scannedBytes` charges full eligible files once and does not count
every internal validation, newline, offset, or excerpt pass. These measurements are not an allocation profile, worst-case
latency bound, or deadline guarantee. The historical recipe and filename measurements remain separate evidence.

Four targeted safe production mutations detected binary-tail admission, incorrect UTF-16-to-byte mapping, partial count
emission, and rejecting exact-fit result payloads. Each focused public test failed with an assertion mismatch, and the
restored content suite passed afterward. `content-regression-evidence.json` records the mutations and commands. This is
selected regression evidence, not a mutation audit of every active test or proof of native regex interruption.
