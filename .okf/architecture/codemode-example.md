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
generated: { by: codex/okf, at: 2026-10-20T00:00:00+02:00 }
---

# Code Mode example ownership

The private `apps/demo-agent-tools` application has a separate `codemode-mcp.ts` entry point. Effect's `McpServer` exposes `execute`, `inspect_run`, and `inspect_base`. OpenCode interprets the submitted JavaScript subset; four schema-defined guest tools invoke the existing Effect filesystem handlers directly. They do not make nested MCP calls. This is an application-level example, not a published runtime or core filesystem feature.[^execution][^transport]

## Execution and capture

The server creates one immutable seeded base. Each admitted execution acquires a serialization permit, creates a fresh overlay, and obtains a caller rooted at `/projects/release`. Only read, write, list, and stat are supplied to the guest. No volume owner, caller identity, file handle, or Effect runtime crosses into guest data. Project-relative path validation supplements identity-rooted caller confinement.[^execution][^fixture]

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

Program failure and cooperative timeout return an interpreter diagnostic and still capture completed writes. External Effect interruption propagates and skips capture and run retention. Tests verify that an interrupted execution consumes no run ID or retention slot, and that timeout captures an awaited write without exposing it to the base or next execution.[^tests]

## Inspection and retention

`inspect_run` selects a private retained snapshot by run ID. `inspect_base` selects the original snapshot. Both restore an independent temporary volume, obtain a rooted caller, and reuse the read/list/stat handlers. Inspection cannot change retained snapshots through access metadata. Inspection returns bounded text or metadata rather than exporting the full volume.[^execution]

The process serializes executions and retains at most eight runs with no eviction. Restart clears run IDs and artifacts. There is no persistence, publication, merge, remote workspace, or durable replay policy in this example.[^execution]

## Runtime and authority boundaries

The host is TypeScript with Effect. The guest is OpenCode's JavaScript subset, not arbitrary TypeScript, Node, npm modules, or guest Effect. The example pins `@opencode/codemode@2.1.1` while the repository's existing Effect override resolves `4.0.0`; the upstream package declares `4.0.1`. Tests qualify this combination only. Dependency upgrades must repeat the example's checks.[^usage]

Application policies bound source to 8 KiB, calls including discovery to 32, cooperative execution time to five seconds, and retained interpreter output to 16 KiB. Each overlay allows 256 KiB of content, 64 KiB per file, 128 entries, and 16 pending VFS operations. Existing text tools limit reads/writes to 64 KiB and listings to 200 entries.[^execution][^usage]

VFS quotas constrain filesystem operations, not the interpreter heap. The in-process interpreter supplies no separate process or hard CPU boundary, and output truncation follows result accumulation. Successful timeout and unavailable-global tests do not establish containment against hostile code. Runtime alternatives and remaining investigation belong to the linked issue rather than this implemented architecture.[^research]

The example is [constrained by system boundaries](system-boundaries.md "constrained by"), uses [confined callers](../contracts/confined-callers.md "depends on"), and retains [overlay captures](../contracts/overlay-workspaces.md "depends on").

[^execution]: `codemode.ts` defines the four guest adapters, scoped execution and capture, retained run map, and snapshot-based inspection.

[^transport]: `codemode-mcp.ts` registers `CodeModeTools` and their handlers with `McpServer.layerStdio`.

[^fixture]: `workspace.ts` seeds the immutable template and exports its project root.

[^tests]: `codemode.test.ts` exercises public handler results, captured contents, base isolation, timeout recovery, and externally interrupted retention.

[^usage]: The example README records the pinned dependency combination, guest restrictions, and configured limits.

[^research]: The linked issue comment retains source-based interpreter limitations and unimplemented runtime alternatives.
