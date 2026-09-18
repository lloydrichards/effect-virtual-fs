# Bundle update log

## 2026-09-18

- **NFS compound interrupt boundary**: Resolved issue #93. `compound` ran its body inside `Effect.uninterruptible`, and the read loop calling it is forked into the server scope, so closing that scope interrupted the loop and awaited it; an operation stalled in the backing store held scope closure open indefinitely. The blanket region is now a mask and each operation is dispatched through `restore`. The lease sweep, the compound parse, the replay-cache hit path, and the replay-slot commit stay uninterruptible, so a compound is abandonable between operations but never torn in half; the existing `onInterrupt` rollback, unreachable until now, restores the slot's sequence ID, cached reply, and retained bytes so a retry is accepted as a first attempt rather than refused misordered. The rule this sets is that an operation may be abandoned between operations and anything mutating server state guards itself within its own; `CLOSE` masked only the handle close while the open-map deletion sat in a following `tap`, so an interrupt delivered at that boundary left a closed handle for the scope finalizer to close a second time, and the two are now one region. Shutdown is bounded except within a single operation's own uninterruptible region; a deadline on export calls is not part of this and stays open.

- **Snapshot-v1 schema**: Snapshot records intentionally use `_tag` as their variant discriminator; `kind` remains a semantic filesystem entry kind elsewhere. While version 1 is being solidified, persisted snapshots from earlier schema revisions may need regeneration after incompatible corrections; the persistence package stores snapshot bytes unchanged and does not migrate them. Timestamp spellings are checked before bigint conversion and accept at most 128 digits.

## 2026-09-17

- **Snapshot timestamp decoding**: Snapshot v1 now decodes timestamp strings into internal bigint values and bounds their spelling and numeric magnitude to 128 decimal digits. It accepts alternate spellings such as leading zeroes and `-0`, while emitted snapshots normalize them through `String(bigint)`. Fixtures, live metadata, overlay comparison, NFS-facing metadata, and snapshot-delta identity remain bigint-based.

- **Writable adapter and VFS capability boundary**: Resolved issue #46 with two decisions after a research pass over RFC 8881, the FUSE low-level API, the ganesha FSAL, Linux nfsd, Buildbarn, nfs4j, and durability vocabularies. `Caller` gains additive `(directoryReference, nameBytes)` mutation operations mirroring the path operations one to one, returning the new reference and the affected directory's revision before and after the change from one gate hold; `openReference` gains write access and `openChildReference` performs lookup-or-create-and-open atomically, with initial timestamps settable at create so an exclusive-create verifier fits the bigint-nanosecond fields. Share reservations and locks stay adapter-only with a documented boundary. `Volume` gains a `memory-only` durability tier, a random incarnation token reused for write and cookie verifiers, readable limits, and a live usage query; export writability, checkpoint scheduling, and identity mapping stay application composition. Moved the three `gap(#46)` attribute rows to `deferred(writable)` under #48 and pointed the profile ladder, deferred capabilities, and NFS research at the two decisions. No code changed.

- **NFS connection and lease lifecycle**: Resolved issues #69 and #70. The connection finalizer no longer takes the handler state gate: `Effect.ensuring` runs a finalizer uninterruptibly and `Semaphore.withPermits` waits through `restore`, so a finalizer that took the gate could not be interrupted out of the wait and was held for as long as another connection's compound ran. `disconnect` never needed the gate, because its body is one synchronous mutation whose effects are already tolerated at a compound's yield points. Expired leases are now swept on a half-lease schedule forked into the handler scope as well as before each compound, so an abandoned client's opens and retained replay bytes no longer stay charged until the scope closes; retained bytes come from a global budget, so enough abandoned sessions would have refused replay caching to healthy clients. `disconnect` still does not touch lease state, since Section 18.37.3 ties the lease to the client ID. A compound that stalls in the backing store still delays its own connection's shutdown because `compound` runs uninterruptibly; that path is tracked separately under #93.

- **Reference operation authority**: Resolved issue #76. `observeMetadata` and `readLinkReference` check nothing on the referenced object by design, matching POSIX `stat` and `readlink` and the path-based `stat`, `lstat`, and `readLink`: the path prefix is authorized when the reference is obtained, and an unreadable metadata read would hide a mode `0o000` entry from `ls -l` in a readable directory. Recorded the per-operation rule in the object-references and permissions contracts, corrected the #45 decision line that described the omission as a gap, and covered both operations with a non-privileged caller against a mode `0o000` file and symbolic link. No behaviour changed. The `AccessDenied` split into `NFS4ERR_ACCESS` and `NFS4ERR_PERM` is deferred to the writable profile under #77.

- **Snapshot delta identity goldens**: Pinned a second golden digest over a populated fixture that reaches every element of the semantic identity encoding, since the existing empty-snapshot digest covered almost none of it and the semantic-mutation table regenerates both sides with the current encoder and so cannot detect wire drift. Confirmed the same fixture hashes identically before and after the delta audit refactor, and recorded in the contract that a deliberate encoding change must bump the algorithm identifier rather than regenerate a digest alone.

- **Snapshot delta entry order**: Applying a delta now orders directory entries by raw name bytes instead of `localeCompare`, so ICU and non-ICU Node builds reconstruct the same order from the same delta. The comparator sorts the basename bytes it already holds rather than decoding base64 on every comparison. Recorded the applied-order guarantee in the snapshot-deltas contract and covered it with an unsorted apply assertion.

- **Deferred adapter contract coverage resolved**: Resolved issue #40. Replaced the seven deferred follow-ups in the shared adapter suite with unconditional assertions and recorded the decisions behind them. The portable contract now requires `BadResource` from a handle used after its scope closes, `AlreadyExists` from `copy` with `overwrite: false`, `utimes` as the failing method name, both timestamps under `preserveTimestamps`, and unprivileged `chmod` and `chown`. Added deterministic interruption coverage for derived stream and sink handles by signalling handle acquisition through a `Deferred`, plus watcher readiness and sentinel-based cleanup coverage. Measured Effect's Node platform adapter against the tightened suite: it diverges on four requirements and needs privileges for ownership, so the suite stays memory-only and the divergences are recorded in the contract rather than tolerated by the assertions. Running the same suite under the Bun runtime remains open; `BunFileSystem.layer` re-exports `NodeFileSystem.layer`, so it would test the runtime rather than a second adapter. No public behaviour changed.

## 2026-09-16

- **Domain subdirectories**: Nested the two crowded directories by domain. Decisions moved into `decisions/core/`, `decisions/overlay/`, and `decisions/nfs/`; the NFS research and profiles moved into `research/nfs/` and `profiles/nfs/`. Package, adapter, persistence, and build decisions stay flat because each domain has fewer than three concepts. Every link and relative source path was rewritten, the three section indexes were regrouped, and the NFS package README was re-pointed. No concept content changed.

- **Watch event overflow drafted**: Recorded that the watch hub's unbounded `PubSub` grows without limit whenever a subscriber reads slower than the mutation rate, that `publishUnsafe` bypasses the PubSub strategy so bounding alone only converts growth into silent loss, and that comparable filesystem APIs that can drop events (inotify, ReadDirectoryChangesW, FSEvents) signal it with a rescan contract, while kqueue avoids overflow structurally by coalescing per vnode and Node signals nothing. Left the marker carrier, adapter behaviour, per-subscriber accounting and capacity open.

- **Bundle spring cleaning**: Audited every concept against code and CI. Moved the implemented object-reference and mutation-revision contracts from `research/` to `contracts/`; trimmed the two overlay research drafts to their open questions and marked them stable; normalised types to Contract, Decision, Architecture, Implementation Profile, Project Profile, Research Report, Reference, Evidence, and Workflow; grounded the 24 early decisions with sources and deprecated the two grab-bag decisions in favour of the focused contracts; added the NFS package to the dependency model, system boundaries, project overview, implemented profile, and validation evidence; corrected the CI sequence and the four-package Changesets group in both workflows; cross-linked overlay capture with the snapshot delta contract; repaired footnotes; added the missing test sources; and recorded the Linux mount-gate run in the preview app's conformance baseline.

- **NFS authentication and export policy**: Resolved issue #45. Kerberos and RPCSEC_GSS are a permanently unmet MUST, so no profile claims conformance; RPCSEC_GSS credentials now answer `AUTH_TOOWEAK`; `read-only-networked` is specified as a trusted-network profile whose application-supplied policy maps `AUTH_SYS` identity and peer address to VFS identities that the server mints callers for, with non-loopback binding behind that policy and an explicit opt-in; ACCESS is documented as advisory in `read-only-local`; owner strings stay numeric; UNIX-domain sockets count as local addresses; the `SP4_MACH_CRED` row became a rejection by design. Added the decision and networked profile, updated the ladder, local profile, deferred capabilities, three ledgers, and the package README; opened #74, #75, #76, #77.

- **NFS connection binding and backchannels**: Sessions now record which connections carry which channel, `DESTROY_SESSION` enforces that association, and the server sends CB_COMPOUND callbacks using the credential the client authorized in `csa_sec_parms`. Backchannels, connection binding, and trunking moved from `read-only-networked` into `read-only-local`, leaving Kerberos as that ladder's only unmet MUST. The operations and protocol-rules ledgers, the profile, and the package README were updated together.

## 2026-09-15

- **NFS Section 15.2 audit**: Corrected error codes and compound rules that neither pynfs nor the native client exercised: OPEN share reservations with `SHARE_DENIED` instead of `OPENMODE`, `NO_GRACE` and `BAD_STATEID` for unsupported claims, `SYMLINK` and `WRONG_TYPE` for OPEN, READ, and COMMIT on non-regular objects, `NOTDIR` for CREATE, REMOVE, RENAME, and SECINFO_NO_NAME, current and saved stateids travelling with filehandles, per-operation `BADXDR`, `BADCHAR` for slash and NUL, `FSCHARSET_CAP4_ALLOWS_ONLY_UTF8`, state protection rejected as Linux nfsd does, CREATE_SESSION slot consumption on failure, BIND_CONN_TO_SESSION and BACKCHANNEL_CTL decoded and answered instead of OP_ILLEGAL, `LOCKED` for anonymous READ against a deny-read reservation, a misplaced SEQUENCE judged in place, OPEN4_CREATE validated before `ROFS`, `WRONG_TYPE` for READLINK, filehandles registered only when the `filehandle` attribute is requested, `TOO_MANY_OPS` judged from the compound header count, LOCKT read-lock types answering NFS4_OK, OPEN_DOWNGRADE masking delegation-want bits, CREATE_SESSION renewing the lease and refusing channels below two operations or with RPCSEC_GSS callback parameters, `maxfilesize` withdrawn from the advertised attributes to gap #46, and the pynfs classification arithmetic corrected (61 read-only exclusions, no re-run); the preview mount instructions drop the client-side `ro` so the server's `ROFS` is what a native client exercises. Updated the three ledgers.

- **NFS read-only protocol completion**: Implemented the remaining REQUIRED operations for the read-only-local profile, NOTSUPP for must-not-implement and optional operations, RFC 8881 Section 18.35.4 client-record cases with principals, CREATE_SESSION guards, ACCESS from mode bits, per-entry rdattr_error, and seven more attributes; removed the undefined `NFS4ERR_RESOURCE`; recorded the pinned pynfs baseline as evidence and updated the three ledgers and the profile.

- **NFS profile ladder and coverage ledgers**: Accepted the two-axis model of capability profiles (read-only-local, read-only-networked, writable, stateful) and maturity labels (experimental, preview, stable) with an evidence ladder; added the read-only-local profile and three ledgers mapping RFC 8881 operations, attributes, cross-cutting rules, errata, and clients to current status; recorded the undefined `NFS4ERR_RESOURCE` code as a gap; pointed deferred capabilities and the NFS research at the ladder.

## 2026-09-13

- **NFS negotiated reply sizing**: Replaced worst-case reply rejection with minimum preflight bounds and encoded-size enforcement, allowing macOS compounds whose actual replies fit the negotiated channel.

- **Platform-neutral NFS transport**: Changed NFS to require Effect's `SocketServer` service so applications choose the Bun, Node, or another platform implementation and binding, while NFS still rejects non-loopback addresses.

- **Virtual filesystem module boundary**: Kept the documented capability API in the public facade while separating runtime models, path handling, the coordinated live-volume engine, and fixture construction into cohesive internal modules.

- **Opaque snapshot TypeIds**: Aligned Snapshot and SnapshotDelta with Effect-style string TypeIds and moved snapshot-delta representation state behind the internal implementation seam.

- **Atomic watch registration**: Coordinated subscriber activation with volume mutations so committed events cannot be dropped while a watch is registering.

- **Byte path value semantics**: Defined opaque `BytePath` equality and hashing by its ordered bytes and added Effect-style pipe composition without exposing its representation.

- **Effect file-handle input compatibility**: Aligned negative-seek cursor preservation and required `readAlloc` runtime validation with the installed Effect `FileSystem` contract while retaining zero-default truncation.

- **NFS review corrections**: Grounded the macOS interoperability summary in issue #39 and the protocol claims in focused tests; removed the unsupported packet-trace claim.

- **Standalone NFS preview app**: Moved the runnable fixture out of the library package into a private workspace app with macOS mount, verification, troubleshooting, and cleanup instructions.

- **NFS configuration defaults**: Added frozen finite resource presets and optional server and limit overrides while retaining a complete validated runtime policy.

- **NFS schema-owned configuration**: Replaced the public interface-only limit model with Effect schemas, explicit `ByteSize` budgets, and a one-way public-to-internal normalization boundary.

- **NFS adversarial hardening**: Corrected client-incarnation recovery, negotiated channel enforcement, slot replay accounting, stateid and READDIR wire forms, session teardown, compound interruption atomicity, decode-error boundaries, and open-handle ownership; added an explicit pending-replacement limit and focused behavioral coverage.

- **Native macOS NFS evidence**: Verified mount, listing, reads, symlink traversal, hard-link identity, live VFS mutation refresh, read-only rejection, restart remount, and clean unmount; retained the privileged Linux-client gate.

- **Experimental NFS preview**: Accepted and implemented the private localhost-only read-only package boundary, core object-observation primitives, bounded RPC/XDR transport, volatile NFSv4.1 sessions and filehandles, browse/read operations, scoped server API, and runnable example. Retained the incomplete real-client browse/read gate and full RFC conformance exclusions.

- **Live object identity and revisions**: Implemented canonical volume-local object references, deletion lifetime, caller-authorized reference operations, runtime mutation revisions, and coherent owned directory observations while keeping snapshot version 1 unchanged.

## 2026-09-12

- **Effect-native snapshot limits**: Changed encoded and decoded snapshot work budgets to exact `ByteSize.ByteSize` values and kept persistence comparisons exact through SQLite.

- **Effect-native volume limits**: Changed volume, file, and path byte limits to exact `ByteSize.ByteSize` values while retaining numeric entry limits and the uint32 dense-file ceiling.

- **Effect RC 114 ByteSize adoption**: Updated the memory adapter to Effect's branded file metadata sizes and bigint seek contract, and changed snapshot-delta byte budgets to `ByteSize.ByteSize` while keeping record counts numeric.

- **Effect-native snapshot identity**: Replaced the internal SHA-256 implementation with the platform-neutral `Crypto.Crypto` service and added an explicit canonical-identity byte limit.

- **Portable snapshot deltas implemented**: Added exact base-dependent reconstruction, base-verified path inspection, an Effect Schema byte codec, canonical semantic SHA-256 identity, same-path inherited payloads, strict hostile-input validation, shared finite limits across every operation, and focused behavior evidence.

- **Portable snapshot delta interface**: Accepted an opaque exact delta with Schema encoding, path-oriented inspection, canonical semantic base identity, a dedicated base-mismatch error and shared finite resource policies. Kept wire layout and measured preset values as implementation research.

## 2026-09-10

- **Overlay parity evidence**: Recast the research scenario table as a broader parity matrix and distinguished representative executed overlay coverage from remaining cases.

- **Overlay API semantics**: Clarified reusable Effect execution, typed configuration and image failures, and the in-process scope of summary schemas containing opaque byte paths.

- **Overlay v1 implementation**: Added the snapshot-based overlay workspace contract, shared whole-file copy-on-write behavior, identity-based final summaries, paired complete capture, adapter and checkpoint evidence, and explicit remaining exclusions.

- **Overlay design consolidation**: Added issue #8 research and four accepted decision concepts covering v1 scope, base ownership, content sharing and final-difference capture. Consolidated repeated policy, separated deferred delta research, and identified remaining planning cases through independent agent reviews. Overlay implementation remains pending.

- **Checkpoint provenance**: Grounded the stable persistence decision and validation claim in the design issue, implementation, behavior tests, and separate-process restart test.

- **NFS draft concepts**: Added object-reference and mutation-revision proposals, connected them to existing contracts, and grounded the NFS direction in current implementation sources and issue discussion. Removed the claim that historical probes remain in the checkout.

- **Phase 2 provenance**: Removed legacy `.docs` resources from concept metadata. Current claims now resolve to maintained code, tests, package manifests, CI configuration, standards, or the concepts themselves.
- **Initialization**: Migrated durable project knowledge from `.docs` into an OKF v0.2 bundle while retaining `.docs` for comparison during Stage 1.
