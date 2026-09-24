---
type: Research
title: Agent filesystem landscape
description: Surveys filesystems and storage layers built for AI agents, including Alchemy's sandbox and FUSE seams, and maps each idea to what effect-virtual-fs already has, what is missing, and possible directions.
status: draft
tags: [agents, alchemy, fuse, overlay, git, cloudflare, landscape]
sources:
  - id: alchemy-sandbox
    resource: https://github.com/alchemy-run/alchemy/blob/sam/harness/packages/alchemy/src/AI/Sandbox.ts
    title: Alchemy AI Sandbox service (unreleased branch sam/harness)
  - id: alchemy-sandbox-local
    resource: https://github.com/alchemy-run/alchemy/blob/sam/harness/packages/alchemy/src/AI/SandboxLocal.ts
    title: Alchemy trusted-host Sandbox over Effect FileSystem
  - id: alchemy-editfile
    resource: https://github.com/alchemy-run/alchemy/blob/sam/harness/services/root/src/coding/EditFile.ts
    title: Alchemy editFile agent tool
  - id: alchemy-readfile
    resource: https://github.com/alchemy-run/alchemy/blob/sam/harness/services/root/src/coding/ReadFile.ts
    title: Alchemy readFile agent tool
  - id: alchemy-grep
    resource: https://github.com/alchemy-run/alchemy/blob/sam/harness/services/root/src/coding/Grep.ts
    title: Alchemy grep agent tool (ripgrep through Sandbox.exec)
  - id: alchemy-pushbranch
    resource: https://github.com/alchemy-run/alchemy/blob/sam/harness/services/root/src/coding/PushBranch.ts
    title: Alchemy pushBranch agent tool
  - id: alchemy-fuse-mount
    resource: https://github.com/alchemy-run/alchemy/blob/sam/harness/packages/alchemy/src/FUSE/Mount.ts
    title: Alchemy FUSE Mount binding contract
  - id: alchemy-fuse-tigrisfs
    resource: https://github.com/alchemy-run/alchemy/blob/sam/harness/packages/alchemy/src/FUSE/MountTigrisfs.ts
    title: Alchemy tigrisfs Mount implementation
  - id: alchemy-sandbox-container
    resource: https://github.com/alchemy-run/alchemy/blob/sam/harness/packages/alchemy/src/Cloudflare/AI/SandboxContainer.ts
    title: Alchemy per-session Cloudflare Container sandbox
  - id: alchemy-git-checkouts
    resource: https://github.com/alchemy-run/alchemy/blob/sam/harness/packages/alchemy/src/Git/Checkouts.ts
    title: Alchemy Git Checkouts service
  - id: alchemy-git-credentials
    resource: https://github.com/alchemy-run/alchemy/blob/sam/harness/packages/alchemy/src/Git/Credentials.ts
    title: Alchemy Git Credentials service
  - id: alchemy-git-design
    resource: https://github.com/alchemy-run/alchemy/blob/sam/harness/packages/alchemy/src/Git/DESIGN.md
    title: Alchemy git-service design document
  - id: cf-fuse-changelog
    resource: https://developers.cloudflare.com/changelog/post/2025-11-21-fuse-support-in-containers/
    title: Cloudflare changelog, Mount R2 buckets in Containers
  - id: cf-fuse-example
    resource: https://developers.cloudflare.com/containers/examples/r2-fuse-mount/
    title: Cloudflare Containers, Mount R2 buckets with FUSE
  - id: cf-sandbox-files
    resource: https://developers.cloudflare.com/sandbox/api/files/
    title: Cloudflare Sandbox SDK Files API
  - id: cf-artifacts
    resource: https://developers.cloudflare.com/artifacts/
    title: Cloudflare Artifacts documentation
  - id: cf-artifacts-blog
    resource: https://blog.cloudflare.com/artifacts-git-for-agents-beta/
    title: Artifacts, versioned storage that speaks Git
  - id: artifact-fs
    resource: https://github.com/cloudflare/artifact-fs
    title: ArtifactFS repository
  - id: tigrisfs
    resource: https://github.com/tigrisdata/tigrisfs
    title: TigrisFS repository
  - id: geesefs
    resource: https://github.com/yandex-cloud/geesefs
    title: GeeseFS repository and POSIX compatibility matrix
  - id: overlayfs
    resource: https://docs.kernel.org/filesystems/overlayfs.html
    title: Linux kernel overlay filesystem documentation
  - id: mesa
    resource: https://www.mesa.dev/
    title: Mesa product page
  - id: mesa-versioning
    resource: https://docs.mesa.dev/content/concepts/versioning
    title: Mesa versioning concepts
  - id: archil
    resource: https://archil.com/
    title: Archil product page
  - id: archil-architecture
    resource: https://docs.archil.com/details/architecture
    title: Archil architecture
  - id: archil-sharing
    resource: https://docs.archil.com/concepts/sharing-disks
    title: Archil sharing disks and delegations
  - id: archil-just-bash
    resource: https://archil.com/post/just-bash-support
    title: Archil now supports mounting from just-bash
  - id: files-sdk
    resource: https://github.com/haydenbleasel/files-sdk
    title: Files SDK repository
  - id: subramanya
    resource: https://subramanya.ai/2026/04/13/the-filesystem-is-the-database-why-agents-need-a-new-storage-primitive/
    title: The filesystem is the database
  - id: agentfs
    resource: https://github.com/tursodatabase/agentfs
    title: AgentFS repository, SPEC.md and MANUAL.md
  - id: agentfs-blog
    resource: https://turso.tech/blog/agentfs
    title: Turso AgentFS announcement
  - id: chromafs
    resource: https://www.mintlify.com/blog/how-we-built-a-virtual-filesystem-for-our-assistant
    title: Mintlify, how we built a virtual filesystem for our assistant
  - id: just-bash
    resource: https://github.com/vercel-labs/just-bash
    title: just-bash repository and IFileSystem interface
  - id: mirage
    resource: https://github.com/strukto-ai/mirage
    title: Mirage repository
  - id: airstore
    resource: https://github.com/beam-cloud/airstore
    title: Airstore repository
  - id: amplify
    resource: https://www.amplifypartners.com/blog-posts/file-systems-for-agents
    title: Amplify Partners, File systems for agents
  - id: automerge-conflicts
    resource: https://automerge.org/docs/reference/documents/conflicts/
    title: Automerge conflicts
  - id: yjs
    resource: https://docs.yjs.dev/
    title: Yjs documentation
generated: { by: claude/okf, at: 2026-09-24T09:00:00+02:00 }
---

# Agent filesystem landscape

Researched 2026-09-24. This page surveys filesystems built for agents and ideas raised when the project was shared in the Alchemy Discord. Every direction below is a proposal. None is accepted or implemented unless it points at existing repository code.

**Unreachable source:** the tweet `x.com/samgoodwin89/status/2087289659533713692` returned HTTP 402 and could not be read. This page uses Cloudflare's own FUSE-on-R2 documentation and Alchemy's `FUSE` source in its place.

## Summary

Ranked by fit with the current code and by effort (low effort first within similar fit):

1. **An Effect AI toolkit and MCP server over a `Caller`** (high fit, low effort). The surveyed systems settle on a small tool surface. Alchemy's `Sandbox` service has six file methods (`readFile`, `writeFile`, `deleteFile`, `mkdir`, `listFiles`, `exists`) that fail with model-visible `string` errors ([Sandbox.ts](https://github.com/alchemy-run/alchemy/blob/sam/harness/packages/alchemy/src/AI/Sandbox.ts)). AgentFS's `serve mcp` exposes a similar set ([MANUAL.md](https://github.com/tursodatabase/agentfs/blob/main/MANUAL.md)). Effect's own `effect/unstable/ai` `Tool`, `Toolkit` and `McpServer` can express that surface with no dependency on any agent framework.
2. **Overlay as a first-class branch or fork** (high fit, medium effort). `makeOverlay`, `changes()`, `capture()` and snapshot deltas already give per-agent copy-on-write workspaces. Mesa, AgentFS, ArtifactFS and Cloudflare Artifacts all present this as fork/diff/merge, or as a whiteout-based overlay. The repo lacks a named fork/branch API and any merge. Merge is listed as deferred.
3. **Change export as a patch or git commit, pushed by a trusted host** (high fit, medium effort). Today Alchemy's `pushBranch` puts a GitHub token into the push URL of a command that runs _inside_ the sandbox ([PushBranch.ts](https://github.com/alchemy-run/alchemy/blob/sam/harness/services/root/src/coding/PushBranch.ts)). An overlay `changes()` summary plus the bytes can become a git tree/commit or a unified diff _outside_ the sandbox, so the sandbox never holds credentials.
4. **A search primitive (`grep`/`glob`) over the volume** (high fit, low–medium effort). Alchemy's `grep` and `glob` tools shell out to `rg` through `Sandbox.exec` ([Grep.ts](https://github.com/alchemy-run/alchemy/blob/sam/harness/services/root/src/coding/Grep.ts)). A volume with no shell needs its own search. ChromaFs shows the two-stage "coarse candidate filter, then in-memory regex" pattern ([Mintlify](https://www.mintlify.com/blog/how-we-built-a-virtual-filesystem-for-our-assistant)).
5. **A just-bash `IFileSystem` adapter** (medium fit, low effort). It answers "agents want to sling bash" without a container. just-bash is a TypeScript bash with `grep`, `rg`, `sed` and `awk` over a pluggable `IFileSystem` ([just-bash](https://github.com/vercel-labs/just-bash)). ChromaFs and Archil both plug into it.
6. **Revision-guarded writes as a core compare-and-set** (medium fit, low effort). Alchemy's `editFile` requires the SHA-256 returned by `readFile` and checks it with a separate read before writing, which is not atomic ([EditFile.ts](https://github.com/alchemy-run/alchemy/blob/sam/harness/services/root/src/coding/EditFile.ts)). The repo's mutation revisions could make that check atomic.
7. **External-service mount adapters** (medium fit, high effort). Mirage and Airstore mount Slack, Notion, Drive and GitHub as directory trees ([Mirage](https://github.com/strukto-ai/mirage), [Airstore](https://github.com/beam-cloud/airstore)). Here this is best framed as snapshot or fixture materialization plus a read-only overlay base, not live two-way sync.
8. **A FUSE export beside NFS** (lower fit, high effort). FUSE is currently deferred. The NFS export already gives native tools a mount, and AgentFS itself uses NFS on macOS and FUSE on Linux ([AgentFS README](https://github.com/tursodatabase/agentfs)).

Multi-user CRDT editing of one file is a poor fit for the byte-level POSIX core. It is discussed under [concurrency](#8-crdt-versus-single-writer), where the recommendation is single-writer plus overlay-per-agent plus merge.

## Per-source findings

### Alchemy `AI.Sandbox` (branch `sam/harness`, unreleased)

- **Shape.** `class Sandbox extends Context.Service<Sandbox, {...}>()("alchemy/AI/Sandbox")`. It has `exec(command, args?, options?)` returning `{ success, exitCode, stdout, stderr, stdoutTruncated, stderrTruncated, durationMs }` and the file methods. Lines 165–184 of the file are the file half ([Sandbox.ts](https://github.com/alchemy-run/alchemy/blob/sam/harness/packages/alchemy/src/AI/Sandbox.ts#L165-L184)):

  ```ts
  readonly readFile: (path: string) => Effect.Effect<string, string>        // UTF-8, fails on binaries
  readonly writeFile: (path: string, content: string) => Effect.Effect<void, string> // atomic, creates parents
  readonly deleteFile: (path: string) => Effect.Effect<void, string>
  readonly mkdir: (path: string) => Effect.Effect<void, string>             // recursive
  readonly listFiles: (path?: string) => Effect.Effect<ReadonlyArray<SandboxEntry>, string>
  readonly exists: (path: string) => Effect.Effect<boolean, string>
  readonly pty?: SandboxPty
  readonly lifecycle?: SandboxLifecycle
  ```

  `SandboxEntry` is `{ name, type: "file" | "directory" | "other" }`.
- **Error model.** Failures are strings that the model reads and reacts to, never defects. Everything on the interface is JSON-serializable, so it can be marshalled across an isolate or network boundary ([Sandbox.ts](https://github.com/alchemy-run/alchemy/blob/sam/harness/packages/alchemy/src/AI/Sandbox.ts)).
- **Stated design stance.** The surface "deliberately matches" what sandbox SDKs converged on: shell-string `exec` plus plain file operations. Truncation, artifact retention and digest-guarded writes are left to the tool layer. Git is a separate seam (`Git.Checkouts`) ([Sandbox.ts](https://github.com/alchemy-run/alchemy/blob/sam/harness/packages/alchemy/src/AI/Sandbox.ts)). Cloudflare's Sandbox SDK has a similar file API (`readFile`, `writeFile`, `exists`, `mkdir`, `deleteFile`, `renameFile`, `moveFile`) with UTF-8/base64 encodings and streaming for large files ([Cloudflare Sandbox Files API](https://developers.cloudflare.com/sandbox/api/files/)).
- **Implementations.** `SandboxLocal` is described as "physics over a Workspace containment root". It is built from `Workspace | FileSystem.FileSystem | Path.Path | ChildProcessSpawner`. Writes go to a temp file and then `fs.rename`. Its docs say containment is "path discipline, not a security barrier" ([SandboxLocal.ts](https://github.com/alchemy-run/alchemy/blob/sam/harness/packages/alchemy/src/AI/SandboxLocal.ts)). `Cloudflare.SandboxContainer` gives each session its own Container. Its disk is ephemeral, so durable work must leave "through git (push) or an explicit persistence mount" ([SandboxContainer.ts](https://github.com/alchemy-run/alchemy/blob/sam/harness/packages/alchemy/src/Cloudflare/AI/SandboxContainer.ts)).

### Alchemy agent tools built on the Sandbox

- **`readFile`** returns line-numbered pages (cap 2000 lines / 50 KB) plus the whole file's SHA-256 `digest` ([ReadFile.ts](https://github.com/alchemy-run/alchemy/blob/sam/harness/services/root/src/coding/ReadFile.ts)).
- **`editFile`** takes exact-string `edits` (unique unless `replaceAll`, non-overlapping, all matched against the original) and a required `expectedDigest`. It re-reads the file, compares SHA-256, applies all edits in memory and calls `sandbox.writeFile`, returning the new digest ([EditFile.ts#L126](https://github.com/alchemy-run/alchemy/blob/sam/harness/services/root/src/coding/EditFile.ts#L126)). The digest check and the write are two separate `Sandbox` calls, so another writer can slip in between them.
- **`grep` / `glob`** run `rg` through `sandbox.exec`, with output modes `content | files | count` and truncation to retained artifacts ([Grep.ts](https://github.com/alchemy-run/alchemy/blob/sam/harness/services/root/src/coding/Grep.ts)).
- **`pushBranch`** reads a `PublishToken` (a GitHub PAT resource), passes an approval `Gate`, and runs `git push https://x-access-token:<token>@github.com/... HEAD:refs/heads/<branch>` through the sandbox. It then strips the token from error text ([PushBranch.ts](https://github.com/alchemy-run/alchemy/blob/sam/harness/services/root/src/coding/PushBranch.ts)). The token is never written to the tree, but it does pass through a process inside the sandbox. This is the "push without giving the sandbox credentials" problem.
- **`Git.Credentials`** follows git's credential-helper pattern (`for(remote) => Option<{ username, password: Redacted }>`). **`Git.Checkouts`** returns idempotent keyed working trees (worktree, clone, or Cloudflare Artifacts forks mounted with artifact-fs). It states that "the artifact that crosses machine boundaries is the pushed branch, never a shared filesystem" ([Checkouts.ts](https://github.com/alchemy-run/alchemy/blob/sam/harness/packages/alchemy/src/Git/Checkouts.ts), [Credentials.ts](https://github.com/alchemy-run/alchemy/blob/sam/harness/packages/alchemy/src/Git/Credentials.ts)).
- The branch also contains an Effect-native git hosting engine on Workers + Durable Objects + R2. It deliberately has "nothing inside the engine" for auth: the application's HTTP middleware authorizes pushes ([Git DESIGN.md §8](https://github.com/alchemy-run/alchemy/blob/sam/harness/packages/alchemy/src/Git/DESIGN.md)). An Alchemy-hosted remote could therefore accept a push from a sandbox with a short-lived scoped token, and a trusted host could mirror it to GitHub.

### Alchemy FUSE bindings and Cloudflare FUSE-on-R2

- **Contract.** `FUSE.Mount` is a `Binding.Service` with signature `(bucket: Bucket, options?: { path?, prefix?, args?, readyTimeout? }) => Effect<MountHandle>`. `Bucket` is structural (`Type`, `LogicalId`, `bucketName`). A failed mount dies, because "a machine that cannot mount its persistence is not viable" ([Mount.ts](https://github.com/alchemy-run/alchemy/blob/sam/harness/packages/alchemy/src/FUSE/Mount.ts)).
- **Implementation.** `MountTigrisfs` adds `fuse3` and `tigrisfs` to the host image. For R2 it mints a scoped Cloudflare API token and derives R2 S3 credentials from it into the container environment. AWS S3 is not implemented yet ([MountTigrisfs.ts](https://github.com/alchemy-run/alchemy/blob/sam/harness/packages/alchemy/src/FUSE/MountTigrisfs.ts)).
- **Cloudflare platform.** FUSE mounts of R2 in Containers were announced on 2025-11-21 with tigrisfs, s3fs and gcsfuse ([changelog](https://developers.cloudflare.com/changelog/post/2025-11-21-fuse-support-in-containers/)). The official example passes S3 credentials as Worker secrets through `envVars`. It warns that object storage "is not a POSIX-compatible filesystem" and not SSD-fast ([example](https://developers.cloudflare.com/containers/examples/r2-fuse-mount/)).
- **Semantics of the adapter.** TigrisFS is a fork of GeeseFS ([tigrisfs](https://github.com/tigrisdata/tigrisfs)). GeeseFS documents directory renames, fsync and symlinks. Hard links, locking and "invisible" unlinked-open files are not supported, and concurrent updates of the same file from multiple hosts are not supported. chmod/chown work correctly only on Yandex S3 ([GeeseFS](https://github.com/yandex-cloud/geesefs)). Several of these are behaviors this repo implements and tests itself: unlinked-open files, hard links, and ownership/mode bits.

### Overlayfs over a FUSE-mounted R2 (Sam's persistence idea)

- Linux overlayfs allows almost any lower filesystem. The upper layer must support `trusted.*`/`user.*` xattrs and valid `d_type`, and the docs call NFS unsuitable as an upper. Changing a lower layer while it is mounted gives undefined behavior. Copy-up copies a whole file before writing ([kernel overlayfs](https://docs.kernel.org/filesystems/overlayfs.html)).
- Consequence: the easy arrangement is a read-only R2 lower with an ephemeral local upper, but then the edits do not persist. Putting the upper on the FUSE mount depends on the adapter's xattr support, and on whether the Container permits an overlay mount. Neither was verified here.
- **ArtifactFS** is a working example of the same idea in userspace. It does a blobless git clone and exposes the tree through FUSE right away. Reads come from a merge of the base snapshot (SQLite `base_nodes`) and an overlay (SQLite metadata plus an `upper/` directory). Writes copy up on demand and deletes are whiteouts. `overlay_dirty` reports local modifications ([artifact-fs](https://github.com/cloudflare/artifact-fs)).

### Cloudflare Artifacts

A Git-compatible versioned store in closed beta. It supports programmatic repo creation, import, forks (including read-only forks) and "hand off a URL to any standard Git client" ([Artifacts docs](https://developers.cloudflare.com/artifacts/)). The launch post (2026-04-16) describes Durable Objects, R2 and KV, a Zig→Wasm git engine, and scoped credentials as remote URLs with embedded tokens ([Cloudflare blog](https://blog.cloudflare.com/artifacts-git-for-agents-beta/)). Alchemy already binds it as `Cloudflare.Artifacts.Namespace`.

### Mesa

Mesa is a versioned filesystem for agents. Its docs say versioning is "directly based on Jujutsu": changes form a DAG, bookmarks are non-advancing branch pointers, there is no staging area, and conflicts are non-blocking, so a change can stay conflicted and be resolved later ([Mesa versioning](https://docs.mesa.dev/content/concepts/versioning)). Access is through a FUSE3 mount, TypeScript/Python SDKs, REST, and GitHub upstream sync (`syncUpstream`). **Marketing, unverified:** "sub-50ms" read/write, "100% POSIX compatible", millisecond forks ([mesa.dev](https://www.mesa.dev/)).

### Archil

Archil is a durable cache in front of S3-compatible buckets, reached through a proprietary client protocol. Written data is durable across availability zones once `fsync()` returns and syncs to the bucket "generally" within five minutes. Reads are read-after-write consistent across clients ([architecture](https://docs.archil.com/details/architecture)). Multi-writer control uses **delegations**: an exclusive write lock on a path (`archil checkout <path>` / `checkin`). Shared mode is read-only until a client takes a delegation, and some are granted automatically on create or open-for-write. Conditional mode behaves like NFS without delegations ([sharing disks](https://docs.archil.com/concepts/sharing-disks)). It also ships an `ArchilFs` adapter for just-bash that needs no FUSE ([Archil blog](https://archil.com/post/just-bash-support)). **Marketing, unverified:** "100×" faster git clone than EFS and "30×" faster 4 KB reads than S3 ([archil.com](https://archil.com/)).

### Files SDK

Files SDK is an MIT TypeScript SDK with one object-store API over many adapters, including S3/R2/GCS/Azure, the local filesystem and Dropbox. Its operations are `upload`, `download`, `head`, `exists`, `delete`, `copy`, `move`, `list`/`listAll`, `url` and `signedUploadUrl`, plus `file(key)` handles, web-standard bodies and a `raw` escape hatch. It also ships prebuilt tools for the AI SDK, OpenAI and the Claude Agent SDK. Mutating tools default to `needsApproval = true` ([files-sdk](https://github.com/haydenbleasel/files-sdk)). It works with object keys, not a POSIX namespace, so it is closer to this repo's `LiveImageStore` transport than to `Caller`.

### "The filesystem is the database" and its primary sources

The blog argues that agents explore data sequentially, so a filesystem interface over a database substrate beats RAG. It cites ChromaFs, AgentFS, Box, OpenViking and the author's markdownfs ([subramanya.ai](https://subramanya.ai/2026/04/13/the-filesystem-is-the-database-why-agents-need-a-new-storage-primitive/)). The primary sources:

- **AgentFS (Turso, beta, MIT).** A SQLite schema spec with three parts: an insert-only `tool_calls` audit table; an inode filesystem (`fs_inode`, `fs_dentry`, `fs_data` in fixed `chunk_size` chunks, default 4096) that supports hard links; and a KV store. The overlay mode uses an `fs_whiteout` table and `fs_origin` so stat keeps returning the base inode number after copy-up ([SPEC.md](https://github.com/tursodatabase/agentfs/blob/main/SPEC.md)). The CLI mounts via FUSE on Linux and NFS on macOS. It also has `serve nfs` (NFSv3), `serve mcp` (tools `read_file`, `write_file`, `readdir`, `mkdir`, `remove`, `rename`, `stat`, `access`, and KV), `diff` for overlay changes, and `sync push|pull` to Turso Cloud ([MANUAL.md](https://github.com/tursodatabase/agentfs/blob/main/MANUAL.md)). Examples include Cloudflare Workers on Durable Object storage and just-bash ([README](https://github.com/tursodatabase/agentfs)). Snapshot means copying the `.db` file ([Turso blog](https://turso.tech/blog/agentfs)).
- **ChromaFs (Mintlify).** A read-only just-bash filesystem over Chroma collections. The path tree is stored as compressed JSON and pruned per user (`isPublic`, `groups`) before the agent sees it. `cat` reassembles chunks. `grep` first queries Chroma for candidate files, prefetches their chunks into Redis, then runs the regex in memory. **Claimed:** session boot fell from 46 s to 100 ms ([Mintlify](https://www.mintlify.com/blog/how-we-built-a-virtual-filesystem-for-our-assistant)).
- **just-bash (Vercel Labs).** A simulated bash in TypeScript over an `IFileSystem` interface: `readFile`, `readFileBuffer`, `writeFile`, `appendFile`, `exists`, `stat`, `lstat`, `mkdir`, `readdir`, `rm`, `cp`, `mv`, `chmod`, `symlink`, `link`, `readlink`, `realpath`, `utimes`, `resolvePath`, `getAllPaths`. It ships `InMemoryFs`, `OverlayFs` (copy-on-write over a host directory), `ReadWriteFs` and `MountableFs`, and its commands include `grep`, `rg`, `sed` and `awk` ([just-bash](https://github.com/vercel-labs/just-bash)).

### Mirage and Airstore (external services as files)

- **Mirage (Strukto, Apache-2.0, preview).** A "virtual terminal" with a rewritten bash. Services mount side by side under one root (S3/R2, Drive, Slack, Gmail, Notion, GitHub, Postgres, Redis and more). It also provides virtual CLIs (`git`, `slack`, `ntn`) that Mirage answers itself, each with its own credentials. Agents reach it through SDKs, a CLI, or FUSE/FSKit. Profiles use `allow`/`ask`/`deny` for commands and `hide`/`show` for paths, so a hidden path is absent from the agent's view rather than just unreadable ([Mirage](https://github.com/strukto-ai/mirage)). The virtual `git` CLI is another answer to credential-free pushes: the credential lives in the host process, not in the agent's environment.
- **Airstore (Beam, AGPL-3.0).** A FUSE mount where "source views" (natural-language or structured queries over Gmail, GitHub, Linear and others) materialize as folders of files. They sync in the background, and MCP servers are exposed as executables under `tools/` ([Airstore](https://github.com/beam-cloud/airstore)).

### Amplify Partners, "File systems for agents"

This is an investor essay. It argues that agents' training data and work patterns (whole-file reads, targeted edits, appends) favor files over OLTP databases or object stores. It says current distributed filesystems lack multi-file transactions and fine-grained, execution-aware access control. It names Turso AgentFS, Archil and Vortex ([Amplify](https://www.amplifypartners.com/blog-posts/file-systems-for-agents)). These are positions, not technical evidence.

### CRDTs

Automerge resolves concurrent writes to the same property by deterministic last-writer-wins and keeps the losing values as conflicts. Concurrent list and text insertions are all preserved in a converged order ([Automerge](https://automerge.org/docs/reference/documents/conflicts/)). Yjs offers shared types such as `Y.Text` that merge without conflicts, over pluggable network and persistence providers ([Yjs](https://docs.yjs.dev/)). Both model structured or text documents. Neither models an opaque byte file with POSIX `write(offset)` semantics.

## Mapping to effect-virtual-fs

### 1. Narrow agent-tool surface with Effect AI

- **Exists.** `MemoryFileSystem.layer` provides Effect's `FileSystem.FileSystem` over a virtual volume (`packages/memory/src/MemoryFileSystem.ts`). The `Caller` interface has path and reference operations with typed `FsError`s (`packages/core/src/VirtualFileSystem.ts`). `apps/demo-overlay/src/agent.ts` already defines `read_file`, `write_file` and `list_directory` tools with `failureMode: "return"` over a volume. It returns failures as `${code}: ${operation}` strings and hand-rolls path confinement by rejecting absolute paths and `..`.
- **Gap.** There is no reusable toolkit, no structured tool failure, no MCP exposure, no text paging or revision outputs, and no search.
- **Direction.** Build an `apps/` example on `effect/unstable/ai` only: a `Toolkit` over a `Caller` whose failure schema carries `code`, `operation` and a display path, with `failureMode: "return"`. Serve the same toolkit through `McpServer`, so any MCP client can use a volume. `FsError` is a `Data.TaggedError` with a possibly byte-valued `path`, so the tool failure is a separate display schema. The library does not target any agent framework's shape. Alchemy's `Sandbox`, the `alchemy/FileSystem` floated in Discord, and Files SDK's tools are surveyed prior art, not compatibility targets. Promote the example to a package only once the tool shapes settle.
- **Open questions.** Which tools form the minimal set? Should binary reads fail, return base64, or page? Should reads return a revision for guarded writes (point 6)? Can the example drop its own confinement once a confined caller exists (#28)?

### 2. Overlay as branch/fork, copy-on-write branching, merge

- **Exists.** `makeOverlay(snapshot)` creates copy-on-write workspaces that share unchanged payloads. `changes()` produces deterministic final differences with rename lineage. `capture()` produces a complete snapshot plus summary. `diffSnapshots`, `inspectSnapshotDelta` and `applySnapshotDelta` provide portable deltas (`.okf/contracts/overlay-workspaces.md`, `.okf/contracts/snapshot-deltas.md`). `CheckpointStore` names checkpoints. These match AgentFS overlay `diff` and ArtifactFS `overlay_dirty` in function.
- **Gap.** There are no named branches or a fork graph, no "fork from a live volume at revision N" helper beyond `volume.snapshot` → `makeOverlay`, and no merge or rebase. The profile lists "snapshot-delta merge or rebase" as deferred (`.okf/profiles/deferred-capabilities.md`). Copy-up is whole-file (`.okf/contracts/overlay-workspaces.md`), which matches overlayfs.
- **Direction.** A three-way merge of two `SnapshotDelta`s against their common base. Report conflicts as data, not failures, following Mesa's non-blocking conflicts ([Mesa](https://docs.mesa.dev/content/concepts/versioning)). Path-level conflicts (both sides changed the same path) are enough at first. Text-level merge and conflict markers are out of scope, and branch or bookmark names stay with the application, as with `CheckpointStore` names. A thin `fork(volume)` helper over `volume.snapshot` → `makeOverlay` is possible but not tracked.
- **Open questions.** `SnapshotChange` has no rename variant, while overlay `changes()` retains rename lineage. Which one should merge compare? Does merge belong in core or in a separate module?

### 3. Git/patch export so a trusted host pushes on the sandbox's behalf

- **Exists.** `changes()` gives the changed paths and kinds. `capture()` gives stable bytes. `TreeTransfer` Stream sources can walk a snapshot (`packages/memory/src/TreeTransfer.ts`, `.okf/contracts/tree-transfer.md`, from issue #29).
- **Gap.** Nothing turns changes into git objects or a unified diff.
- **Direction.** Add an exporter from `(base snapshot, overlay changes)` to either (a) a unified diff or patch series, or (b) git tree/blob objects plus a commit on a given parent. Git tree entries only carry modes 100644, 100755, 120000 and 040000, so the exporter must map or reject other modes. The sandbox, or the agent's tools, only ever produce changes. A trusted host process holding the credentials (in Alchemy's terms, `Git.Credentials` or a `PublishToken`) builds the commit and pushes it through GitHub's REST API or git smart HTTP. This reverses today's `pushBranch` data flow ([PushBranch.ts](https://github.com/alchemy-run/alchemy/blob/sam/harness/services/root/src/coding/PushBranch.ts)). Alchemy's git engine or Cloudflare Artifacts could serve as a staging remote with short-lived tokens ([Git DESIGN.md](https://github.com/alchemy-run/alchemy/blob/sam/harness/packages/alchemy/src/Git/DESIGN.md), [Artifacts blog](https://blog.cloudflare.com/artifacts-git-for-agents-beta/)).
- **Open questions.** Should this depend on an existing TS git library or hand-write the loose-object and tree encoding? The latter is small, but pack/push is not. How should the export handle symlinks, special bits and hard links, which git cannot represent? Is a base snapshot tied to a git commit id enough provenance?

### 4. Search primitive (grep/glob)

- **Exists.** `readDirectoryBytes`, `observeDirectory`, snapshots and `TreeTransfer` Stream sources give the traversal pieces. Watches can drive an index.
- **Gap.** There is no `glob` or content search. Without a shell, agents would have to list and read every file themselves.
- **Direction.** Search over a snapshot, so that it does not update access times or commit on durable volumes. The first question is whether a documented Stream recipe over `TreeTransfer.fromSnapshot` plus a byte-safe glob matcher is enough, or whether a dedicated `search(caller, { pattern, glob?, outputMode: content|files|count, limit })` is justified. A measurement on a representative repository should decide. Alchemy's `grep` parameters are one reference for output modes, not a compatibility target ([Grep.ts](https://github.com/alchemy-run/alchemy/blob/sam/harness/services/root/src/coding/Grep.ts)). Later, a watch-maintained trigram or path index could provide ChromaFs-style coarse filtering ([Mintlify](https://www.mintlify.com/blog/how-we-built-a-virtual-filesystem-for-our-assistant)).
- **Open questions.** Should `.gitignore` be honored, as ripgrep does? How should matching treat names and contents that are not valid UTF-8?

### 5. "Slinging bash" without a container: just-bash adapter

- **Exists.** A full POSIX-ish `Caller` with symlinks, hard links, modes, `realPath` and `utimes`, which covers every method of just-bash's `IFileSystem`.
- **Gap.** There is no Promise-based adapter.
- **Direction.** Add a tiny adapter from `Caller` to `IFileSystem` that runs Effects at the boundary. just-bash would then run `grep`/`sed`/`find` pipelines inside a Worker or Durable Object directly over the volume, and the same volume could still be exported over NFS. ChromaFs and Archil both chose this route ([just-bash](https://github.com/vercel-labs/just-bash), [Archil blog](https://archil.com/post/just-bash-support)). It could also give the agent toolkit from point 1 a shell-style tool.
- **Open questions.** `getAllPaths()` is synchronous and whole-tree. Would a snapshot-backed cache be acceptable? Should this live in `apps/` as an example rather than a package?

### 6. Digest-guarded / compare-and-set writes

- **Exists.** Mutation revisions and object observations (`.okf/contracts/mutation-revisions.md`, `observeMetadata` returning `ObjectObservation`). `LiveImageStore.commit` already does whole-image compare-and-set with R2 `ifMatch` (`packages/persistence/src/R2LiveImageStore.ts`).
- **Gap.** There is no single write that fails if a file changed since a given observation, which is what `editFile`'s `expectedDigest` tries to do across two calls.
- **Direction.** Add an optional `expectedRevision` on `writeFile` that fails with a distinct error when the check fails. The check and the write would happen under the volume's coordination gate. A content-digest guard can follow if restore or export needs one, because revisions do not survive restore.
- **Open questions.** Which `FsCode` should a failed guard use? How does a tool get the revision that matches the bytes it read, given that `readFile` returns only bytes?

### 7. External-service mount adapters

- **Exists.** Fixtures and `fromFixture`, snapshots as overlay bases, and `TreeTransfer.toVolume` for atomic materialization. The `LiveImageStore` service is the storage seam.
- **Gap.** There are no lazy or remote-backed nodes. Every regular file is in memory, and "general-purpose live backing volumes" are deferred.
- **Direction.** Build external sources (Notion, Drive, GitHub issues) as _materializers_: a Stream of fixture entries that is snapshotted and used as a read-only overlay base, with ChromaFs/Mirage-style per-caller pruning done before materialization. Writes go to the overlay and are exported as a change set (point 3) for a trusted handler to apply. This keeps the core synchronous-in-memory and bounded, and it avoids two-way sync semantics.
- **Open questions.** Is lazy hydration, as in ArtifactFS, needed for large sources? If so, it is a core change to the payload model and should be researched on its own. Would caller-specific restricted roots (deferred) be needed for per-user pruning inside one volume?

### 8. CRDT versus single-writer

- **Exists.** Each volume serializes its mutations. The R2 live image uses `ifMatch` compare-and-set, and the writable NFS profile explicitly assumes one gateway per image with no distributed lease (`.okf/research/cloudflare-live-image-adapter-effect-ecosystem.md`).
- **Assessment.** CRDTs merge text or structured documents ([Automerge](https://automerge.org/docs/reference/documents/conflicts/), [Yjs](https://docs.yjs.dev/)). POSIX bytes with `write(offset)`, `truncate` and rename do not map onto them without inventing new semantics. The systems surveyed use one of three approaches:
  - single writer per path through delegations ([Archil](https://docs.archil.com/concepts/sharing-disks));
  - "no concurrent multi-host writes to one file" ([GeeseFS](https://github.com/yandex-cloud/geesefs));
  - fork plus later merge with recorded conflicts ([Mesa](https://docs.mesa.dev/content/concepts/versioning)).
- **Direction.** Keep single-writer per volume. Give each agent or user an overlay, and merge at path level (point 2). If live co-editing of one text file is needed, keep a Yjs/Automerge document _outside_ the VFS, for example in a Durable Object. Project it into the volume as a file on each change, and write back only through the CRDT.
- **Open question.** Is there a real consumer for simultaneous editing, or is "several agents, one repo" enough, which fork/merge covers?

### 9. FUSE export alongside NFS

- **Exists.** The NFSv4.1 export (`packages/nfs`), read-only preview plus an experimental writable R2 profile (`.okf/decisions/nfs/nfs-profile-ladder.md`). FUSE is deferred (`.okf/profiles/deferred-capabilities.md`).
- **Assessment.** Linux containers can mount NFS or FUSE. AgentFS uses both, depending on the host OS ([AgentFS](https://github.com/tursodatabase/agentfs)). A FUSE daemon would have to run _inside_ the container, next to the agent, which conflicts with a volume held in a Worker or Durable Object. The NFS gateway in `apps/demo-r2-nfs` already covers the "native tools over the volume" case.
- **Direction.** No new work until a consumer needs FUSE-specific behavior. For native tools in a container, an NFS mount of the volume is the documented path.

### 10. Things the repo already does better than, or equal to, the surveyed systems

- Byte-exact names, caller uid/gid/umask permissions, hard links, unlinked-open files and watches. These are areas where GeeseFS/tigrisfs fall short, and where just-bash's `IFileSystem` is thinner (`.okf/profiles/implemented-filesystem.md`).
- Copy-on-write overlay with a deterministic change summary, like AgentFS overlay and ArtifactFS.
- A durability vocabulary and compare-and-set live-image commits (`LiveVolume`, `R2LiveImageStore`). Archil and the FUSE adapters publish weaker or less explicit guarantees.
- An Effect-native service and layer style (`Context.Service`, `Layer`), the same idioms Alchemy's Effect code uses.

## Directions and tracking

Reviewed with the maintainer on 2026-09-24. The library stays Effect-first and does not privilege any consumer, agent framework or hosting choice. Every direction below is tracked, not accepted.

| Direction | Tracking | Position |
|---|---|---|
| 1. Agent tool surface | #175 | `apps/` example on `effect/unstable/ai`; structured tool failures; MCP from the same toolkit |
| 2. Fork and merge | #174 | Three-way, path-level, conflicts as data; no text merge; names stay with the application; no fork helper tracked |
| 3. Git or patch export | Comment on #29 | A Stream sink; a trusted host builds and pushes; no issue until there is evidence |
| 4. Search and glob | #173 | Decide between a Stream recipe over snapshots and a dedicated API, from measurement |
| 5. just-bash | Comment on #30 | Candidate runtime in the existing comparison |
| 6. Conditional writes | Comment on #31 | Revision guard under the coordination gate; digest guard later if restore or export needs it |
| 7. External services | Comment on #29 | Fixture-entry Streams into a read-only overlay base; lazy hydration is a separate core question |
| 8. CRDT | Comment on #153 | Single writer per volume, overlay per agent, path-level merge; CRDT documents stay outside the VFS |
| 9. FUSE and overlayfs over R2 | Comment on #154 | FUSE stays deferred; NFS covers native tools |
| Confinement | Comment on #28 | The agent example's hand-rolled confinement and per-user pruning elsewhere motivate a confined caller |

No outreach to Alchemy is planned from this research. It is ideation for this library only.
