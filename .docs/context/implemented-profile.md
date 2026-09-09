# Implemented filesystem profile

Status: 9 September 2026. The accepted private implementation milestones are complete: core, memory adaptation,
fixtures/snapshots, standalone build/rebuild, bounded virtual package imports, and local validation. This is a
bounded project profile based on POSIX.1-2024 Issue 8, not full POSIX conformance or certification. The research
ledger remains useful for source provenance; this document states what the implementation actually supports.

The subsequent [implementation refactor](implementation-refactor.md) preserves this profile, fixes large-payload
snapshot validation, and records 180 passing tests plus lower measured snapshot RSS. [Decision 0023](../decisions/0023-adapter-timestamp-overflow.md) requires typed `InvalidData` from adapter stat when
a returned timestamp cannot fit JavaScript Date. The supported core timestamp domain itself is unchanged.

## Public surface

Core exports the `VirtualFileSystem` namespace and `@effect-vfs/core/VirtualFileSystem` subpath. Exact signatures
are in `packages/core/src/VirtualFileSystem.ts`; [package examples](../../packages/core/README.md) show composition.

| Owner                    | Implemented operations                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Constructors             | make, fromFixture, fromSnapshot, pathFromBytes, pathToBytes, encodeSnapshot, decodeSnapshot                                                                                                       |
| Volume                   | caller, snapshot, watch                                                                                                                                                                           |
| Caller                   | stat, lstat, access, open, readFile, writeFile, truncate, mkdir, rmdir, unlink, rename, link, symlink, chmod, chown, utimes, chmodHandle, chownHandle, utimesHandle, withDirectory, openDirectory |
| Byte/string observations | readDirectory/readDirectoryBytes, readLink/readLinkBytes, realPath/realPathBytes                                                                                                                  |
| File handle              | read, pread, write, pwrite, seek, truncate, stat, sync, close                                                                                                                                     |
| Directory handle         | stat, close; capability usable as a lookup base                                                                                                                                                   |
| Effect integration       | CurrentFileSystem optional service; MemoryFileSystem make, layer, bind                                                                                                                            |

Open accepts read/write/readWrite access; never/ifMissing/exclusive creation; writable-only append/truncate;
creation mode; and final-symlink follow policy. Seek accepts start/current/end/data/hole. No other native open flags
or descriptor operations are promised. Metadata variants can inspect/change final symlinks without following them.

## Decisions and limits

[Decisions 0001-0021](decisions.md) retain their accepted contracts. [Implementation policy 0022](../decisions/0022-remaining-implementation-profile.md)
resolves the remaining file, link, metadata, snapshot, and adapter choices under the continued implementation request.

- Privilege is explicit, independent of uid. Root callers default to privileged uid/gid zero, umask 0022; credentials
  and supplementary groups are copied at execution. New entries inherit parent gid. Memory uses umask zero and its
  existing creation defaults. Fresh memory volumes contain `/tmp`; bind leaves a supplied volume unchanged.
- Paths preserve bytes and traversal order. Root `..` clamps; repeated leading separators including `//` mean root.
  Components are at most 255 bytes, symlink traversal is at most 40, and maxPathBytes has no configured cap when omitted.
  Its configured bound counts raw input and exact link expansion. String outputs reject unrepresentable UTF-8.
- File offsets use bigint from zero through signed 64-bit maximum. Dense file storage has a 4,294,967,295-byte ceiling;
  maxFileBytes can lower it. maxBytes/maxEntries are optional safe-integer logical quotas, without configured caps by
  default. Root and implicit dots do not consume entry quota. File logical lengths, including gaps, and raw symlink
  targets are charged once per inode; unlinked-open files remain charged. No separately configured handle/inode quota.
- Handle writes may return the prefix that fits; zero progress fails. Whole-file writes and truncate preflight all
  growth. DATA sees dense content; HOLE sees EOF; both reject positions at/past EOF. No sparse allocation optimization.
- Independent scopes retain independent resources. Strict explicit repeat-close fails; scope cleanup is idempotent.
  Open-time file access survives chmod; metadata through a handle uses the invoking caller. Root callers need no scope.
- One volume coordinates mutations, observations, capture, and release. Expected atomic-operation failures precede
  publication. Interrupted waiting changes nothing; interruption after commit does not roll back. Recursive adapter
  helpers compose operations and are not transactions against other callers.
- Timestamps use captured Effect Clock epoch nanoseconds, without a physical nanosecond accuracy promise. Metadata
  fields are copied on return. Volatile sync checks liveness; it provides no host or crash durability.
- Watches deliver committed create/update/remove paths through a scoped unbounded buffer, with no replay or silent
  drops. Aliases receive updates. The adapter filters raw paths before strict string conversion.
- Snapshot v1 is strict JSON/base64 with image-local identity and bounded canonical numeric fields. Decode requires
  explicit encoded-byte, record, entry, and decoded-byte limits; restore also checks destination quotas. Snapshots
  own their content and each restore creates independent storage. Unreachable content, handles, caller state, and
  watch subscriptions are excluded. These limits bound logical input work, not exact heap consumption.

## Behavior evidence ledger

Rows inherit the source sections in the [research profile](posix-profile.md), refined by decisions 0020-0022.
The named tests are executable project examples, not exhaustive enumeration of all standard clauses/error overlaps.
All listed suites executed successfully in [review validation](../evidence/review-fixes/results.json). This evidence belongs
to the source in the commit containing this ledger; earlier slice logs retain their earlier revisions and outcomes.

| Requirements                | Selected behavior and representative executable evidence                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POSIX-P01–P04               | VirtualFileSystem.test.ts: “preserves literal names and resolves dot components through existing directories”; “uses byte component boundaries and accepts long paths when no total bound is configured”. Links.test.ts: relative links before dot-dot, exact expansion and loop bounds.                                                                                    |
| POSIX-P05–P06               | VirtualFileSystem.test.ts: exact byte names, owned subarrays, malformed/shared/detached inputs. Links.test.ts: “returns independently owned byte names and rejects lossy string results”.                                                                                                                                                                                   |
| POSIX-P07–P08               | Namespace.test.ts: cwd/base identity across moves, competing renames, failed replacement invariants. Snapshot.test.ts: “captures a complete serial namespace when rename races and enforces decoded budgets”.                                                                                                                                                               |
| POSIX-H01–H04               | File.test.ts: separate offsets, owned transfers, access/exclusive creation, kind failures, readonly truncate rejection, positional and zero I/O.                                                                                                                                                                                                                            |
| POSIX-H05–H06               | File.test.ts: “preserves offsets across truncate and positional I/O and fills gaps with zero”; dense data/hole, negative/overflow and unchanged failed offsets.                                                                                                                                                                                                             |
| POSIX-H07–H10               | File.test.ts: atomic competing appends, pwrite ignoring append, capacity-limited prefixes, failed growth preserving bytes and metadata. CoreBinding.test.ts adds atomic all-or-error whole-file quota rejection.                                                                                                                                                            |
| POSIX-H11                   | File.test.ts: unlinked charge until final close and closed-scope acquisition. VirtualFileSystem.test.ts: independent resource scopes, explicit repeat-close, acquisition/closure ordering and interruption.                                                                                                                                                                 |
| POSIX-N01–N02               | Namespace.test.ts: atomic replacement, incompatible/nonempty/cyclic destinations, root/dot/trailing separator failures. Links.test.ts: final-link rename/unlink and hard-link aliases.                                                                                                                                                                                      |
| POSIX-N04–N06               | Links.test.ts: shared identity, raw/dangling/empty link targets, own-link operations. File.test.ts: retained unlinked file. Namespace.test.ts: empty-only rmdir and removed-handle observation.                                                                                                                                                                             |
| POSIX-M01–M03               | Namespace.test.ts: link counts and timestamps; Links.test.ts: byte enumeration and follow/no-follow metadata; Metadata.test.ts: explicit/now/omit timestamps and unlinked handle authority. Enumeration is a coordinated whole list with no ordering or dot entries.                                                                                                        |
| POSIX-A01–A04               | VirtualFileSystem.test.ts: owner class, supplementary groups, independent privilege, parent search/write, controlled clock. Namespace.test.ts: sticky ownership. Metadata.test.ts: chmod/chown/set-ID rules and privileged execution.                                                                                                                                       |
| POSIX-E01–E02               | Core suites assert structured FsError distinctions and rejected-state preservation. Existing FileSystem.test.ts and MemoryFileSystem.test.ts pass through the core mapping. CoreBinding.test.ts covers InvalidData watch boundaries and BadResource quota failures. No native errno numbers or universal overlapping-error precedence.                                      |
| Ownership/modeling          | VirtualFileSystem.test.ts and Snapshot.test.ts cover execution-time bytes/options, return ownership, independent lifetimes and restore isolation. Actual-export compile consumers reject raw paths, numeric descriptors, unscoped handles, numeric offsets and unbounded decoding. Schema validates data, Data models typed failures, opaque interfaces model capabilities. |
| Snapshot/fixture acceptance | Snapshot.test.ts: six cases cover final-state forward aliases, metadata, independent capture/restores, invalid byte names, unlinked exclusion, hostile encoding/graphs, work budgets, destination limits and capture/rename ordering.                                                                                                                                       |
| Adapter acceptance          | All 89 original tests remain green; six CoreBinding.test.ts cases add shared volumes, direct-core watcher delivery, cursor/lifetime distinctions, quota failure, strict raw-path filtering and copy topology/times.                                                                                                                                                         |
| Consumer acceptance         | Three VirtualBuild.test.ts cases evaluate build/rebuild, virtual package import and externally persisted snapshot restoration, with missing dependencies failing. [Details](consumer-implementation.md).                                                                                                                                                                    |

Test files are under `packages/core/test`, `packages/memory/test`, and `apps/virtual-build/test`. The earlier research
proposals and prototype declarations are historical composition material. They do not override this supported surface.

## Validation and exclusions

Final commands include frozen install, formatting, lint, documentation contracts, executable models, types, forced
workspace tests and builds. The pre-review run executed 158 tests; the [review corrections](review-fixes.md) pass 177 tests, including regressions for the missed failures. Logs identify cached type/build
results. The browser-target build now executes a reachable filesystem smoke under Node after bundling: this caught
an undefined-export artifact from the earlier re-export-only fixture. It still does not establish browser/worker runtime
behavior. Package exports are also exercised by the Vite consumer, without core importing memory or host filesystem APIs.

Local tools: Bun 1.4.0, Node 24.10.0, macOS arm64, pinned Effect rc.112. Bun differs from the repository's 1.2.21 pin;
no dependency upgrade was made to accommodate it. Linux CI and the pinned Bun runtime were not executed in this run.
The dependency workload measurement is a single selected real-tree sample, not a heap bound or performance SLA.

Deferred: mounts, FUSE/Vim, network filesystems, overlays, host-tree import/export APIs, special files, advisory locks,
descriptor duplication, restricted roots, sparse/COW optimization, crash durability, arbitrary native tools, full Node
package resolution, installation and HMR. Core and memory remain private. The independent review identified and repaired additional correctness gaps after the first completion report;
see [review corrections](review-fixes.md). All accepted feature milestones remain implemented; publication readiness and broader standards/runtime certification remain separate.
