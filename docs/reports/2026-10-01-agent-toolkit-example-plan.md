# Agent toolkit example research

Research for [issue #175](https://github.com/lloydrichards/effect-virtual-fs/issues/175), 2026-10-01. This is an implementation audit and proposed scope, not an accepted design. No application or package code changed.

## Recommendation

Build a provider-independent toolkit in a private `apps/` workspace, reuse it from the existing overlay demo, and add a stdio MCP entry point over a seeded overlay. Start with bounded UTF-8 text operations and object-shaped results. Keep HTTP hosting, resources, search, binary content, and conditional writes outside the first milestone unless the design discussion identifies a concrete need.

The goal should be a runnable teaching example: one caller, one toolkit definition, two consumers. The existing OpenAI demo demonstrates the Chat consumer; an ordinary MCP client demonstrates the server consumer. Server execution should require no model API key.

## Current implementation

- [agent.ts](../../apps/demo-overlay/src/agent.ts) defines `read_file`, `write_file`, and `list_directory`, binds handlers to a caller, and uses `failureMode: "return"`. It mixes reusable filesystem tools with role observations, Chat orchestration, and OpenAI configuration.
- Reads decode the whole file with fatal UTF-8 decoding. Writes create or truncate a whole file. Directory listings decode byte names with replacement decoding, which can lose identity for invalid UTF-8 names. Errors are strings containing code and operation, without the original path or field.
- Its lexical path check rejects absolute paths and every `..` segment, then normalizes empty and dot segments. This is an input policy, not subtree confinement through symbolic links.
- [demo.ts](../../apps/demo-overlay/src/demo.ts) already demonstrates isolated and shared overlays, watch events, captures, and restored snapshots. Preserve these teaching points when extracting the toolkit.
- [agent.test.ts](../../apps/demo-overlay/test/agent.test.ts) exercises the real tools and overlays with a scripted model. It covers isolation, shared reads, malformed UTF-8, rejected paths, watches, captures, and the turn limit. The complete demo-overlay project passed on 2026-10-01: 2 files, 7 tests. Command: `bun --bun run vitest run --config vitest.config.ts --project demo-overlay`.

The installed Effect version is `4.0.0` and the current import is `effect/ai`, not the issue's older `effect/unstable/ai`. See the companion API research for transport requirements and failure serialization.

## What core already supplies

[Caller](../../packages/core/src/VirtualFileSystem.ts) has `readFile`, `writeFile`, `readDirectory`, `stat`, `mkdir`, `remove`, `rename`, `walk`, and scoped file handles. A basic six-tool example needs no new filesystem operations.

`remove` is nonrecursive by default. Recursive removal can leave partial progress after a failure, so omit recursive deletion initially or document that result explicitly. `writeFile` creates/replaces according to explicit options, and creation does not imply creating missing parent directories.

[Metadata](../../packages/core/src/Metadata.ts) contains bigint sizes, timestamps, inode identifiers, and revisions. Map selected fields to JSON-friendly strings. Directory observations include a revision. `readFile` returns only bytes; separately reading `stat` does not establish a matching content revision under concurrent edits.

[WriteFileOptions](../../packages/core/src/Caller.ts) has no expected-revision guard. `setattr` has a revision guard, but it does not provide guarded content replacement. Do not fake compare-and-set by calling stat before write.

[VfsError](../../packages/core/src/VfsError.ts) is now a `Schema.TaggedError`, unlike the older issue description. Its encoded path preserves bytes using base64. A separate readable tool error remains useful, especially to exclude arbitrary underlying causes and distinguish input/encoding/size failures from filesystem failures.

[BytePath](../../packages/core/src/BytePath.ts) provides strict conversion and optional UTF-8 decoding. Use strict conversion or explicit encoded names; avoid silently replacing invalid filename bytes.

`Caller.withDirectory` changes the current directory, and `Caller.root` remains the volume root. Bind the first example to an entire dedicated virtual volume/overlay. Do not promise that handing in an arbitrary subtree caller establishes confinement. A symlink can reach sibling data within the same volume even when its requested path contains no `..`.

## Proposed code organization

A private `apps/demo-agent-tools` workspace would own the tool schemas, error display mapping, caller-bound handlers, fixture/overlay construction, MCP entry point, README, and protocol tests. The exact workspace name is a design choice.

Keep schemas and caller binding independent of providers, transport, roles, and presentation. Keep the old demo's role observation in an adapter around those handlers. Keep transport and runtime layers in the executable entry point, not the toolkit factory.

Suggested initial tools:

| Tool               | Behavior                                                                          |
| ------------------ | --------------------------------------------------------------------------------- |
| `read_file`        | Read bounded UTF-8 text and return a result object with content.                  |
| `write_file`       | Create or replace bounded UTF-8 text; return an acknowledgement object.           |
| `list_directory`   | Return strict text names with useful entry kinds and an explicit result bound.    |
| `stat`             | Return selected metadata, with bigint fields encoded as decimal strings.          |
| `create_directory` | Create a directory; decide whether recursive creation is exposed.                 |
| `remove`           | Remove a file, symlink, or empty directory; recursive deletion omitted initially. |

Rename can follow if the chosen scenario requires it. Search/glob should follow #173 rather than duplicate an emerging API. Read limits, write limits, and listing limits need concrete values and defined over-limit behavior. A stat-then-read size check alone is not a concurrency-safe read bound; use bounded handle reads or explicitly constrain the fixture/volume and check actual returned bytes.

Use structured failures such as `{ code, operation, message, path?, field? }`, with a deliberate policy for byte paths and separate tool input/encoding failure codes. Use object-shaped successes because MCP structured content is an object and objects leave room for paging later. The [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) defines structured content, output schemas, and execution errors; a filesystem failure should reach the client as an unsuccessful tool result rather than a broken JSON-RPC request.

## Implementation sequence and evidence

1. Agree on the example's purpose, workspace location, client, and disposable versus retained state.
2. Define the tool contracts and bounded text/name policy. Extract caller binding without changing overlay ownership.
3. Reuse the toolkit from `demo-overlay`; update its scripted model assertions to structured results and preserve all current behavior checks.
4. Add stdio server wiring and client configuration. Keep stdout exclusively for protocol messages; send any presentation/logging to stderr.
5. Exercise MCP initialize, tools/list, successful reads/writes, schema-invalid input, missing files, and tool failures through the transport. Verify an overlay write leaves base and sibling overlays unchanged and shutdown releases scopes.
6. Run one unmodified MCP client through read, edit, list, and verification. Automated protocol tests alone do not satisfy the issue's client milestone.
7. Run the affected workspaces' type checks and tests, formatting, and relevant lint checks. Extend root Vitest registration for the new app if needed. No published package change or changeset is expected for an apps-only example.

## Decisions for the grilling session

First settle the purpose and form: runnable developer tutorial or broader agent workspace application; new private app versus extending demo-overlay; chosen MCP client. Those answers determine transport, state lifetime, tool scope, and approval UX.

Next settle bounded text versus binary/paged reads, strict versus encoded names, destructive operations, and read-only versus writable exposure. Approval is a separate application policy from MCP annotation hints. See the [version-matched API research](2026-10-01-effect-ai-toolkit-api-research.md) for exact installed behavior and linked issue status.

## Agreed implementation outcome

The design discussion chose an independent app, leaving `demo-overlay` unchanged. The app has no direct Chat runner or model provider dependency; local MCPJam supplies chat. Eight tools include rename and read-only original-snapshot inspection. Each process resets its overlay; UTF-8 reads/writes are bounded at 64 KiB and listings at 200 entries. Mutations execute immediately. The [app README](../../apps/demo-agent-tools/README.md) now owns the implementation contract and walkthrough.

A real local MCPJam chat completed the release-plan walkthrough on 2026-10-01. Tool results confirmed the edited and renamed plan and original base content. Automated toolkit and stdio checks cover encoding, limits, mutations, base isolation, reset, and signal shutdown.
