---
type: Architecture
title: Volume, caller, and handle model
description: Assigns live filesystem state to the Effect preview while core preserves existing capability contracts and immutable snapshot formats.
status: stable
tags: [architecture, state, authority, resources]
sources:
  - resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Existing public core capabilities
  - resource: ../../packages/core/src/internal/model.ts
    title: Core schemas, errors, paths, and immutable snapshot representation
  - resource: ../../packages/core/src/internal/runtime.ts
    title: Core adaptation to the sole preview runtime
  - resource: ../../packages/core/src/internal/synchronous.ts
    title: Native adaptation to the same preview owner
  - resource: ../../packages/core/src/internal/virtualFileSystem.ts
    title: Constructors without a community engine alternative
  - resource: ../../packages/core/compatibility/preview-imports/check.mjs
    title: Sole-preview source import qualification
  - resource: ../../packages/core/test/PreviewRuntime.test.ts
    title: Constructor and native ownership regressions
  - resource: ../../packages/core/test/Execution.test.ts
    title: Execution checks through the existing constructors
  - resource: ../../packages/effect-preview/src/virtual-file-system/VirtualFileSystem.ts
    title: Preview owner, caller, operation, and handle contracts
generated: { by: codex/okf, at: "2026-11-15T20:01:17+00:00" }
---

# Volume, caller, and handle model

The Effect virtual filesystem in the one private preview package owns the live namespace, buffers, object identities, permissions, transactional publication and scoped resources. Core has one implementation path through that preview. The former private engine, community volume/overlay implementations, watch delivery hub, adapter registry, native fallback, and baseline comparison runner are removed.

Core preserves the existing public volume, caller, target, metadata, reference-key, and handle contracts. Its runtime translates those contracts onto the preview's public operations. Rooted references and imported handles retain the existing confinement rules. This adaptation does not maintain a second namespace or an alternative filesystem engine.

`internal/model.ts` contains shared schemas, errors, path validation, and immutable data needed by core snapshot formats. These records are assembled from public preview capture records and restored through the preview. They support the unchanged image, fixture, search, delta and merge packages; they are not a live mutation engine. The old resolver, token registry, turnstile, inode draft and persistent live directory-slot implementation are gone.

Existing memory and Node production packages consume core's capabilities. The native adapter binds directly to the same preview owner; no legacy binding is available when a volume fails qualification. The core build clears stale output and audits constructor/native imports so removed engine modules cannot survive in the package artifact.

## Tests and missing behavior

Public behavioral assertions remain the acceptance contract. Runtime tests that used old private contexts now use core constructors. White-box tests for the deleted token registry, resolver and installation callbacks retire with those implementations; their removal is not a compatibility fix. Immutable snapshot ownership tests remain relevant and retained. The upstream preview suite qualifies its actual resolver and resource implementation.

Watches, durable commit integration, shared overlays and remaining metadata/publication gaps fail explicitly through the sole runtime. The [drop-in evaluation](../research/preview-drop-in.md "evidenced by") records these gaps. A passing build or fewer obsolete private tests does not establish replacement compatibility.

The public [confined caller contract](../contracts/confined-callers.md "constrained by") and [memory adapter contract](../contracts/memory-adapter-compatibility.md "constrained by") retain their expected behavior during the replacement.
