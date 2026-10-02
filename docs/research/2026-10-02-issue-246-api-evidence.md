# API evidence for issue 246

This review checks the current checkout against [issue 246](https://github.com/lloydrichards/effect-virtual-fs/issues/246). It supports the documentation outline. It does not change production code or documentation pages.

## Required parents

Ordinary writes require an existing parent. `packages/memory/test/FileSystemTest.ts:205` checks a missing parent through `writeFile` and asserts `NotFound`. The same test creates directories with `makeDirectory(path, { recursive: true })`.

Use a short failed-write example followed by explicit parent setup. For `writeFileString`, the underlying error method is `writeFile`, because Effect derives the string helper from that method.

`packages/memory/src/internal/memoryFileSystem.ts:309` constructs `make` from a fixture containing `/tmp`. `layer` wraps `make` at line 316. `bind` constructs a caller on the supplied volume at line 41 and adds no entries. Its public contract states this in `packages/memory/src/MemoryFileSystem.ts:203`.

## One volume for actions and assertions

Provide the filesystem layer around the complete test program. Separate builds allocate separate volumes, even when they use the same layer value.

`packages/memory/test/MemoryFileSystem.test.ts:1445` verifies separate builds by writing through one provide and reading the original seed through another. The following parameterized test verifies that sibling layers share a reused layer value within one graph, while `Layer.fresh` gives each sibling independent state.

The existing guide already explains group sharing with `it.layer` at `apps/docs/app/content/guides/testing-with-an-isolated-filesystem.mdx:156`. Retain that warning. Do not imply that every test in such a group gets a new filesystem.

## Fixtures are already convenient in this checkout

`MemoryFileSystem.layerFromFixture(fixture, volumeOptions?, callerOptions?)` exists at `packages/memory/src/MemoryFileSystem.ts:191`. Its implementation composes `Vfs.fromFixture` and `bind` at `packages/memory/src/internal/memoryFileSystem.ts:294`.

The tests beginning at `packages/memory/test/MemoryFileSystem.test.ts:1428` cover seeded text, POSIX `Path.layer` composition, separate builds, graph sharing, explicit `/tmp`, limits, credentials, and invalid construction inputs. Fixture layers add no implicit `/tmp`.

[Issue 244](https://github.com/lloydrichards/effect-virtual-fs/issues/244) still describes this helper as proposed. The source supersedes that description for the current checkout. The package manifest says `0.7.1`, while the helper's public documentation says `@since 0.8.0`. On 2026-10-02, `npm view @effect-vfs/memory version peerDependencies.effect --json` also reported `0.7.1` with Effect `^4.0.0`. Inspect the published artifact before presenting the helper as available in the latest published package. Use `Vfs.fromFixture` with `bind` if the helper is absent.

## Real permissions and capacity

`Testing.callerAs(identity, options?)` returns a core `Caller` on the `Volume` in context. It does not return an Effect `FileSystem`. See `packages/core/src/Testing.ts:107`. Its example creates `/private` with mode `0o700` and verifies `AccessDenied` for an unprivileged guest.

For a program that consumes `FileSystem.FileSystem`, bind the same volume with guest credentials through `MemoryFileSystem.bind(volume, { identity })`, or use fixture-layer caller options. The default binding is privileged, so merely changing file mode does not make the default caller fail.

Capacity examples must name the API boundary. Core reports `NoSpace`, but the adapter maps it to `PlatformError` with `reason._tag === "Unknown"` and `reason.description === "NoSpace"`. `packages/memory/test/MemoryFileSystem.test.ts:1378` checks a volume with `maxBytes: ByteSize.bytes(1)`. The mapping is in `packages/memory/src/internal/platformError.ts:9`. A per-file limit reports `FileTooLarge`, as tested at line 1485.

## Faults and spies remain proposed

The memory package exports `MemoryFileSystem` and `TreeTransfer` in `packages/memory/src/index.ts`. There is no public fault or spy helper in these modules or core `Testing`.

[Issue 243](https://github.com/lloydrichards/effect-virtual-fs/issues/243) proposes handlers that delegate unhandled operations, run when an Effect executes, and rebuild derived helpers. The guide can explain when to inject a selected failure and link the issue. It must not present proposed helper names as runnable examples.

The installed Effect version is `4.0.0`. `node_modules/effect/src/FileSystem.ts:493` constructs derived methods from `impl`. At line 559, `writeFileString` encodes bytes and calls `impl.writeFile`. Spreading an existing service and replacing `writeFile` retains the old closure. Rebuild with `FileSystem.make` when intercepting the base method. A `writeFile` counter does not cover writes through open file handles or `sink`, which uses `impl.open` at line 552.

## Assertions must match the promised behavior

For unchanged output, compare bytes. For removal, seed the file or tree first and assert that the program removed it. For parsing, seed real bytes and assert the parsed result. For skipped writes, observe calls to the chosen method.

Modification times do not count calls. Core revisions advance on committed changes to an object, as stated in `packages/core/src/Metadata.ts:67`. `packages/core/test/LiveVolume.test.ts:793` demonstrates operations that complete without a commit, including a zero-byte write and empty `setattr`.

An overlay summary compares base entries with current entries. It does not record each operation. `packages/core/src/internal/overlayDiff.ts:101` takes base and current observations, and its comparison omits timestamps by default. A write followed by restoration can leave no content difference even though writes occurred.

## Outline constraints

- Extend the existing isolated-filesystem guide, as issue 246 requests.
- Keep runnable parent and shared-volume examples near the existing `writeManifest` example.
- Use the implemented fixture helper where appropriate, with a release-availability note if required.
- Separate core caller errors from adapter `PlatformError` assertions.
- Explain faults and spies without expanding issue 243 into a wrapper-design tutorial.
- Link host compatibility work in [issue 245](https://github.com/lloydrichards/effect-virtual-fs/issues/245). Do not claim that memory tests establish compatibility across host adapters or operating systems.

This review read source and tests. It did not run tests or execute new examples. Implementation should verify final snippets through the documentation checks.

## Verification after implementation

The revised guide's seven exact TypeScript snippets compile, and its eight tests pass against both workspace packages and separate npm `0.7.1` core and memory artifacts. The published memory declarations confirm that `layerFromFixture` is absent, so the runnable fixture example uses `fromFixture` and `bind`. See the [implementation record](./2026-10-02-issue-246-documentation-plan.md#implementation-and-verification) for commands, review feedback, and validation limits.
