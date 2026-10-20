# Caller-bound filesystem tools over MCP

This independent example turns an Effect VFS caller into a typed `Toolkit`, then serves it over stdio with Effect's `McpServer`. Try the tools and chat in local MCPJam. The server has no model provider dependency and needs no API key.

Each server process creates a fresh overlay from a seeded snapshot. The project lives at `/projects/release`;
rooted callers expose it to both the editing tools and `inspect_base` as `/`. Volume-level orchestration data stays
outside that project view. Edits affect that overlay. `inspect_base` reads a separate restored copy of the original snapshot. Restarting the server discards all edits. Each connection that launches its own process gets its own workspace.

## Connect MCPJam

From the repository root, install dependencies and build core if its declarations are not already available:

```sh
bun install
bun run --filter @effect-vfs/core build
npx @mcpjam/inspector@latest
```

Open local MCPJam, choose **Add server**, and select **STDIO**. Use `bun` as the command and the absolute path to `apps/demo-agent-tools/src/mcp.ts` as its argument. If the UI presents a single command field, use:

```sh
bun /absolute/path/to/effect-virtual-fs/apps/demo-agent-tools/src/mcp.ts
```

Use the actual checkout path. An absolute entry point does not depend on MCPJam's working directory. You can also run `bun run --filter @repo/agent-tools-demo start` from the repository root, but that is a protocol server, not an interactive terminal program. Keep its stdout reserved for MCP messages.

The [local MCPJam Inspector and desktop app](https://docs.mcpjam.com/getting-started) support stdio. The hosted MCPJam web app requires HTTPS and cannot launch this local process. MCPJam supplies the chat model; its account and model availability are separate from this server.

## Try the release-plan task

Connect the server, open MCPJam's Playground, enable its tools, and send:

> Read BRIEF.md and plans/draft.md. Create release/friday, update the draft to include passing tests and a rollback step, then rename it to release/friday/plan.md. Remove temporary.txt. List the resulting directories and inspect the plan's metadata. Use inspect_base to read plans/draft.md and list the original root, proving the base still has the original draft and temporary file. Summarize what changed.

Expected results:

- `release/friday/plan.md` contains the completed plan.
- The overlay no longer has `plans/draft.md` or `temporary.txt`.
- `inspect_base` still reads the original draft and lists `temporary.txt`.
- Stopping and reconnecting the server restores the initial files.

If chat does not invoke a tool, use the Playground's manual tool controls. For example, call `read_file` with `{ "path": "BRIEF.md" }`, then `inspect_base` with `{ "path": "plans/draft.md", "action": "read" }`.

## Tool contract

Paths are relative to the virtual project root. Use `.` for the root. Absolute paths, `..` segments, NUL, and malformed Unicode are rejected. Empty and dot segments are normalized. These tools use `withRoot`, so absolute symbolic-link targets also begin at the assigned project root. Renaming the project directory preserves the tool view. No host filesystem paths are exposed.

| Tool               | Parameters                         | Result and behavior                                                                         |
| ------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `read_file`        | `path`                             | `{ path, content }`; strict UTF-8, at most 64 KiB.                                          |
| `write_file`       | `path`, `content`                  | `{ path, message }`; create or replace, at most 64 KiB of encoded bytes; parent must exist. |
| `list_directory`   | `path`                             | `{ path, entries }`; names and kinds, at most 200 entries.                                  |
| `stat`             | `path`                             | Path, kind, size, numeric permission mode, and `mtimeNs`; follows final symlinks.           |
| `create_directory` | `path`                             | `{ path, message }`; creates missing parents.                                               |
| `remove`           | `path`                             | `{ path, message }`; removes files, symlinks, or empty directories; missing paths fail.     |
| `rename`           | `from`, `to`                       | `{ from, to, message }`; replaces a compatible destination under VFS rules.                 |
| `inspect_base`     | `path`, `action: "read" \| "list"` | Original snapshot content or listing, with the same limits.                                 |

Size and modification time are decimal strings. `mtimeNs` is Unix time in nanoseconds; `mode` is the numeric POSIX permission bitmask. Listings report a symlink as a symlink. Invalid UTF-8 names fail the listing rather than return altered names. Over-limit reads and listings fail rather than truncate results.

Failures have `{ code, operation, message, path?, field? }`. Filesystem codes such as `NotFound` remain intact; `InvalidToolPath`, `InvalidTextEncoding`, `InvalidNameEncoding`, `TextLimitExceeded`, and `DirectoryLimitExceeded` describe example-specific failures. Byte paths that cannot be displayed as UTF-8 are omitted from error display. Internal causes are excluded. MCP returns declared handler failures as JSON text with `isError: true`; successful calls include `structuredContent` and JSON text.

Mutations execute immediately. MCP annotations describe read-only and destructive behavior; they do not enforce approval. This example has no conditional writes, recursive deletion, search, binary transfer, persistence, HTTP hosting, or shell execution. It demonstrates virtual filesystem ownership, not a process sandbox.

## Read the implementation

- [workspace.ts](src/workspace.ts) builds the fixture, snapshot, overlay, and original reader.
- [tools.ts](src/tools.ts) defines schemas, annotations, display failures, and caller-bound handlers. `VolumeTools.toLayer(handlersFor(caller, baseCaller))` binds explicit capabilities without a provider or transport dependency.
- [mcp.ts](src/mcp.ts) supplies Bun crypto and stdio, selects MCP protocols, and manages the server scope.

The installed Effect entry point is `effect/ai`. The server supports MCP `2025-11-25` and `2025-06-18`.

## Try the OpenCode Code Mode prototype

Use the same MCPJam stdio setup with `apps/demo-agent-tools/src/codemode-mcp.ts` as the entry point:

```sh
bun /absolute/path/to/effect-virtual-fs/apps/demo-agent-tools/src/codemode-mcp.ts
```

From the repository root, `bun run --filter @repo/agent-tools-demo start:codemode` starts the same server. It uses the
pinned `@opencode/codemode@2.1.1` interpreter with the repository's Effect `4.0.0` override. No model API key is needed
by the server. The upstream package declares Effect `4.0.1`; this example qualifies only the overridden `4.0.0`
combination. Repeat its tests and type-check when upgrading either dependency.

The server exposes three MCP tools:

| Tool           | Arguments                                             | Result                                                                   |
| -------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| `execute`      | `{ code }`                                            | `{ runId, execution, changes }` from a fresh overlay of the seeded base. |
| `inspect_run`  | `{ runId, path, action: "read" \| "list" \| "stat" }` | Saved run result and changes, plus the inspected `entry`.                |
| `inspect_base` | `{ path, action: "read" \| "list" \| "stat" }`        | Original file content, listing, or metadata.                             |

The host connects the components in this order:

```text
McpServer execute handler
  fresh VFS overlay from the base snapshot
  caller rooted at /projects/release
  OpenCode interpreter with four caller-bound Effect tools
  await execution and scoped cleanup
  capture snapshot + final changes, retain by run ID
```

The script's filesystem calls invoke the Effect handlers directly within this process. They do not make nested MCP
requests. Inspection restores a temporary volume from the retained snapshot, so reads cannot change that snapshot.

Inside `execute`, the model can use only these workspace tools and the interpreter's built-ins:

```js
tools.workspace.read_file({ path })
tools.workspace.write_file({ path, content })
tools.workspace.list_directory({ path })
tools.workspace.stat({ path })
```

Each returns `{ ok: true, value }` or `{ ok: false, error }`. `search({ query })` discovers their signatures. Paths and
the text/encoding policies match the ordinary demo. Writes require an existing parent directory.

Call `execute` with this JavaScript as its `code` argument:

```js
const draft = await tools.workspace.read_file({ path: "plans/draft.md" })
if (!draft.ok) throw new Error(draft.error.message)

const updated = await tools.workspace.write_file({
  path: "plans/draft.md",
  content: draft.value.content + "\nRun tests before release. Keep a rollback step.\n"
})
if (!updated.ok) throw new Error(updated.error.message)

const report = await tools.workspace.write_file({ path: "report.txt", content: "Release plan updated for review.\n" })
if (!report.ok) throw new Error(report.error.message)

return { report: "report.txt", plan: await tools.workspace.stat({ path: "plans/draft.md" }) }
```

The response includes an `Added` change for `report.txt` and an `Updated` change for `plans/draft.md`. Use its returned
run ID in these calls:

```json
{ "runId": "1", "path": "report.txt", "action": "read" }
```

Send that to `inspect_run`. Send `{ "path": "plans/draft.md", "action": "read" }` to `inspect_base` to see the original
draft. A second `execute` starts from that original draft and cannot see the first run's `report.txt`. Previous runs
remain inspectable. Changes describe final file differences, not the history of tool calls, and omit timestamp-only
differences.

Program diagnostics use `execution.ok: false` inside a successful MCP response. Expected filesystem failures appear
inside the workspace tool's outcome. Invalid outer requests and inspection failures are MCP tool errors. A failed
program can have partial writes; its captured result remains inspectable. Nothing is merged into the base. An
externally interrupted execution is discarded and consumes no retained-run slot.

To inspect a partial result, execute:

```js
const saved = await tools.workspace.write_file({ path: "partial.txt", content: "Written before failure.\n" })
if (!saved.ok) throw new Error(saved.error.message)
throw new Error("Deliberate failure after write")
```

The response has `execution.ok: false` with `ExecutionFailure` and an `Added` change for `partial.txt`.
`inspect_run` can still read it; `inspect_base` returns `NotFound`. Replace the final `throw` with `while (true) {}`
to trigger `TimeoutExceeded` after five seconds with the same capture policy. Await the write so the test does not
race it against termination.

Executions are serialized. The process retains at most eight captured runs and rejects further executions until
restart. Each overlay allows 256 KiB of file content, 64 KiB per file, 128 entries, and 16 pending filesystem
operations. A script is limited to 8 KiB of source, 32 admitted calls including discovery, a five-second cooperative
timeout, and the interpreter’s 16 KiB return-value and log budget, with a separate warning budget. The host caps
failure messages at 2 KiB of UTF-8 and marks shortened diagnostics with `execution.truncated`. These limits do not
bound the complete MCP response size. Inspection reads still use the 64 KiB text limit. Restarting
discards all run IDs and artifacts.

This is the interpreter's JavaScript subset. TypeScript annotations, imports, shell commands, and network access
are unavailable. Await required writes. Output truncation is reported by `execution.truncated`, and warnings can
accompany success. The in-process interpreter has no isolated heap or hard CPU boundary. Its cooperative timeout
and output truncation do not provide those guarantees.

[`codemode.ts`](src/codemode.ts) owns execution and inspection. [`codemode-mcp.ts`](src/codemode-mcp.ts) supplies the
stdio transport. The original MCP entry point and tools remain available for comparison.

## Verification

From the repository root:

```sh
bun --bun run vitest run --config vitest.config.ts --project demo-agent-tools
bun run --filter @repo/agent-tools-demo type-check
```

Tests cover the public toolkit's byte/entry limits and encoding behavior, plus real stdio initialization, discovery, mutations, failures, reset, base isolation, and signal shutdown. Code Mode checks additionally cover per-execution isolation, retained partial writes after failure and timeout, external interruption and MCP cancellation without retention, recovery, exact byte boundaries, bounded failure diagnostics, and capacity limits. Optional MCPJam CLI inspection:

```sh
npx -y @mcpjam/cli@latest server doctor \
  --command bun \
  --args apps/demo-agent-tools/src/mcp.ts \
  --cwd /absolute/path/to/effect-virtual-fs
```

MCPJam's CLI protocol-conformance commands are HTTP-only; `doctor` is a stdio connectivity check.
