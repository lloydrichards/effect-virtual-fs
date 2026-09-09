# Review corrections

The independent review after 5b4c023 found four adapter regressions and one timestamp/snapshot inconsistency despite
158 passing tests. The feature families were implemented, but the claim of no outstanding correctness work was too
strong. This follow-up addresses those findings and completes the requested peak-memory evidence.

## Behavior changes

- Recursive remove rejects root and final dot/dot-dot components before visiting children, preserving existing data.
- Copying a regular file over a symlink replaces the final link without following or modifying its target. This also
  applies to nested copies. Capacity/authority failures leave the destination unchanged.
- copyFile applies source mode to an existing destination while retaining its identity, aliases and open handles.
  Same-inode copies succeed without changing metadata or publishing events.
- Explicit live and fixture timestamps use the same signed 128-digit domain as snapshot v1. Out-of-domain values fail
  before mutation. Invalid initial Clock samples return ConfigurationError field clock.currentTimeNanos; invalid
  later samples return InvalidArgument before publication. The wire format remains unchanged.

Core writeFile has a separate WriteFileOptions type with two optional controls used by the adapter: replaceFinalSymlink
and finalMode. Both operate within the existing whole-file commit boundary. Replacement requires namespace and sticky
permission, reuses the old entry charge, and credits symlink bytes only when its final name is removed. finalMode uses
chmod authority/group rules and commits with the bytes, avoiding duplicate watcher events or a write followed by failed
chmod. Ordinary mode remains a creation option; ordinary open and no-follow behavior remain unchanged.

These are bounded whole-file operations, not a transaction API. Recursive helper sequences remain compositional.

## Regression evidence

[Recorded checks](../evidence/review-fixes/results.json) pass formatting, lint, documentation contracts, executable
models, workspace types, forced tests and builds. The 177 tests comprise 67 core, 107 adapter and three consumer
cases. Logs distinguish executed tests and cached type/build results. No dependencies or lockfile changed.
AdapterCompatibility.test.ts tests the four original defects plus root aliases, nested links, capacity failure,
quota reuse, mode authority, and event publication. Metadata.test.ts tests accepted boundary roundtrips, rejected
updates/fixtures, and Clock samples. Replacement.test.ts tests the narrow core replacement/mode controls.

The adapter and timestamp red logs record failures against the faulty production behavior. The intermediate mode
red log caught duplicate watcher events from a write-then-chmod repair; the final implementation commits both together.
The replacement-api red log reflects a missing new option, not a separately proven old API regression.

## Memory measurement

The selected installed Effect/Vite/Rolldown workload remains 2,431 files and 50,721,951 content bytes, producing
68,108,683 encoded bytes. The updated benchmark records exact package versions, deterministic traversal, preparation
time, and Node process RSS including a lifetime high-water mark. The [measurement](../evidence/review-fixes/measurement.json)
contains exact results; [consumer instructions](../../apps/virtual-build/README.md) define units and reproduction.

The measured process peak is approximately 3.10 GiB. This includes imports, host input preparation, retained fixture
buffers and the complete snapshot/restore pipeline, without forced collection. It is not core-only allocation or a
per-phase peak. This substantial copying cost is now explicit; the measurement does not establish a heap bound or
portable performance guarantee. Bun reports peak as unavailable; the recorded run uses Node 24.10.0 on macOS arm64.
