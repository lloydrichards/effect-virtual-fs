---
type: Architecture
title: Volume, caller, and handle model
description: Assigns shared filesystem state to a volume, authority and lookup context to callers, and cursor and lifetime state to scoped handles.
status: stable
tags: [architecture, state, authority, resources]
sources:
  - resource: ../../packages/core/test/Execution.test.ts
    title: Execution policy and resource lifecycle regressions
  - id: core-source
    resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Core public contracts
  - id: volume-engine
    resource: ../../packages/core/src/internal/engine.ts
    title: Single shared private filesystem engine
  - resource: ../../packages/core/compatibility/engine-imports/check.mjs
    title: Runtime import boundary qualification
  - resource: ../../packages/core/test/Engine.test.ts
    title: Private engine ownership and failure regressions
  - resource: ../../packages/core/contracts/EngineOwnership.ts
    title: Previous public capability shapes and engine operation compatibility
  - resource: ../../packages/core/src/internal/bytePath.ts
    title: Retained community BytePath value implementation
  - resource: ../../packages/core/src/internal/bytes.ts
    title: BytePath byte equality and community codec utilities
  - resource: ../../packages/core/src/Metadata.ts
    title: Community metadata schemas
  - resource: ../../packages/core/src/FileHandle.ts
    title: Community handle brands and seek modes
  - resource: ../../packages/core/src/VfsError.ts
    title: Shared community error schema
  - id: resolution
    resource: ../../packages/core/src/internal/engine.ts
    title: Tagged target and entry resolution
  - id: tokens
    resource: ../../packages/core/src/internal/engine.ts
    title: Opaque token validation and scoped handle lifecycle
  - id: resolution-tests
    resource: ../../packages/core/test/Engine.test.ts
    title: Direct resolution and error-order tests
  - id: token-tests
    resource: ../../packages/core/test/Engine.test.ts
    title: Direct token liveness and lifecycle tests
generated: { by: codex/okf, at: "2026-10-22T11:28:22+02:00" }
---

# Volume, caller, and handle model

A `Volume` is one isolated, live filesystem. It owns the namespace, file identity, content, metadata, capacity accounting, mutation coordination, change observation, and snapshot capture. Consumers sharing a volume observe the same committed state.

A `Caller` carries independent credentials, supplementary groups, umask, and current-directory identity. Directory identity survives rename. Deriving or binding another caller does not share mutable caller context, and authority is explicit rather than inherited from the host process.

A `FileHandle` is a scoped capability tied to one volume and open file. It owns its access mode, bigint cursor, and lifetime. Separate opens have independent cursors. A `DirectoryHandle` is a scoped directory capability used for metadata and as a relative lookup base. Unrestricted open files may remain usable after rename or unlink until their final handle closes. Confined handles require current in-root membership.

Explicit close reports a repeated-close error, while scope cleanup is idempotent. The capability's reusable `stat`, `sync`, and `close` effects observe current state each time; volume `watch` and `snapshot` effects also acquire or observe fresh state on execution.

The public module owns the documented capability contracts. One private `engine.ts` owns state, directory slots, draft installation, permission checks, resolution, confinement, token registries, handles and operations. Community construction and the private minimal candidate use this same implementation. The engine keeps each mutation in one coordinated state transition. Its `Resolution` namespace reads through the engine's draft-aware node getter and the caller's identity. `Node`, `Parent`, and `OrCreate` modes return tagged results, retain path diagnostics, and preserve search permission and symlink check order. Recursive directory creation uses an engine callback in the same transition.[^resolution]

The engine’s `TokenRegistry` namespace owns the shared WeakMaps, reference interning, and handle lifecycle. Token resolution reports `unknown`, `foreign`, `stale`, or `live`. An absent inode or an unlinked directory makes an object reference stale; an unlinked file retained by an existing handle remains observable. Watch registration, reopening, relinking, and traversal apply their own named-object requirements after token resolution. Directory handles may observe a retained detached directory, while relative lookup from it fails `NotFound`. A file handle supplied as a directory base remains invalid.[^tokens]

Handle lifecycle is `acquiring`, `open`, `releasedPendingCommit`, or `closed`. Cleanup during acquisition records the release request before publication; if a commit publishes later, it records the retained inode for a finalizer rerun rather than opening the handle. The registry owns scope acquisition, finalization and one release operation. Engine callbacks retain and release inodes, reclaim content, and publish handle changes at the appropriate installation point. A staged explicit file close leaves its handle usable until installation; local directory cleanup disables the handle before reclamation, even if storage rejects that cleanup.[^tokens]

Community assembly in `internal/virtualFileSystem.ts` retains random identities, authenticated references, snapshot/image restoration, overlay observation and watch hubs. The engine emits private installation facts to that assembly and uses one private commit hook for durable installation. Memory installation uses the same path without storage. Minimal construction allocates no watch hub and requires no Crypto service. Its private limits exclude the community watch budget. Community watch path reconstruction reuses the engine’s private state helpers. Public constructors retain their existing requirements and defaults.

Keep engine mechanics in this one file. Filesystem path preparation, error construction, the FIFO coordination gate and private test hooks live beside resolution, state and handles. The forwarding modules are removed; callers import the engine directly. Image/codec-specific diagnostics remain community-owned in `errors.ts`, and tree assembly/restoration remains in `volumeState.ts`; those modules no longer re-export engine helpers. Cooperative mode retains that gate. Sync mode allocates no waiting gate or turnstile and holds one non-waiting ownership guard through installation and deferred releases.

## Live execution policy

VolumeOptions.execution is cooperative by default and accepts sync for constructor-owned memory backends. The policy is not serialized. Fresh restoration and overlays choose independently. All derived callers and handles share the mode. Live stores and arbitrary private commit providers are rejected before provider work; a memory label does not establish eligibility.

Sync sections mask interruption and suppress automatic and confined-walk yields while owning state. Ordinary reentry fails with VolumeBusy before scoped acquisition. A private checked binding supports future adapter preflight, not arbitrary-Effect execution. Handle finalization immediately marks ownership releasedPendingCommit, then drains direct release actions against current state before returning, even if the outer draft failed. All queued releases are attempted and failures remain visible. File and directory handles reject logically released ownership before reclamation completes.

Community watch teardown directly removes subscribers and shuts down queues without waiting for the active engine section. Sync snapshot/overlay processing runs after immutable-state capture; cooperative capture preserves its established ordering. Effect-valued test seams are rejected before sync operations invoke them. The `packages/core/test/Execution.test.ts` exercise mixed access, reentry, late publication, interruption and cleanup. These guarantees do not establish native Node integration or acceptance of the upstream Effect API.

## Dependency ownership for the Effect port

This is a local shared implementation, not an independently portable Effect module yet. An import does not imply a new public Effect module. The runtime import audit allows exactly the six project modules below, including the engine itself, and rejects undocumented additions. Existing `effect/*` imports already reuse Effect APIs.

| Runtime module         | Why it remains locally                                                                                                                                       | Intended upstream home                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `internal/engine.ts`   | One implementation shared by community construction and the private minimal candidate.                                                                       | The filesystem engine implementation. Its internal namespaces support direct community integration and focused engine tests; they do not prescribe public Effect modules.                                                                    |
| `internal/bytePath.ts` | Shared opaque byte ownership, equality and hashing for existing public values and failures. Keeping one implementation preserves value interoperability.     | The separately reviewed BytePath module. Replace the community value/API when that contract is available; this extraction does not copy the current implementation wholesale into Effect.                                                    |
| `internal/bytes.ts`    | BytePath transitively uses its byte equality function; community codecs also share this existing file.                                                       | Existing utilities or private BytePath helpers. No separate public Bytes proposal is implied. Codec-only UTF-8 helpers are outside the engine's responsibilities.                                                                            |
| `Metadata.ts`          | Existing public schemas are shared with community operations and preserve current validation.                                                                | Types and private validation under the reviewed filesystem contract. Adapt to Effect FileSystem metadata at the adapter boundary; community snapshot timestamp bounds do not become an Effect-wide policy automatically.                     |
| `FileHandle.ts`        | Existing handle brands and seek modes preserve public capability identity and validation.                                                                    | Private engine handle identity and the Effect `FileSystem.File` adapter. Any public capability API is reviewed in #308; a standalone FileHandle module is not assumed.                                                                       |
| `VfsError.ts`          | One shared error class preserves existing failures, schema checks and adapter translation. The imported schema still includes community image/storage codes. | Replace the community vocabulary with the reviewed filesystem error model. The FileSystem adapter uses Effect's existing PlatformError contract. Do not port image/storage error codes or propose an independent VfsError module by default. |

Filesystem-specific lexical and lookup helpers are now in `Paths` inside the engine. Upstream they remain private filesystem code, reusing only the operations actually supplied by BytePath. `Errors` contains filesystem failure construction, configuration decoding and operation/path diagnostics; it does not introduce a general validation module. Community codec issue classification and image failure construction stay outside.

The unchanged FIFO gate now lives inside the engine. It is a private coordination implementation pending #302's qualification. Replacing it with an existing Effect primitive requires equivalent ordering and interruption behavior. Promoting it to a general concurrency module requires its own review and evidence; neither is assumed by #307. Private deterministic test hooks also live inside the engine and should be adapted to upstream test conventions, without a public testing service.

The engine owns its filesystem capability contracts, including operations, basic limits, usage, handles, instance-bound references and observation/results. Community interfaces extend those contracts while retaining explicit public member types. Keeping those public annotations avoids inferred downstream declarations naming private engine types. No runtime schema is duplicated.

The object-reference brand is declared by the engine and exposed through Caller with the same registered symbol. FileHandle brands and metadata/error schemas remain shared leaf modules. The byte-path value interface belongs to its existing private bytePath module; the public BytePath interface retains its equivalent explicit definition. Neither the engine nor its transitive type dependencies import Caller, VirtualFileSystem or other community construction modules.

The import audit checks two graphs: source dependencies including type imports, and the existing runtime graph after erasure. Both engine graphs are restricted to the same six-module allowlist. Compile-only EngineOwnership contracts preserve the previous public capability shapes and compare the engine operation contract against that previous selected Caller subset. Public branding, schemas, constructors, watches, durable installation, snapshots and execution behavior remain unchanged.

These local ownership checks do not establish accepted upstream contracts. The [staged implementation plan](../research/minimal-effect-port.md "refined by") records caller adoption, supported capture/restore, checked synchronous binding, downstream feature migration and eventual core retirement.

The reusable memory binding is an adapter, not an engine helper. It maps the private operation port to Effect FileSystem and remains separate from community construction and watch delivery. This audit qualifies the local runtime boundary; it does not settle the upstream public API or prove that the current source can be copied unchanged.

Any additional runtime engine dependency needs a recorded local necessity and upstream ownership decision before extending the audit allowlist. Independently useful abstractions require separate review; filesystem-only helpers stay in the engine by default.

The minimal constructor and adapter bridge are private qualification surfaces, not published APIs. The source import audit follows the engine graph including type imports, and runtime imports after type erasure from the real engine, reusable FileSystem binding and test-only minimal constructor. It rejects Crypto and community feature construction through transitive imports. `Engine.test.ts` groups the resolver, token-lifecycle and persistent-state invariants with the direct engine behavior checks. The error-order, late-publication and payload-ownership regressions remain; no test is removed merely because it observes a private invariant. Public filesystem and adapter suites retain their existing behavioral ownership.

The model is [constrained by schema and capability modeling](../decisions/core/schema-data-and-capability-interfaces.md "constrained by"), [independent resource lifetimes](../decisions/core/independent-resource-lifetimes.md "constrained by"), [explicit close semantics](../decisions/core/explicit-close-and-scope-cleanup.md "constrained by"), [scope-free root callers](../decisions/core/scope-free-root-callers.md "constrained by"), and [reusable capability effects](../decisions/core/reusable-capability-effects.md "constrained by"). Detailed rules belong to the [resource and authority contract](../contracts/resources-and-authority.md "refined by"), [regular-file I/O contract](../contracts/regular-file-io.md "refined by"), [permissions and metadata contract](../contracts/permissions-and-metadata.md "refined by"), and [mutation and observation contract](../contracts/mutation-and-observation.md "refined by").

[^resolution]: `engine.ts` implements traversal and addressing-mode policies; the path/entry resolution groups in `Engine.test.ts` exercise error ordering and draft-aware lookup directly over engine state.

[^tokens]: `engine.ts` implements token identity and lifecycle; the capability identity/lifetime group in `Engine.test.ts` exercises liveness, staged release, and cleanup before late publication. The engine supplies the durable transition callbacks.

[Confined callers](../contracts/confined-callers.md "refined by") add optional identity roots and retain imported authority through capability conversions.
