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

## Verification

From the repository root:

```sh
bun --bun run vitest run --config vitest.config.ts --project demo-agent-tools
bun run --filter @repo/agent-tools-demo type-check
```

Tests cover the public toolkit's byte/entry limits and encoding behavior, plus real stdio initialization, discovery, mutations, failures, reset, base isolation, and signal shutdown. Optional MCPJam CLI inspection:

```sh
npx -y @mcpjam/cli@latest server doctor \
  --command bun \
  --args apps/demo-agent-tools/src/mcp.ts \
  --cwd /absolute/path/to/effect-virtual-fs
```

MCPJam's CLI protocol-conformance commands are HTTP-only; `doctor` is a stdio connectivity check.
