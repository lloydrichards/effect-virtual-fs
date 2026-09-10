---
type: Decision
title: Provisional path limits
description: Retains provisional component and symlink limits while rejecting an unmeasured fixed total-path default.
status: stable
tags: [paths, limits, measurement]
generated: { by: codex/okf, at: "2026-09-10T00:00:00Z" }
---

# Provisional path limits

The engineering defaults are 255 bytes per filename component and 40 symlink traversals per lookup. They are provisional bounds, not workload measurements or broad compatibility promises.

The earlier proposed fixed 4096-byte total-path limit was explicitly rejected pending measurement. The later [optional total path limit](./optional-total-path-limit.md "refined by") resolves total-path policy without changing the provisional component and traversal defaults.
