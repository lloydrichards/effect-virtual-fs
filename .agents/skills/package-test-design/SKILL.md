---
name: package-test-design
description: Design, review, or consolidate package, demo, and docs tests in effect-virtual-fs. Use to decide what a test should prove, where it belongs, or whether to keep it.
---

# Test design

- Test what a caller can observe through the smallest public entry point that exposes the failure.
- Start with one documented journey per demo or interactive example. Add a case when it catches a distinct failure that journey cannot reach.
- Before removing a case, identify the stronger check that catches the same failure or explain why the behavior needs no lasting check. Preserve unique regressions.

## Read the reference for the work

Read only the references that match the task. A review can span more than one test type.

- [Package tests](references/package-tests.md) for exported modules, shared contracts, protocols, and runtime qualification.
- [Demo tests](references/demo-tests.md) for CLI, HTTP, and MCP walkthroughs, local fixtures, and app-specific failures.
- [Docs content checks](references/docs-content.md) for generated references, internal links, and published snippets.
- [Browser tests](references/browser-tests.md) for the built site, interactive examples, and browser-specific behavior.
