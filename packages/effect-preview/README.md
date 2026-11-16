# Evaluate the proposed Effect filesystem

This private package ports [Effect PR #9960](https://github.com/Effect-TS/effect/pull/9960) at
`161258278d6618bb5a10804827bb7a5f34b04c4d` and shares the installed Effect 4.1.4 runtime. Core uses the
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

### Local upstream contributions

`patches/series.json` lists ordered contribution patches and their SHA-256 hashes. The generator verifies them and
applies them with zero fuzz to a temporary upstream tree before adapting imports. The pinned snapshot and its
manifest remain unchanged. Generated-file checks cover the patched result.

| Patches   | Behavior under evaluation                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 0001–0002 | Preserve caller interruptibility during cleanup and resolve terminal dot components in recursive mkdir.                         |
| 0003–0004 | Apply current-time attributes and file resize in the same transaction as other metadata.                                        |
| 0005–0008 | Support opt-in relatime, create directories and files with exact timestamps, and preserve revisions on automatic atime updates. |
| 0009–0010 | Create zero-filled files at their initial size during open and update symlink mode without following the link.                  |
| 0011      | Publish file contents with a final mode and optionally replace the final symlink itself.                                        |
| 0012–0013 | Support special mode bits and safe-integer owner IDs. Preserve empty symlink payloads through copy and restore.                 |
| 0014–0015 | List entry identities with directory read permission and set initial file ownership during open.                                |
| 0016      | Describe the revised attribute, copy, open and write contracts in the public API documentation.                                 |
| 0017      | Allow a volume to inherit the parent directory’s group on creation.                                                             |
| 0018      | Specify which UID assignments an unprivileged file owner can make.                                                              |
| 0019      | Apply attributes to a retained file under the acting caller’s permissions and both parties’ confinement.                        |
| 0020      | Share private file bytes across restores of one preview Capture. Public record exports and stream imports keep owned copies.    |
| 0021      | Let core overlay restores reuse file bytes from a private snapshot through an internal capture constructor.                     |
| 0022      | Inspect directory entry names, kinds and identities with read permission, preserving directory atime.                           |
| 0023      | Let an async read report a pending automatic atime update before publication so core can wait for a cooperative capture.        |
| 0024      | Subscribe as the owner to ordered batches of committed mutations from async and synchronous operations.                         |
| 0025      | Generalize patch 0019 to retained directory handles. Orphan updates require unrestricted roots for both callers.                |
| 0026      | Reuse the resolved directory for each path component. Allocate an owned name only when inserting a new binding.                 |
| 0027      | Resolve linked directories directly for privileged volume-wide callers when only the directory object or containment is needed. |
| 0028      | Stage allocation and publication until a storage decision.                                                                      |
| 0029      | Offer durable changes and coordinate last-handle cleanup.                                                                       |
| 0030      | Wait for storage when acquiring an existing file handle.                                                                        |
| 0031      | Protect admission and cleanup installation from interruption.                                                                   |
| 0032      | Install storage and restore allocator state through a private owner capability.                                                 |

To try the same changes in an Effect checkout at the pinned commit, point `preview` at this package and apply
the files in manifest order. Run this command from the root of the Effect checkout.

```sh
preview=/absolute/path/to/effect-virtual-fs/packages/effect-preview
bun -e 'for (const entry of await Bun.file(process.argv[1]).json()) console.log(entry.file)' "$preview/patches/series.json" |
  while IFS= read -r name; do
    patch --batch --forward --fuzz=0 -p1 < "$preview/patches/$name" || exit 1
  done
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
bun run --cwd packages/core check:preview-imports
```

Replace `HEAD_SHA` and `BASE_SHA` with full 40-character commit hashes. Review the snapshot and generated diff together.
The import list covers the filesystem and prerequisite families from this PR. A new dependency or a prerequisite
that has merged upstream requires a generator review. If an upstream module is retired, remove its obsolete generated
file explicitly after reviewing the snapshot change; sync rejects unexpected files rather than deleting them.

Refresh does not promise that an arbitrary later PR revision works without adaptation. Keep engine fixes upstream
and local adaptations in the generator. After an Effect release includes the accepted APIs, switch the consumer's
imports, rerun the same qualification, and remove this temporary package.
