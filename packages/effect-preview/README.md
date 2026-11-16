# Evaluate the proposed Effect filesystem

This private package ports [Effect PR #9960](https://github.com/Effect-TS/effect/pull/9960) at
`a70c8b9b29994ec1d53b49bb49436527f149d85e` and shares the installed Effect 4.1.4 runtime. Core uses the
preview engine for its public constructors and native binding. Memory and Node use that same core state.

## Build and run the preview

Run the preview and consumer suites from the repository root. The Node suites require a Node runtime with
`--experimental-vfs`.

```sh
bun install --frozen-lockfile
bun run build
bun run --cwd packages/effect-preview test
bun run --cwd packages/effect-preview type-check
bun run --cwd packages/core check:preview-imports
bun run --cwd packages/core test
bun run --cwd packages/memory test
bun run --cwd packages/node test
bun run --cwd packages/node test:mounted
```

The import audit checks that core construction and the native binding use the preview. Existing consumer tests
define the drop-in contract. Core adapts the preview commit feed for volume and caller-confined watches. LiveVolume uses the same engine with private storage and restore hooks. Current results and adapter findings are tracked in [issue #328](https://github.com/lloydrichards/effect-virtual-fs/issues/328).

Import the proposed public API and authorize a scoped caller:

```ts
import { VirtualFileSystem } from "@effect-vfs/effect-preview"
import { Effect } from "effect"

const program = Effect.scoped(Effect.gen(function*() {
  const owner = yield* VirtualFileSystem.make()
  const caller = yield* owner.authorize({ credentials: { uid: 0, gid: 0 } })
  yield* caller.writeFile("/hello.txt", new TextEncoder().encode("Hello"))
  return new TextDecoder().decode(yield* caller.readFile("/hello.txt"))
}))
```

Use this package's `BytePath`, `Schema`, and `DateTime` exports when using the preview's prerequisite APIs.
BytePath values are authenticated by one module-local registry. Convert community paths through bytes when crossing
implementations. References, revisions, handles, and callers belong to their issuing filesystem and are not transferable.

## Try durable writes, cleanup and recovery

Core owns the v1 live-image format and the storage provider contract. The preview stages a mutation until the
store accepts its candidate. Rejection discards the candidate. An unknown outcome freezes the session until the
application reopens the image from storage. The allocator, volume identity, and reference keys survive reopen.

After building the workspace, run the on-disk reopen and last-handle cleanup checks:

```sh
bun packages/effect-preview/experiments/durable-mkdir/run.mjs
```

The root test suite also exercises SQLite writer death before COMMIT and after acknowledgement.
[Physical power-loss qualification](../persistence/POWER_LOSS_TESTING.md) has a separate procedure.

## Regenerate the pinned port offline

The checked-in `upstream/files.json` retains the selected PR patches. `upstream/manifest.json` records their SHA-256
hashes, source repository, base commit, head commit, and PR URL. The upstream MIT license is retained in `LICENSE`.

```sh
bun run --cwd packages/effect-preview sync
bun run --cwd packages/effect-preview sync:check
bun run --cwd packages/effect-preview test:sync
```

Regeneration uses the checked-in snapshot, Bun, and `git apply`. It does not fetch source or resolve dependencies.
`sync:check` verifies every input checksum, compares generated files byte for byte, and rejects unexpected files.
The build runs this check before compilation. `test:sync` regenerates a temporary package and proves that manual
engine edits, extra generated files, and corrupted snapshots or contribution patches fail verification.

### Downstream regression coverage

The pinned revision includes the engine changes previously carried in patches 0001–0032 on
[PR #329](https://github.com/lloydrichards/effect-virtual-fs/pull/329). The preview imports the upstream storage
tests alongside the filesystem suite. The sole entry in `patches/series.json`, `downstream-regression-tests.patch`,
retains runtime and type assertions from the evaluation that are absent from the upstream snapshot. It touches only
upstream test paths. Regeneration checks its SHA-256 and applies it before rewriting imports.

Do not edit `src`, `test`, or `typetest` directly. These directories are generated and excluded from repository
formatting and style linting to preserve the reviewed upstream implementation. Runtime tests, strict compilation,
type assertions, and source regeneration still check them. Hand-written scripts and app integration use repository linting.

The generator makes these adaptations:

- Redirect Effect imports to installed public modules and redirect prerequisite imports to `src/compat`.
- Convert local module extensions to `.js` for the compiled package.
- Extract the added Bytes, DateTime, and Schema facilities rather than copying those complete Effect modules.
  UnixNano uses the equivalent public DateTime exports in place of upstream internal aliases.
- Re-export installed APIs alongside the added prerequisite facilities. BytePath schema code generation names this
  package's BytePath export so its emitted type import resolves locally.
- Retain the new runtime and TSTyche suites, the added Bytes tests, and the two added schema representation tests.
  Supply the existing Bytes fixture and schema assertion helpers used by those additions.
- Run the duplicate-copy/reload identity probe against built JavaScript and the shared Effect runtime.

The port keeps upstream's unchecked array and index-signature access settings. Other strict compiler settings remain
enabled. The workspace's TypeScript 7 compiler checks source and runtime tests. TSTyche uses the pinned
`typescript-js` 5.9.3 compiler alias because it needs the JavaScript compiler API that TypeScript 7 does not expose.
It runs offline after installation, without downloading a compiler at test time.

## Update from a reviewed upstream commit

Make design changes in the upstream PR branch. Supply a local checkout that contains both the reviewed head commit
and its base commit. The refresh script reads committed source with Git and does not fetch, check out, or modify that repository.

```sh
bun run --cwd packages/effect-preview refresh /path/to/effect-checkout HEAD_SHA BASE_SHA
bun run --cwd packages/effect-preview sync
bun run --cwd packages/effect-preview test
bun run --cwd packages/effect-preview type-check
bun run --cwd apps/virtual-build test
bun run --cwd packages/core check:preview-imports
```

Replace `HEAD_SHA` and `BASE_SHA` with full 40-character commit hashes. Review the snapshot and generated diff together.
The import list covers the filesystem and prerequisite families from this PR. A new dependency or a prerequisite
that has merged upstream requires a generator review. If an upstream module is retired, remove its obsolete generated
file explicitly after reviewing the snapshot change; sync rejects unexpected files rather than deleting them.

Refresh does not promise that an arbitrary later PR revision works without adaptation. Keep engine fixes upstream
and local adaptations in the generator. After an Effect release includes the accepted APIs, switch the consumer's
imports, rerun the same qualification, and remove this temporary package.
