---
type: Research
title: Trusted program execution with virtual workspaces
description: Compares existing browser, Node, and explicit-capability examples and identifies the remaining execution experiment.
status: draft
tags: [runtime, node, browser, overlays]
sources:
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/30
    title: Execution approaches and comparison criteria
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/30#issuecomment-6298896502
    title: Earlier Code Mode experiment and its limitations
  - resource: ../../apps/docs/app/lib/playground/build.ts
    title: Browser bundler's virtual file reads
  - resource: ../../apps/docs/app/lib/playground/run.ts
    title: Browser reply deadline and resource finalizer
  - resource: ../../apps/docs/app/lib/playground/runner.html
    title: Browser worker and its content security policy
  - resource: ../../apps/docs/test/browser/commands.ts
    title: Checkpoint restore, timeout cleanup, and recovery checks
  - resource: ../../apps/demo-typescript-workbench/docs/qualification.md
    title: Trusted local mounted compiler and execution evidence
  - resource: ../../apps/demo-agent-tools/README.md
    title: Interpreter workload, per-run overlay, and capture
  - resource: ../contracts/node-mounted.md
    title: Experimental mount qualification and cleanup
  - resource: ../contracts/resources-and-authority.md
    title: Scope and caller authority
  - resource: ../contracts/tree-transfer.md
    title: Bounded export and import fidelity
---

# Trusted program execution with virtual workspaces

Existing examples cover three different kinds of filesystem access. The browser translates virtual source reads into
one bundle. The mounted workbench lets trusted Node code address files through normal compiler and loader paths.
The [Code Mode interpreter](../architecture/codemode-example.md "compares") exposes selected file operations and captures the changes they make. Each example exercises a
different workload, so their tests establish behavior for their own integration.

### Docs playground

The browser bundler resolves virtual JavaScript paths through the selected caller. Editor commands write the workspace,
while the worker receives only the compiled bundle and replies with console lines and an optional error. It runs inside
a sandboxed iframe with scripts enabled, no same-origin grant, and a restrictive content security policy.

The host uses a five-second reply deadline. An Effect finalizer removes the iframe and closes both message ports. The
Chromium suite observes frame removal after timeout and verifies that another run succeeds. CPU and heap
use, direct worker termination, and isolation across browsers remain unmeasured.

### TypeScript workbench

TypeScript 5.9.3 uses its default host through an experimental, worker-local Node mount. The compiler writes emitted
files to the overlay. The run observes a trusted synchronous CommonJS entrypoint, and a viewer caller prevents edits
to mounted source. That caller governs virtual filesystem operations. Node retains its ordinary host authority.

The coordinator keeps a save point outside the worker. Stop and execution timeout replace the worker and restore that
save point. Tests cover worker shutdown, mount routing removal, unmount failure, and CommonJS cache cleanup.

### Code Mode demo

An interpreter runs a JavaScript subset and calls schema-defined file tools with a caller rooted inside a per-run
overlay. Awaited tool calls can read and write the overlay. After interpreter cleanup, the host captures matching
snapshot and change summary, leaving the base separate. Documented tests cover completed runs, failures, timeouts,
and MCP cancellation. Retained snapshots contain file state.

The interpreter shares the host process's heap and CPU. Output capture limits bound returned text. Hard resource and
host access limits belong to the runtime or deployment environment.

## A common comparison workload

For an application that accepts trusted workspace programs and needs their file edits, start with a small JavaScript
workload. Read a UTF-8 input file, replace one line, and write a short report to a second path. Obtain the input and
expected output from one fixed snapshot fixture. Record file bytes and a final change set. This first comparison does
not require a native binary or arbitrary npm packages. It leaves the browser demo's read-only execution unchanged.

- For explicit access, use the Code Mode tool contract as the reference. Give the program only the required file
  operations and retain the overlay capture after host calls settle. A WASI implementation would need its own mapping
  and qualification before making claims about existing binaries.
- For mounted execution, use the current Node workbench as evidence for compile, load, and cleanup. A writable
  execution experiment needs a separately constructed, run-owned overlay and a caller permitted to edit only the test
  workspace. Keep the existing viewer path in the workbench.
- For copy-in and copy-out, compare bounded tree transfer using an independently isolated process. Decide which file
  bytes, metadata, and link types must round-trip and whether to reject degraded transfer. Changes become candidates
  for review after collection. Live mount edits and explicit tool writes are visible to the run immediately. No
  isolated copy-based program run is covered by the existing examples.

Keep each experiment's base unchanged and report cold setup, execution, and cleanup separately. Observe how an accepted
write behaves on success, cancellation, or deadline. Check that descendants, handles, mounts, and host request fibers
owned by the run have released before capture or replacement, as appropriate to the integration. Compare permissions
using only the test workspace and designated synthetic fixtures. A separate execution-boundary qualification must
establish what host resources are available and how the runtime limits CPU, memory, process creation, and networking.
Use a controlled deployment before considering untrusted programs.

The first interface decision belongs to the application that owns the experiment. The demonstrated outputs are
console replies, emitted files, and captured filesystem changes. A shared command API, native binary support, and
execution isolation claims remain open in #30.
