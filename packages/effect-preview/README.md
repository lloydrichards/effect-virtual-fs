# Evaluate the proposed Effect filesystem

This private workspace package ports [Effect PR #9960](https://github.com/Effect-TS/effect/pull/9960)
at commit `161258278d6618bb5a10804827bb7a5f34b04c4d`. It shares the installed Effect 4.1.4 runtime.
The package is experimental and is not published. The existing core constructors use this engine; memory and Node consume it through their existing core bindings.

## Build and run the preview

From the repository root, install the locked dependencies and build the package:

```sh
bun install --frozen-lockfile
bun run --cwd packages/effect-preview build
bun run --cwd packages/effect-preview test
bun run --cwd packages/effect-preview type-check
bun run build
bun run check:preview-compatibility
```

The compatibility command compares the preview with the existing core, memory, and Node boundaries and exits nonzero while any comparison differs. It requires Node 26.11.1 or later for the native provider import. It explicitly uses the retained community constructor as its baseline. The existing core, memory, and Node suites now run against the preview-backed core and remain the acceptance criteria.

This is the only new workspace package. Core consumes it as a runtime dependency. Core's compatibility facade translates its existing caller, target, metadata, snapshot, and handle interfaces onto the preview's public API. The existing memory adapter and Node provider retain their public interfaces and consume that same state. There is no fallback to the community engine.

The evaluation is not ready to merge or publish. Missing atomic publication, watch, durable-store, overlay, and metadata contracts still fail the unchanged tests. Additional adapter differences remain under qualification. See [the drop-in findings](../../.okf/research/preview-drop-in.md).

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

## Regenerate the pinned port offline

The checked-in `upstream/files.json` retains the selected PR patches. `upstream/manifest.json` records their SHA-256
hashes, source repository, base commit, head commit, and PR URL. The upstream MIT license is retained in `LICENSE`.

```sh
bun run --cwd packages/effect-preview sync
bun run --cwd packages/effect-preview sync:check
bun run --cwd packages/effect-preview test:sync
```

Regeneration uses the checked-in snapshot, Bun, and the system `patch` command. It does not fetch source or resolve dependencies.
`sync:check` verifies every input checksum, compares generated files byte for byte, and rejects unexpected files.
The build runs this check before compilation. `test:sync` regenerates a temporary package and proves that manual
engine edits, extra generated files, and corrupted snapshots or contribution patches fail verification.

### Local upstream contributions

`patches/series.json` lists ordered contribution patches and their SHA-256 hashes. The generator verifies them and
applies them with zero fuzz to a temporary upstream tree before adapting imports. The pinned snapshot and its
manifest remain unchanged. Generated-file checks cover the patched result.

`0001-preserve-caller-interruptibility.patch` replaces forced interruption at operation admission and before
publication with the caller's original interruption setting. Masked finalizers can finish filesystem cleanup;
ordinary writes retain cancellation before publication. The patch includes regression tests for interrupted-child
cleanup and masked writes interrupted through the clock, alongside the existing ordinary-write rollback test.

`0002-recursive-mkdir-dot-components.patch` allows unguarded recursive mkdir paths ending in `.` or `..` to resolve
through the existing transactional path walker. It preserves intermediate symlink traversal, rooted confinement,
and atomic rollback. Entry conditions still require a named final slot; dot targets with conditions retain their
existing `InvalidInput` rejection. Regression tests cover both resolution paths, byte paths, permissions, quotas,
and conditions. No public API changes or adapter changes are needed.

`0003-current-time-attributes.patch` adds `"now"` to the existing `Attributes.atime` and `mtime` inputs. Both markers
and ctime use one transaction clock sample. A write-authorized non-owner may request both times as `"now"`;
literal or mixed timestamp requests still require ownership, and other requested attributes keep their own checks.
Omitted fields remain unchanged. The patch includes runtime and type tests for the shared caller, operation-session,
handle, and synchronous APIs. Core preserves the markers instead of converting them into literal timestamps.

`0004-atomic-resize-attributes.patch` adds an optional byte-size input to `Attributes.size`. Resizing, metadata,
and timestamps publish in one transaction after prestate authorization and quota checks. Growth is zero-filled;
identity, hard-link aliases, and handle cursors are preserved. Handle resize uses its open-time write grant, while
path and reference resize check current write permission. Explicit times override resize's automatic mtime.
Runtime and type tests cover the shared attribute entry points, rollback, and guards. Core forwards combined
requests directly, including its existing error and revision conventions.

Apply these contributions in series order from an Effect checkout at the pinned PR commit:

```sh
patch --batch --forward --fuzz=0 -p1 < /path/to/effect-preview/patches/0001-preserve-caller-interruptibility.patch
patch --batch --forward --fuzz=0 -p1 < /path/to/effect-preview/patches/0002-recursive-mkdir-dot-components.patch
patch --batch --forward --fuzz=0 -p1 < /path/to/effect-preview/patches/0003-current-time-attributes.patch
patch --batch --forward --fuzz=0 -p1 < /path/to/effect-preview/patches/0004-atomic-resize-attributes.patch
```

To revise a contribution, edit its upstream patch, update the checksum in `series.json`, and regenerate. Once the
change lands upstream, refresh the pin and remove the corresponding patch and series entry.

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
bun run check:preview-compatibility
```

Replace `HEAD_SHA` and `BASE_SHA` with full 40-character commit hashes. Review the snapshot and generated diff together.
The import list covers the filesystem and prerequisite families from this PR. A new dependency or a prerequisite
that has merged upstream requires a generator review. If an upstream module is retired, remove its obsolete generated
file explicitly after reviewing the snapshot change; sync rejects unexpected files rather than deleting them.

Refresh does not promise that an arbitrary later PR revision works without adaptation. Keep engine fixes upstream
and local adaptations in the generator. After an Effect release includes the accepted APIs, switch the consumer's
imports, rerun the same qualification, and remove this temporary package.

Existing core adapters provide authenticated in-memory reference keys, snapshot codecs, reference paths, insertion order,
and scoped authority over the preview. The preview still lacks the public contracts needed for watches, durable volumes,
copy-on-write overlays, several atomic metadata operations, and masked-finalizer cleanup. Direct reproductions and the
unchanged acceptance results are tracked in [issue #328](https://github.com/lloydrichards/effect-virtual-fs/issues/328).
No replacement packages or reduced application flows are introduced.
