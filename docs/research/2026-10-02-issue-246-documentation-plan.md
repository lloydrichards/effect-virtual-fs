# Plan the isolated-filesystem migration guide

Research date: 2026-10-02. Repository baseline: `6d9ffcbbacdcda9f4a46742be6018d60d1adfa81`.

## Decision

Extend and reorganize [Test with an isolated filesystem](../../apps/docs/app/content/guides/testing-with-an-isolated-filesystem.mdx). Keep its URL. Make the first complete test run an application action and inspect its output through the same filesystem service.

Keep the guide focused on migration tasks. Explain layer lifetime where readers choose test state. Replace the combined permission-and-watch example with a focused permission test. Add explicit parent setup, capacity failures, and assertions against seeded state.

Do not add a competing migration guide. Do not make the documentation depend on an unfinished fault or spy API. Keep guide navigation flat for this change. Consider grouping API reference pages by package in a separate change.

This plan was drafted before implementation. The guide and its navigation label are now updated. See the implementation and verification record below. Application behavior is unchanged by this documentation work.

## Sources and boundaries

- [Issue #246](https://github.com/lloydrichards/effect-virtual-fs/issues/246) requires four focused migration examples in the existing guide and assertions that prove the stated behavior.
- [Spencer Beggs's feedback](https://github.com/Effect-TS/effect/pull/6573#issuecomment-5915171307) describes tests that hid missing parents, removed nonexistent state, mocked parsing, or inferred skipped writes from timestamps. Its examples use another package. Those helper names must not appear as usable APIs for this repository.
- [Current API evidence](./2026-10-02-issue-246-api-evidence.md) records source and test evidence for the contracts used by this outline.
- [The content registry](../../apps/docs/app/content-pages.ts) owns guide labels and sections. [Navigation configuration](../../apps/docs/app/nav.config.ts) groups consecutive content entries and adds API pages.
- [The structure checker](../../apps/docs/scripts/check-docs.ts) checks content, route, and navigation membership. [The example checker](../../apps/docs/scripts/check-examples.ts) compiles source-comment API examples and executes examples with supported output assertions. Neither proves that handwritten MDX examples compile or run. The structure checker does not validate every internal link or heading anchor.

Use the installed Effect 4 APIs and the project's package exports. Recheck related issue status before implementation. An issue's historical wording is not proof that an API remains unimplemented.

On 2026-10-02, `npm view @effect-vfs/memory version peerDependencies.effect --json` reported version `0.7.1` and Effect `^4.0.0`. Local `layerFromFixture` documentation marks the helper `@since 0.8.0`. Inspect the published artifact before assuming the helper works with the guide's `@latest` install command. If it is absent, use `Vfs.fromFixture` with `MemoryFileSystem.bind`, or coordinate publication before presenting the shorter helper.

## Reader and document mode

The primary reader knows TypeScript and has filesystem tests built around temporary directories or stubs. The reader needs a how-to guide, not a general introduction to Effect testing.

The guide assumes the application requests `FileSystem.FileSystem`. State that boundary near the opening. Code that calls `node:fs`, launches a child process, or uses a native filesystem reader needs a different test boundary.

Use Bun Crypto in complete examples because the current guide already uses it. Name that runtime choice and link to the compatible provider for other runtimes. Explain once that volume construction requires `Crypto.Crypto`. Do not require `Path.layer` unless an example actually uses `Path`.

Proposed opening:

> Replace temporary directories and filesystem stubs with a fresh in-memory volume. Run the action and its assertions in one provided Effect so the test checks the files the program changed.

Retain enough installation context to make the examples usable. Link deeper explanations and API details instead of repeating them.

## Proposed outline

### 1. Install the test dependencies

Retain the matching Effect dependency commands and Vitest integration. Retain the existing compatibility page's ESM requirement, confirm the published manifests, and state the runtime used by the examples. Link to compatibility information for package versions and other runtime providers.

### 2. Keep production code independent of storage

Retain `writeManifest`. It requests `FileSystem.FileSystem`, creates `/dist`, writes JSON, and reads the result. Explain the service boundary in one paragraph.

Do not refactor the application example to create a migration failure. Use a separate direct write for the missing-parent example.

### 3. Run the action and assertions against one volume

Make this the first complete `it.effect` example. Acquire the filesystem, run `writeManifest("1.2.3")`, read `/dist/manifest.json`, parse those bytes, and assert the version. Put one `Effect.provide(MemoryFileSystem.layer)` around the complete program, followed by the Crypto provider.

Explain that separately building the same layer for an action and a later assertion creates different volumes. A later read may fail or inspect unrelated seeded state. Keep the contrast brief. Do not add another complete program just to demonstrate the mistake.

#### Provide fresh state to each test

Retain the second test that checks the manifest is absent in a fresh volume. Place the `it.layer` warning here: it builds once for its test group, so those tests share state.

Explain shared layer values and `Layer.fresh` only as needed to make the lifetime choice clear. Link deeper service ownership to the filesystem model rather than teaching layer construction internals.

### 4. Create the parent directories your test needs

Show a direct write to `/output/_meta.json` failing because `/output` is absent. Assert the adapter's public `NotFound` result, then create `/output` with `makeDirectory` and repeat the write successfully. Read back the output.

Explain that a former `mkdtemp` setup may have created a required directory without the test stating that precondition. An isolated volume makes the precondition explicit.

### 5. Seed the preconditions your test asserts

Keep the current `layerFromFixture` example that reads and parses real JSON. Remove `Path.layer` from the primary example unless path composition is the behavior under test.

Add a small seeded removal example. Seed a directory with a file, assert that the file exists, call the cleanup action, and assert that the seeded tree is absent. Define any helper shown in the example. The test must not assert removal of a path that never existed.

State constructor behavior beside the fixture example: `make` and `layer` create `/tmp`; `bind` leaves the supplied volume unchanged; `layerFromFixture` adds no entries. A fixture that needs temporary-file operations must include `/tmp`.

Link to the existing fixture guide for complete fixture rules. Keep fixture option signatures and construction error details in API reference.

### 6. Use real filesystem failures

Use `Testing.callerAs` to demonstrate core permission rules on a seeded volume. Label this as a core-caller example before the code. Assert `AccessDenied` for an unprivileged caller accessing a private directory. Remove watch collection because it proves a separate behavior.

Connect that example to application tests with a short adapter example: bind the same volume with the same restricted identity through `MemoryFileSystem.bind(volume, { identity })`. Assert the adapter's public permission error. The default binding is privileged, so changing file mode alone does not make it fail.

Add a small capacity test with a volume limit and a write that exceeds it. Choose one interface per example. A core caller exposes `NoSpace`; the adapter maps errors to Effect filesystem errors. Do not assert a core error code on an adapter error.

#### Inject a failure for a specific operation

Explain when natural permissions or capacity limits fit the scenario. A failure on only the second write requires a selected injected failure while other operations continue to use real storage.

Link to [#243](https://github.com/lloydrichards/effect-virtual-fs/issues/243) until the fault API exists. State that the helper is unavailable in the current API. Do not copy another package's `layerWith` or invent `layerFaulty` as runnable code.

Keep this subsection to a decision paragraph until an implemented helper can support a complete example.

### 7. Choose an assertion that proves the promise

Distinguish the two promises with a small table:

| Promise                                   | Evidence                                                      |
| ----------------------------------------- | ------------------------------------------------------------- |
| The output contains the requested version | Read and parse the actual output file                         |
| Cleanup removes the seeded tree           | Prove the tree existed before cleanup and is absent afterward |
| The output bytes are unchanged            | Compare bytes before and after the action                     |
| The build skips a write method            | Count calls to that method during each build                  |

Snapshots can prove state changes when the comparison matches the promised state. Their metadata may include differences that byte equality intentionally ignores.

Explain why modification times can remain equal after a rewrite. Core revisions describe committed mutations, not every attempted call. Overlay differences describe final state, not every intermediate operation.

Until a spy exists, describe the required write counts in prose and link to #243. Do not add an incomplete code block. Do not suggest that byte equality proves the build skipped writing.

Explain the derived-helper trap in a short paragraph: spreading a service and replacing `writeFile` leaves its existing `writeFileString` helper tied to the original implementation. A spy must observe the method the application calls, or rebuild derived methods through the appropriate constructor. Avoid adding a wrapper recipe whose semantics depend on unfinished #243 design.

### 8. Let the test scope release resources

Keep the current scope guidance short. `it.effect` runs the returned Effect and supplies the test scope. Explicit cleanup belongs in the test when cleanup is the behavior under test.

### 9. Check which code can still access the host

Retain the host-access limits. Link to the memory adapter reference, core testing reference, filesystem model, fixture guide, and overlay guide at the points where readers need them.

## Supporting pages and navigation

The reader audit and the structure audit agree that the testing guide should remain the migration entry point. They differ on how soon to divide guide navigation. Resolve that in favor of the smaller change because current guide topics do not yet support useful multi-page groups for every proposed section.

For #246, use sentence case for the testing navigation label and preserve the route. Keep the existing Start, Concepts, Guides, Reference, and API reference groups.

The following work is useful but separate:

| Candidate                       | Recommendation                                           | Reason                                                                                                      |
| ------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Filesystem state in tests       | Defer unless the revised guide needs lengthy explanation | Short lifetime and assertion explanations belong beside the relevant actions                                |
| A dedicated fixture how-to      | Consider after #246                                      | The snapshot guide currently combines fixture setup, transport, encoding details, decode limits, and deltas |
| Snapshot format reference       | Move format details here in a later audit                | Encoding layout and obsolete format history interrupt task instructions                                     |
| Guides overview                 | Defer                                                    | Existing links from Getting started and package selection can route readers without another page            |
| API navigation by package       | Prioritize as a separate navigation change               | Package names already label the API pages and match lookup tasks                                            |
| Guide navigation by task family | Revisit after supporting pages exist                     | Avoid creating one-item sections for anticipated content                                                    |

A future guide grouping could use Testing and workspaces, Snapshots and search, Persistence, and NFS. Treat those as candidate labels, not a requirement. Confirm where overlays belong with reader feedback. Preserve URLs when changing sidebar labels or groups.

Audit the broader set incrementally. `which-package` works primarily as a decision page despite its Concepts placement. The filesystem model mixes explanation with usage instructions. Persistence guides include ownership and durability explanation. Separate those parts only when a focused linked page serves a reader task, not to satisfy a classification rule mechanically.

## Implementation and review sequence

1. Recheck #243 through #245, installed APIs, and published fixture-helper availability. Coordinate fault and spy examples with #243.
2. Revise the existing testing guide using the outline. Remove the general BDD naming, clock, and concurrency checklist to make room for migration-specific material. Keep necessary scope guidance.
3. Extract the exact complete MDX snippets into an explicit verification target. Check extraction against the guide so independently maintained copies cannot drift. Type-check the snippets and run their assertions. Define how the shared `writeManifest` snippet joins its test snippets. Record the commands and results.
4. Run `bun run docs:check` from the repository root. Check the guide's internal links and anchors separately. Run the docs build and relevant formatting checks after MDX edits.
5. Ask fresh persona reviewers to read the actual draft: a TypeScript developer new to VFS, an experienced Effect user maintaining tests, and an editor checking language and navigation. Ask each to identify missing information, excess detail, and the first point where a reader must infer a step.
6. Revise the draft from their feedback, then apply technical-writing and unslop again. Record which feedback changed the content and why any substantive suggestion was deferred.

## Completion criteria

- The existing URL remains the migration entry point.
- Complete examples prove parent setup, shared-volume assertions, parsing of fixture bytes, removal of seeded state, and real permission and capacity failures.
- Every example uses current exports and distinguishes core errors from adapter errors.
- The guide separates state equality from method-call counts and explains the derived-helper trap.
- Fault and spy helpers are presented as available only after implementation. Related links identify their status accurately.
- New runnable examples compile and execute. Documentation structure, build, formatting, links, and anchors pass their relevant checks.
- Persona reviews report that readers can locate the migration task and understand what each assertion proves.

## Review feedback incorporated

The first review used a TypeScript developer migrating temporary-directory tests and an information architect reading as a returning API user. A second pass reviewed this plan as a tired newcomer and a maintainer. Their feedback moved fresh-state guidance beside the shared-volume example, combined real and injected failure guidance, kept constructor defaults beside fixtures, removed an incomplete spy illustration, clarified the core-to-adapter boundary, and required verification of the exact published snippets.

The API researcher verified local source and tests but ran no runtime probes. New examples remain to be written and executed during implementation.

## Implementation and verification

Implemented on 2026-10-02 in the existing guide. The route and flat guide navigation remain intact. The navigation label now matches the page title in sentence case.

The guide includes complete application, parent-setup, fixture-parsing, seeded-removal, adapter-permission, core-permission, and capacity examples. It distinguishes unchanged content from skipped method calls and explains the existing derived-helper closure. Proposed fault and spy helpers remain linked as unfinished work.

The fixture example uses `Vfs.fromFixture` with `MemoryFileSystem.bind`. The npm `0.7.1` memory declarations lack `layerFromFixture`. Its source implementation is identified as planned for `0.8.0`, not presented as a published helper.

The exact titled TypeScript blocks were extracted from the guide without rewriting their code, checked together, and executed as tests. The shown `writeManifest.ts` joined its importing test through their filenames. This was one-time verification. At the user's request, the permanent guide checker, its dependencies, and its lint and script configuration were removed. The existing `docs:check` remains unchanged.

Validation passed:

- Before its removal, the guide checker compiled seven exact snippets and ran eight tests across six test files. These are historical verification results, not checks that remain in CI.
- `bun run docs:check` validated content structure, compiled 93 API examples, executed 58 with output assertions, and, before removal of the checker, passed the guide examples. It required an unsandboxed run for the existing `tsx` IPC socket.
- `bun run react-router build` from `apps/docs` built and prerendered the site. It required permission to open React Router's local server.
- `bun run type-check` from `apps/docs` passed.
- Targeted Oxlint, dprint, and `git diff --check` passed for the implementation files.
- The prerendered guide has one h1, all seven code filename captions, and valid destinations and anchors for its nine internal links.
- A separate probe extracted the same snippets beside the npm `0.7.1` core and memory tarballs. TypeScript compilation and all eight tests passed against those published packages with Effect `4.0.0`.

The draft received source review, newcomer review, and editor review. Changes from that feedback made Bun an explicit prerequisite, separated core and adapter permission examples, clarified selected failure injection, linked concrete snapshot comparison APIs, and identified the fixture helper as unreleased. Final newcomer and editor reviews found no remaining material issues. Supporting pages and broader API navigation changes remain the follow-up work described above.
