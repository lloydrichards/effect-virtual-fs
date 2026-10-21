---
type: Research
title: Minimal Effect filesystem port
description: Proposes reusable Effect dependencies, a reduced memory engine and separate Node VFS qualification.
status: draft
tags: [architecture, effect, compatibility]
sources:
  - resource: ../../research/273-effect-port-plan.md
    title: Staged PR plan and namespace migration map
  - resource: ../../research/273-node-vfs-compatibility.md
    title: Node VFS comparison and targeted probe findings
  - resource: ../../research/273-swarm-review.md
    title: Reviewed staged-plan gaps and resolutions
  - resource: ../../research/273-compatibility-profile.md
    title: Selected method compatibility profile
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/273
    title: Parent scope issue
generated: { by: codex/okf, at: "2026-10-21T17:43:01+00:00" }
---

# Minimal Effect filesystem port

The proposed direction is to adopt existing Effect Bytes, Glob and crypto modules and propose BytePath before a reduced memory filesystem engine and its Effect `FileSystem` provider. Existing Effect `Bytes` already covers concatenation, equality and ordering. At verified `v4/next-minor` revision `3c0eb2b1d2ebfc03f8a1a77a143b459bd66655c6`, Glob and portable `FileSystem.glob` already exist. BytePath needs an independent proposal. Hex128 remains local Schema composition and has no mandatory extraction issue.

Effect service compatibility, shared filesystem behaviour and native `node:vfs` integration are separate acceptance claims. Native integration requires a checked synchronous memory execution contract and a Node-only provider adapter. A failed synchronous call must not mutate later. Durable asynchronous stores remain outside that initial binding.

The proposed upstream scope excludes snapshots, overlays, deltas, search, transfer, external reference keys, persistence and NFS. Existing community guarantees remain unchanged under the [package boundary decision](../decisions/package-boundaries.md "constrained by"). Basic memory allocation limits remain in the proposed engine; richer policy and confinement stay downstream initially.

The reviewed abstraction gates require existing HashMap reuse or independently justified collection work, and elimination or independent resolution of a general fair-lock algorithm. Filesystem state, resolver rules, private object identity, orphan lifetime and allocation policy stay internal. Excluding public references must preserve rename-safe cleanup. FileSystem copy must lose its transitive TreeTransfer dependency.

The accepted [persistent-state decision](../decisions/core/persistent-volume-state.md "refined by") replaces the generic integer trie with marked private inode HashMap records and explicit directory slots. The [collection evidence](../evidence/collection-reuse.md "evidenced by") records measured CPU and retained-heap costs. Target next-minor and native Node qualification remain separate. These results do not justify a new collection module.

The crypto migration replaces removed `effect/Crypto` with SecureRandom, Digest and optional Mac. Portable globbing requires `readDirectoryEntries` and explicit acceptance of changed matching and traversal behaviour. Bounded snapshot search retains its stricter work limits until adaptation is proven. Installed-to-target migration also covers bigint metadata, positioned reads, final-component noFollow, watch readiness and testing glob interception.

The proposed initial upstream watch is explicitly unsupported while community watches remain supported. Native Node handles have their own cursor/lifecycle wrapper. The review at `research/273-swarm-review.md` and method profile at `research/273-compatibility-profile.md` define the gates. #303, #308 and #309 target Effect; local #304–#307 prepare the implementation, existing #302 owns sync proof, and #310–#311 cover separate Node implementation/qualification.

The staged plan at `research/273-effect-port-plan.md` contains exact source baselines, the complete namespace map, ordered PRs and verification gates. The Node comparison at `research/273-node-vfs-compatibility.md` records current experimental runtime constraints and deliberate differences. This proposal does not establish v1 stability or maintainer acceptance. Convert it to an accepted decision only after scope and ownership review.
