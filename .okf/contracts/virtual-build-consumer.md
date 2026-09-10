---
type: Contract
title: Virtual build consumer
description: Defines the bounded build and package-import scenario used to prove the core is useful outside the memory adapter.
status: stable
tags: [build, consumer, packages]
sources:
  - resource: ../../apps/virtual-build
    title: Virtual build consumer application
  - resource: ../../packages/core/test/VirtualFileSystem.test.ts
    title: Core behavior tests
generated: { by: codex/okf, at: 2026-09-10T00:00:00Z }
---

# Virtual build consumer

The acceptance boundary demonstrates explicit build and rebuild calls against a virtual filesystem, including a bounded package import from virtual `node_modules`. It proves a concrete consumer can use the core directly; it does not promise general package installation, arbitrary plugins, automatic rebuild watches, or full Node filesystem compatibility.

This contract [implements virtual package acceptance](/decisions/virtual-package-resolution-acceptance.md "implements") and [explicit build rebuilds](/decisions/explicit-build-rebuilds.md "implements"), within the [package dependency model](/architecture/package-dependency-model.md "depends on").
