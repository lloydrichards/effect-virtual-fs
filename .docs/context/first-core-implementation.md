# First core implementation evidence

Status: completed locally, 9 September 2026, following the user's instruction to begin the private directory slice.
The package remains private at 0.0.0. This is evidence for the directory boundary, not the complete POSIX profile.

## Implemented boundary

The [module](../../packages/core/src/VirtualFileSystem.ts) implements independent volumes, callers with copied
credentials and umask, exact owned byte paths, directory lookup and exclusive creation, permissions, metadata,
entry/path limits, independently scoped callers and directory handles, and the optional CurrentFileSystem service.
See the [package README](../../packages/core/README.md) for usage and defaults.

Data models use Schema, expected errors use Data.TaggedError, and live capabilities use opaque interfaces.
Configuration validation reports a ConfigurationError field; filesystem failures report FsError codes.
The package emits JavaScript and declarations with root and VirtualFileSystem subpath exports.

Creation publishes namespace changes and related metadata together under volume coordination. Scope cleanup is
registered before a directory reference is retained, outside the volume permit. Registering it while holding the
permit would let an already closed scope synchronously invoke cleanup that waits for that same permit. The
implemented ordering avoids that deadlock and checks for closure before retaining a reference.

## Behavior evidence

All 27 cases in the [core suite](../../packages/core/test/VirtualFileSystem.test.ts) pass.
The following groups map the accepted contracts to observable cases; test names below are exact search targets.

| Contract                                                    | Representative test names                                                                                                                                                                                                                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Independent volumes and shared callers, decision 0020       | `shares a namespace between callers and isolates separate executions`                                                                                                                                                                                                  |
| Explicit authority and copied identity, decisions 0004/0020 | `checks owner permissions without falling through and keeps privilege explicit`; `uses supplementary groups captured separately on each caller execution`                                                                                                              |
| Independent resources and close, decisions 0011/0013/0016   | `keeps root and child callers alive after a parent derived scope closes`; `releases on scope exit and tolerates prior explicit close`                                                                                                                                  |
| Base identity and authority, decision 0017                  | `ignores unused absolute bases but rejects relevant foreign and closed bases`; `does not transfer opener privilege through a directory base`                                                                                                                           |
| Byte ownership and path policy, decisions 0012/0018/0020    | `retains exact byte names and owns each exported buffer`; `rejects shared and detached views while copying ordinary subarrays`; `preserves literal names and resolves dot components through existing directories`                                                     |
| Path limits, decisions 0019/0021                            | `applies optional byte limits at volume use before normalizing separators`; `uses byte component boundaries and accepts long paths when no total bound is configured`                                                                                                  |
| Metadata, permissions and capacity, decisions 0009/0020     | `captures the volume clock and publishes related timestamps together`; `requires parent write/search but not read, and checks inaccessible prefixes`; `serializes competing creates and quota accounting`                                                              |
| Cancellation and cleanup, decision 0020                     | `interruption releases acquired resources without rolling back committed directories`; `does not retain a directory or deadlock when the acquisition scope is already closed`; `coordinates scope closure with acquisition without returning a live escaped reference` |
| Optional service, decision 0002                             | `provides the same caller through the optional Effect service`                                                                                                                                                                                                         |

Additional cases cover malformed configuration and paths, missing parents, duplicate creation, quota-zero state,
independent handles, and observation racing explicit close. Coordination tests use explicit scopes/deferred signals
and bounded scheduler yielding. They are not exhaustive interruption-at-every-instruction evidence.

The first test entry point failed because the API was absent. That establishes missing API shape, not a reproduced
runtime defect. The final behavior assertions exercise public operations; no full mutation audit was performed.

## Executed checks

Environment: Bun 1.2.21 on PATH, Node 24.10.0, macOS arm64, Effect 4.0.0-rc.112.
The [manifest](../evidence/first-core/results.json) records exit codes and source/test/lock hashes. The linked
negative-consumer probe is retained because it demonstrates the intended type rejections; routine successful command
output is summarized here rather than archived.

| Command/check                                                                                           | Result                                                                                          |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                                                                         | Pass                                                                                            |
| `bun run format:check`                                                                                  | Pass                                                                                            |
| `bun run lint`                                                                                          | Pass                                                                                            |
| `bun run tsc --project .docs/contracts/tsconfig.json`                                                   | Pass, including real-core consumers                                                             |
| `bun .docs/contracts/models.check.mjs .docs/contracts/models.ts .docs/context/snapshot-format-draft.md` | Pass for proposed models; no core snapshot implementation implied                               |
| `bun run type-check`                                                                                    | Pass                                                                                            |
| `bun run test`                                                                                          | Pass: 27 core tests executed; 89 memory tests replayed from the passing baseline cache          |
| `bun run build`                                                                                         | Pass: core emits JavaScript/declarations; memory build checks replayed from cache               |
| Node imports of `@effect-vfs/core` and `@effect-vfs/core/VirtualFileSystem`                             | Both load and expose the same make; scoped mkdir/open/stat/close example passes                 |
| Actual consumer negatives with suppressions removed in a temporary copy                                 | Exactly four intended TypeScript failures; [log](../evidence/first-core/negative-consumers.log) |

The four negative consumers reject unscoped acquisition, raw Uint8Array paths, numeric directory bases, and caller.close.
They supplement the earlier ten prototype negatives. Turbo reports a missing coverage-output warning because tests
do not enable coverage. These results do not establish browser runtime support or an Ubuntu CI result.

## Next boundary

The narrower directory slice is complete. The broader volume/caller slice still needs cwd identity across rename
and shared regular-file content. Continue with the [I/O contract](posix-io-contract.md) and namespace operations,
keeping the [implementation plan](implementation-plan.md) and accepted decisions authoritative.

Regular files, symlinks/hard links, rename/removal, metadata mutation, directory enumeration, snapshots, fixtures,
and core-backed memory adaptation remain absent. The resolver retains trailing-separator information for future
file-kind checks. Symlink traversal/expansion bounds need executable cases when symlinks exist. No changes to the
memory dependency boundary are part of this slice.
