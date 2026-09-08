# Snapshots, fixtures, capacity, and build acceptance

Research checked 8 September 2026. This is a planning document, not an implemented API or an approved format.
The [design proposal](../design/VirtualFileSystem-design.md) and [accepted decisions](decisions.md) define scope.
Remaining recommendations below need contracts before implementation.

## What already exists

- [`packages/core/src/index.ts`](../../packages/core/src/index.ts) exports no backend implementation.
- [`memoryFileSystem.ts`](../../packages/memory/src/internal/memoryFileSystem.ts) separates directory entries from file identity through `DirectoryInode.entries` and `State.inodes`.
- `FileInode.data` is a `Uint8Array`. `writeDescriptorUnlocked` reuses that array when a write does not grow the file, then calls `data.set(buffer, position)`.
- Consequently, retaining an old `State` or inode object would not create an isolated snapshot. Persistent maps do not make their byte arrays immutable.
- `State.descriptors`, `InodeMetadata.openCount`, and `Volume.watchers` represent live runtime state. They must not become accidental snapshot fields.
- Directory names and symlink targets are strings today. The proposed byte-preserving backend needs a different persistent representation.
- There is no current fixture, snapshot, codec, or virtual-build implementation to validate. Historical research is not executable evidence for these features.

## Requirements already in scope

Capture a consistent namespace and copy its file bytes. Later writes, renames, and deletions must not change the captured state.
Loading the same snapshot twice creates independent volumes.
The image preserves names, file contents, hard-link relationships, raw symlink targets, ownership, modes, and supported timestamps.
Dangling symlinks are valid persistent state.
Open handles, offsets, watchers, locks, caller contexts, and unlinked files kept alive only by handles are excluded.
Load constructs a fresh volume and validates it before exposure. It never replaces a running volume.

Encoding is portable and versioned from its first release. Storage I/O belongs to a caller-selected service outside core.
Saving encoded data does not promise crash durability or atomic host replacement.
Copy-on-write storage and ordinary host-directory import/export remain deferred.

## Byte ownership needs an explicit contract

Recommendation: keep snapshot storage opaque, and copy mutable byte arrays at public ownership boundaries.
TypeScript `readonly` alone does not stop a consumer from changing an exposed `Uint8Array`.
Do not expose inode maps as the snapshot API, even if their types are readonly.

| Boundary                          | Recommended rule                                                        | Evidence to require                                                          |
| --------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Fixture input to volume           | Copy accepted file/name/target bytes before publication.                | Mutating input arrays after creation leaves the volume unchanged.            |
| Volume to snapshot                | Copy each reachable file's bytes once while capture excludes mutations. | Same-length overwrite after capture cannot change the snapshot.              |
| Snapshot inspection               | Return copies of any bytes returned to callers.                         | Mutating inspection output cannot change later encoding or loads.            |
| Snapshot to encoded bytes         | Return caller-owned bytes.                                              | Mutating encoded output cannot change the snapshot.                          |
| Encoded input to decoded snapshot | Do not retain caller-mutable storage.                                   | Mutating input after decode cannot change the decoded snapshot.              |
| Snapshot to loaded volume         | Copy storage for each load.                                             | Writes through either loaded volume cannot affect the other or the snapshot. |

The API also needs to define when it consumes mutable inputs to lazy Effects.
Recommendation: consume and copy them when the Effect executes, and require callers to keep them stable until completion.
Concurrent mutation through shared backing memory needs an explicit exclusion or stronger copying contract.
This decision also belongs in the general read/write API contract.

Capture should hold the volume's mutation permit through the complete namespace-and-byte copy.
Encoding can run after releasing the permit because the captured state is independent.
Test a concurrent rename as either complete pre-rename state or complete post-rename state; no mixed directory records are allowed.
Allocation failure or interruption during capture must leave the live volume untouched and expose no partial snapshot.
This recommendation accepts the design's writer-delay cost; no performance result has been measured.

## Persistent model and validation

Recommendation: use a root reference, a table of file/directory/symlink records, and directory entries containing raw name bytes plus record references.
Accepted [decision 0005](../decisions/0005-snapshot-local-identity.md) gives records snapshot-local identifiers.
Preserve hard-link identity through repeated references to the same record. Runtime inode numbers need not survive restoration.
This allows restore to allocate new internal identifiers while keeping aliases correct.

Validation should complete in stages before constructing the public volume:

1. Check encoded input length against a separate decoder limit before parsing.
2. Check envelope, format identifier, supported version, field types, and numeric ranges.
3. Validate byte encodings and record kinds, rejecting duplicate record identifiers.
4. Validate directory entry names and duplicate names using byte equality, without lossy text decoding.
5. Resolve references, require a directory root, and reject missing targets.
6. Validate directory topology: no cycles or multiple directory parents under the selected profile.
7. Require every persistent record to be reachable from the root. Symlinks do not establish reachability edges to their targets.
8. Derive link counts from validated topology according to the selected filesystem profile. Reject inconsistent stored counts if the format includes them.
9. Validate metadata and calculate resource totals with checked arithmetic against destination limits.
10. Create private storage, then expose a fresh volume only after all validation succeeds.

The name validator must share the backend's eventual component rules, including forbidden separator/NUL bytes and reserved dot entries.
Store directory entries as an array of records rather than object properties so distinct byte names and duplicate detection remain explicit.
Do not resolve symlink targets during load: missing targets and symlink loops can exist without making the image invalid.
Deep images need iterative traversal or an explicit depth limit so input depth cannot consume the JavaScript call stack.

Decoder limits and filesystem capacity solve different problems.
An encoded image can have small file content but excessive metadata, nesting, or invalid references.
Set limits for encoded size, record/entry counts, name/target lengths, and traversal work before large allocations where possible.
These are defensive parser controls, not a claim to bound JavaScript heap usage.

## Encoding choices

See the [fixture and encoded image example](snapshot-format-draft.md) for a concrete proposed record layout.
The example's schema and metadata defaults remain proposals even though JSON/base64 itself is accepted.

| Option                             | Benefit                                                            | Cost or constraint                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| UTF-8 JSON plus base64 byte fields | Inspectable, easy to produce in browsers, small dependency burden. | Base64 expands content; parsing normally retains the complete text and object graph.                          |
| CBOR with a restricted profile     | Native byte strings and integer types; avoids base64 expansion.    | Adds a codec and requires explicit rules for allowed tags, lengths, duplicate keys, and deterministic output. |
| Custom binary framing              | Full control of layout and bounded parsing.                        | More format and parser code to review; no current requirement justifies it.                                   |

JSON defines strings, numbers, arrays, and objects, without a native binary type. RFC 8259 also describes interoperable exact-integer limits around JavaScript's safe-integer range. This supports explicit byte and large-integer encodings rather than implicit typed-array serialization. [RFC 8259, sections 3–6](https://www.rfc-editor.org/rfc/rfc8259.html#section-3)

Base64 represents three bytes with four characters, with padding rules for shorter final groups. A format should choose one alphabet and reject invalid encodings consistently. [RFC 4648, sections 3–4](https://www.rfc-editor.org/rfc/rfc4648.html#section-3)

CBOR distinguishes byte strings from text strings and defines deterministic encoding rules, but a filesystem still needs its own schema and reference validation. Generic CBOR decoding cannot establish valid filesystem topology. [RFC 8949, sections 3 and 4.2](https://www.rfc-editor.org/rfc/rfc8949.html#section-3)

Accepted: [decision 0006](../decisions/0006-json-base64-snapshots.md) selects JSON/base64 for the initial format.
Canonical padded base64 remains the recommended spelling pending the exact codec contract.
Measure dependency-heavy Vite-sized project trees, including many small `node_modules` files; gigabyte-scale content
is not the user's expected workload. This guidance does not establish a numeric capacity limit or expand build acceptance.
Use explicit decimal strings for values that may exceed safe integer precision; first settle timestamp precision and integer ranges in the backend contract.
Keep the logical snapshot schema independent of the chosen wire representation.
Version the format separately from the package version; reject unsupported versions with a typed decoding error.
Initially promise the current format only. Add migrations deliberately with retained fixtures for older versions.
Deterministic encoding is useful for reviewing fixture changes, but do not promise content-addressed storage or stable hashes yet.
If deterministic output is adopted, specify record traversal, byte-name ordering, field ordering, and numeric/base64 spelling.

## Fixtures should describe final state

Accepted: [decision 0008](../decisions/0008-final-state-fixtures.md) makes fixtures declarations of a fresh final state
with predictable metadata defaults and complete validation before exposure. The proposed syntax includes explicit
directory, file, symlink, and hard-link declarations; exact representation remains open.
They are not a sequence of privileged filesystem commands whose declaration order changes the result.
Resolve hard-link references after collecting declarations so forward references are unambiguous.
Reject collisions and invalid topology before publishing a volume.
Reuse the snapshot topology/metadata validator where the rules match, without forcing convenient fixtures to expose the wire format.

Fixtures need string conveniences and a byte-name escape hatch. Hard links should reference explicit fixture identity or a clearly defined target path.
Define whether parent directories must be declared; recommendation: require them in the low-level fixture representation and make automatic parents an optional builder convenience later.
Do not follow symlinks while constructing the declared tree.
Recommendation: fixture metadata describes the resulting values directly, without applying caller umask a second time.
Use documented fixed default metadata and timestamps for reproducible tests; normal filesystem operations still use the caller's clock and umask.
The exact defaults remain a decision. They must not come from host credentials or host time implicitly.

## Capacity accounting proposal

Accepted accounting is recorded in [decision 0009](../decisions/0009-volume-capacity-accounting.md): separate
per-inode file-content bytes and per-name entries, retained charges for unlinked-open content, and snapshot/encoding
memory outside the live-volume quota. Numeric limits remain open. The detailed rules below extend that model with
recommendations, including gap and symlink accounting; they are not all accepted decisions or POSIX requirements.

- Charge logical regular-file length once per inode, including zero-filled gaps. Hard-link aliases add no content-byte charge.
- Charge raw symlink target bytes once per symlink inode; define name/metadata limits separately.
- Charge namespace entries per directory name, so each hard-link alias consumes an entry. Exclude implicit dot entries and document root treatment.
- Keep unlinked-open file bytes charged until the final handle closes, since that content still occupies live volume storage.
- Capture includes only reachable persistent records, so its restored volume may consume less capacity than the live source.
- Treat snapshot copy/encoding memory separately from volume capacity. A logical capacity limit cannot guarantee capture allocation success.
- Let restore accept destination limits and recompute usage. Do not silently raise caller-selected limits based on image data.
- Check changes against current usage at commit. Failed namespace operations must not leak reserved capacity.

An entry limit alone does not bound empty unlinked-open inodes or handle count. Decide whether a separate inode/handle limit is needed in the first profile.
Choose finite defaults from representative workloads and explicit product needs; this research does not invent numeric defaults.
I/O partial-write behavior under capacity exhaustion must follow the selected operation profile. Settle it before choosing preflight-allocation behavior.

## Bounded virtual-build acceptance

The design requires an entry and relative dependency in one standalone volume, an initial bundle, a dependency edit, and changed rebuilt output.
No production plugin package, host mounts, virtual package manager, or automatic watch/HMR integration is required.

Vite documents virtual modules implemented through `resolveId` and `load`, including an internal `\0` prefix. Its development and build hook lifecycles differ, so a successful build does not establish dev-server behavior. [Vite plugin API](https://vite.dev/guide/api-plugin)

Rolldown documents the same virtual-module pattern. That supports a small test-local plugin rather than adding an adapter package merely for the acceptance case. [Rolldown plugin API](https://rolldown.rs/apis/plugin-api)

Vite exposes a programmatic `build` entry point with inline configuration. [Vite JavaScript API](https://vite.dev/guide/api-javascript)
Its `build.write: false` option disables bundle output to disk. [Vite build options](https://vite.dev/config/build-options#build-write)

Recommended acceptance sequence:

1. Pin the integration's tool versions when adding the test. Verify installed types against the official hooks before implementation.
2. Create `/src/main.js` importing `./value.js`; the dependency exports a small observable value.
3. Give the plugin an explicit virtual entry ID, preserve the importer's volume path, and resolve relative imports through the public backend.
4. Restrict the test module names to representable strings; byte-name round-trips belong in separate backend tests.
5. Configure programmatic Vite build with inline options, disabled config-file discovery, an explicit JavaScript entry, and `build.write: false`.
6. Read sources only through public core operations. Decode JavaScript source bytes explicitly and report missing owned virtual modules as failures rather than falling back to host resolution.
7. Assert the generated program's observable exported result, not just that output text exists.
8. Modify only `/src/value.js` through the same live volume, run a second build, and assert the new result and changed output.
9. Remove the dependency and assert a useful resolution/load failure identifying the virtual path.

Accepted: [decision 0010](../decisions/0010-explicit-build-rebuilds.md) defines rebuild as a second explicit build call.
Automatic invalidation, watch scheduling, and retained bundler caches are follow-up integration contracts.
Prevent source staging by using names with no corresponding host files and instrumenting the plugin's backend reads.
The bundler may still access its own installation or configuration infrastructure. The acceptance claim concerns virtual source modules.
Return build artifacts in memory to simplify assertions; this does not add output-filesystem virtualization to core's requirements.
The proposed test has not been run. Hook feasibility from documentation is not end-to-end evidence.

### Second acceptance milestone

[Decision 0007](../decisions/0007-virtual-package-acceptance.md) adds a package-name import resolved from a package
already stored in virtual `node_modules`, after the basic relative-dependency case. Specify the manifest fields and
module format before selecting the integration approach. Prove the chosen package is loaded through core without
source staging or host-package fallback. This does not require package installation or complete Node resolution.
Whether this milestone gates the first core release remains open.

## Decisions to take into the discussion

Wire encoding and identity policy are settled by decisions 0006 and 0005. Remaining choices include exact codec rules,
exact fixture defaults, timestamp precision, detailed capacity rules and defaults, and decoder limits.
Decisions 0008, 0009, and 0010 settle final-state fixture construction, the basic capacity model, and explicit rebuilds.
Destination-controlled restore limits remain a recommendation.
All decisions should receive short records before public API implementation so future agents can distinguish a researched option from an accepted contract.
