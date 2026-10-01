# Effect AI toolkit and MCP API research

Research date: 2026-10-01. Scope: issue #175's API and protocol assumptions. This is source inspection, not an implementation or interoperability test.

## Findings

The installed dependency is `effect@4.0.0`. Its public AI entry point is `effect/ai`; the issue's `effect/unstable/ai` import is stale. Tool APIs retain unstable documentation tags. Use the installed package as the implementation reference. Sources: [package exports](../../node_modules/effect/package.json), [Tool](../../node_modules/effect/src/ai/Tool.ts).

`Tool.make` accepts separate parameter, success, and failure schemas plus `failureMode: "return"`. `Toolkit.make(...tools).toLayer(handlers)` supplies typed handlers. In return mode, handler failures become results with `isFailure: true`, `failureOrigin: "handler"`, and an encoded payload. Parameter validation and result validation can also produce AI errors; callers must not assume every failed tool result is a filesystem failure. Sources: [Tool failure result types, lines 850–890](../../node_modules/effect/src/ai/Tool.ts), [Toolkit execution, lines 355–465](../../node_modules/effect/src/ai/Toolkit.ts).

`McpServer.toolkit(toolkit)` registers the same handlers. Successful results contain JSON text and `structuredContent`. Returned handler failures contain JSON text and `isError: true`, with no `structuredContent`. Parameter failures are classified separately as invalid parameters; unexpected failures are reported through the server's internal error path. A plain schema-shaped failure value preserves structured fields in the JSON text; avoid passing `FsError` through unchanged. Sources: [McpServer registration, lines 1790–1975](../../node_modules/effect/src/ai/McpServer.ts), [MCP tool error distinction](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#error-handling).

Prefer object success shapes, for example `{ path, content }`, over a bare string. The installed MCP adapter contains protocol-specific normalization for string structured content; object envelopes provide a consistent shape for consumers. Source: [string normalization](../../node_modules/effect/src/ai/internal/mcpProtocol.ts). The June 2025 specification describes structured content as an object and requires supplied structured results to conform to an advertised output schema. Source: [MCP structured content and output schemas](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content).

`Tool.Readonly`, `Tool.Destructive`, `Tool.Idempotent`, and `Tool.OpenWorld` map to MCP annotation hints. `needsApproval` does **not** create a server-side approval boundary for MCP calls: registration invokes the built toolkit directly and does not consult it. The Effect `LanguageModel` path checks approval requirements and produces approval-request parts. An application must resolve these requests. Source: [MCP execution and annotations](../../node_modules/effect/src/ai/McpServer.ts), [LanguageModel approval execution, around line 1604](../../node_modules/effect/src/ai/LanguageModel.ts). MCP clients decide their own confirmation behavior, and annotations are hints whose trust depends on the server. Source: [MCP tool annotations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool).

Stdio requires `McpServer.layerStdio({ name, version, protocols })` and a platform `Stdio` layer. `protocols` is a required nonempty array; installed adapters include `McpProtocol.v2025_06_18`, `v2025_11_25`, and `v2026_07_28`. Bun and Node provide `BunStdio.layer` and `NodeStdio.layer`. HTTP requires `path`, the same protocol selection, and `HttpRouter`; serving it also requires a concrete HTTP server. HTTP configuration supports `allowedOrigins`. Sources: [McpServer transports, lines 1437–1590](../../node_modules/effect/src/ai/McpServer.ts), [protocol adapters](../../node_modules/effect/src/ai/McpProtocol.ts), [BunStdio](../../node_modules/@effect/platform-bun/src/BunStdio.ts), [NodeStdio](../../node_modules/@effect/platform-node/src/NodeStdio.ts).

For a first local-client example, stdio minimizes hosting decisions. Keep protocol messages on stdout and diagnostics elsewhere. Directory listings can remain tools: MCP resources are a separate optional feature and are not necessary for toolkit registration. Sources: [stdio transport contract](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#stdio), [installed toolkit registration](../../node_modules/effect/src/ai/McpServer.ts).

## Related issue status

All three linked issues remain open as checked through GitHub on the research date:

- [#28: confined callers](https://github.com/lloydrichards/effect-virtual-fs/issues/28) remains a design discussion, including symbolic links, directory identity, hard links, and preexisting handles. A lexical path-prefix check must not be presented as its substitute.
- [#31: revisions and conditional mutations](https://github.com/lloydrichards/effect-virtual-fs/issues/31) leaves revision representation open and explicitly allows a first milestone without conditional writes. Do not promise guarded writes or invent timestamp-based revision tokens.
- [#173: search and glob](https://github.com/lloydrichards/effect-virtual-fs/issues/173) calls for measuring a snapshot-stream recipe before choosing a shared API. Its illustrated `Glob.matches` and `Search.grep` do not exist.

## Recommended first milestone and decisions

Build reusable tool definitions and `handlersFor(caller)` inside an app example. Use object-shaped successes and a separate display failure schema. Demonstrate an overlay through a local stdio MCP server and one unchanged client. Keep the initial transport provider-free. Add a separate direct `Chat` demonstration only if it serves the example's teaching goal.

Decide the tool set, read size/encoding policy, mutation approval experience, and example presentation before implementation. Start with read, write, list, stat, mkdir, and remove; defer rename and search unless the intended task needs them. This is a recommendation, not an existing contract.

The main uncertainty is client behavior across selected protocol versions and failure payloads. Before declaring the example complete, test initialization, discovery, successful reads/writes, a missing-file failure, and overlay isolation through the chosen unchanged client. Verify approval behavior independently for direct Effect Chat and MCP, since they use different execution paths.
