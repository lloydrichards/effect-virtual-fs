---
type: Architecture
title: Code Mode example ownership
description: Defines the private OpenCode MCP example's per-execution workspace, captured inspection, failure policy, and runtime limits.
status: stable
tags: [examples, agents, execution, overlays, mcp]
sources:
  - id: execution
    resource: ../../apps/demo-agent-tools/src/codemode.ts
    title: Execution, guest tools, capture, and inspection
  - id: handoff
    resource: ../../apps/demo-agent-tools/src/combine-runs.ts
    title: Conflict preview and handoff
  - id: transport
    resource: ../../apps/demo-agent-tools/src/codemode-mcp.ts
    title: Effect McpServer stdio entry point
  - id: fixture
    resource: ../../apps/demo-agent-tools/src/workspace.ts
    title: Seeded base snapshot and project root
  - id: tests
    resource: ../../apps/demo-agent-tools/test/codemode.test.ts
    title: Workspace isolation, failure capture, interruption, and limits
  - id: mcp-tests
    resource: ../../apps/demo-agent-tools/test/mcp.test.ts
    title: Real stdio MCP execution and inspection
  - id: usage
    resource: ../../apps/demo-agent-tools/README.md
    title: Runnable example and tool contracts
  - id: research
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/30#issuecomment-6298896502
    title: Execution research, alternatives, and remaining investigation
generated: { by: codex/okf, at: "2026-11-19T09:47:20+01:00" }
---

# Code Mode example ownership

The private `apps/demo-agent-tools` application has a separate `codemode-mcp.ts` entry point. Effect's `McpServer` exposes `execute`, `inspect_run`, `inspect_base`, and `combine_runs`. OpenCode interprets the submitted JavaScript subset; schema-defined guest tools invoke the existing Effect filesystem handlers directly. They do not make nested MCP calls. This is an application-level example, not a published runtime or core filesystem feature.[^execution][^transport]

## Execution and capture

The server creates one immutable seeded base. Each admitted execution acquires a serialization permit, creates a fresh overlay, and obtains a caller rooted at `/projects/release`. The guest can read, write, rename, list, and stat within its workspace. No volume owner, caller identity, file handle, or Effect runtime crosses into guest data. Project-relative path validation supplements identity-rooted caller confinement.[^execution][^fixture]

```text
execute(code)
  makeOverlay(base)
  caller.withRoot(projectRoot)
  CodeMode.make(tools bound to caller).execute(code)
  overlay.capture()
  retain snapshot + execution result + final changes by run ID
```

Capture follows interpreter completion and its scoped pending-work cleanup. The snapshot and change summary describe one final workspace state; they are not an operation journal. Nothing is merged into the base. The scoped mutable overlay is released while the snapshot remains retained.[^execution]

## Failure and interruption policy

An expected filesystem failure becomes `{ ok: false, error }` inside a guest tool result. The script decides whether to handle or throw it. Interpreter completion is separate from task success: `execution.ok` can be true while its returned value contains a tool failure, and warnings or truncation require caller interpretation.[^execution]

Program failure and cooperative timeout return an interpreter diagnostic and still capture completed writes. External Effect interruption propagates and skips capture and run retention. Tests verify that an interrupted execution consumes no run ID or retention slot, and that timeout captures an awaited write without exposing it to the base or next execution. A real stdio cancellation test verifies that an MCP client can cancel an execution request and then obtain a fresh run without a retained artifact.[^mcp-tests][^tests]

## Inspection and retention

`inspect_run` selects a private retained snapshot by run ID. `inspect_base` selects the original snapshot. Both restore an independent temporary volume, obtain a rooted caller, and reuse the read/list/stat handlers. Inspection cannot change retained snapshots through access metadata. Inspection returns bounded text or metadata rather than exporting the full volume.[^execution]

The process serializes executions and retains at most eight runs with no eviction. Restart clears run IDs and artifacts. Runs and captures are process-local.[^execution]

## Release handoff

Each successful execution saves a core-issued merge capture in its retained run record. The handler merges two retained captures against the server's base. It returns a preview delta with conflict groups while choices remain open and a handoff delta after every group has a choice. Each retry sends all choices so far. Core owns conflict keys and resolution rules.[^handoff][^mcp-tests]

Run IDs belong to one server instance. A restart expires the runs and conflict keys. The [rename-aware merge proposal](../research/overlay-rename-merge.md) records the packed walkthrough and release gate.

## Runtime and authority boundaries

The host is TypeScript with Effect. The guest is OpenCode's JavaScript subset, not arbitrary TypeScript, Node, npm modules, or guest Effect. The example pins `@opencode/codemode@2.2.7` and Effect `4.1.4`. Test evidence applies to the pinned versions. Dependency upgrades must repeat the example's checks.[^usage]

Application policies bound source to 8 KiB, calls including discovery to 32, cooperative execution time to five seconds, and the interpreter’s return-value/log budget to 16 KiB with a separate warning budget. The host caps failure messages at 2 KiB of UTF-8 and sets `execution.truncated` when shortening them. These are separate payload budgets, not a cap on the complete MCP response. Each overlay allows 256 KiB of content, 64 KiB per file, 128 entries, and 16 pending VFS operations. Existing text tools limit reads/writes to 64 KiB and listings to 200 entries.[^execution][^usage]

VFS quotas constrain filesystem operations, not the interpreter heap. The in-process interpreter supplies no separate process or hard CPU boundary, and output truncation follows result accumulation. Successful timeout and unavailable-global tests do not establish containment against hostile code. Runtime alternatives and remaining investigation belong to the linked issue rather than this implemented architecture.[^research]

The example is [constrained by system boundaries](system-boundaries.md "constrained by"), uses [confined callers](../contracts/confined-callers.md "depends on"), and retains [overlay captures](../contracts/overlay-workspaces.md "depends on").

[^execution]: `codemode.ts` defines the guest adapters, scoped execution and capture, retained run map, and snapshot-based inspection.

[^transport]: `codemode-mcp.ts` starts `McpServer.layerStdio`.

[^handoff]: `combine-runs.ts` looks up retained merge captures, calls core, and maps the result to a preview or handoff response.

[^fixture]: `workspace.ts` seeds the immutable template and exports its project root.

[^tests]: `codemode.test.ts` exercises public handler results, captured contents, base isolation, timeout recovery, and externally interrupted retention.

[^usage]: The example README records the pinned dependency combination, guest restrictions, and configured limits.

[^research]: The linked issue comment retains source-based interpreter limitations and unimplemented runtime alternatives.

[^mcp-tests]: `mcp.test.ts` sends `notifications/cancelled` for an execution request and verifies missing retained state, unchanged base, and that cancellation consumes no run ID. The packed walkthrough exercises merge preview, incremental resolution, and rejection of old run IDs in a fresh process.
