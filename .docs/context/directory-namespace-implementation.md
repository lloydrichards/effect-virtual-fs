# Directory rename and removal

Status: implemented locally, 9 September 2026. This extends the private directory core. File I/O, links,
fixtures, snapshots, core-backed memory adaptation, and build consumers remain absent.

## Contract and choices

The user authorized continued implementation on `codex/vfs-core-foundation`, with validated commits and no push.
The initial tree was clean. GitButler confirmed that branch applied above the three requested starting commits.

`Caller.rename` takes source/destination paths and independent `sourceRelativeTo` / `destinationRelativeTo`
directory bases. Existing absolute-path, authority, byte-path, liveness, and coordination contracts apply to each
path. It moves directory identity, updates ancestry, and replaces empty destination directories. It rejects cycles,
nonempty replacements, roots, and final dot/dot-dot components before publication. A trailing-slash destination
must already exist. Same-entry rename is a no-op after path and parent permission checks.

`Caller.rmdir` removes empty directories, releases one entry charge, and updates parent link count and timestamps.
A retained removed directory has zero links. Its live handles can still stat and close; relative lookup and creation
fail with NotFound, including dot/dot-dot. A retained caller can still resolve absolute paths. Removal of a referenced
cwd is allowed; root removal is rejected. These choices avoid redirecting a removed cwd to another directory.

Sticky-directory checks use parent owner, affected entry owner, or explicit privilege. There is no optional
writable-entry exception. Rename requires write/search on both parents but no additional write permission on the
moved directory. Replacing a directory checks sticky authorization for that destination too. NotEmpty represents
nonempty removal/replacement; InvalidArgument represents root, final dot/dot-dot, and ancestor-cycle rejection.

These are implementation choices within the bounded namespace slice, not acceptance of unrelated I/O or snapshot
proposals. Core remains private. Later file/link support must extend these operations' kind and symlink handling.

## Source and behavioral evidence

The official Issue 8 [rename](https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html) and
[rmdir](https://pubs.opengroup.org/onlinepubs/9799919799/functions/rmdir.html) DESCRIPTION, RETURN VALUE, and ERRORS
sections were fetched with curl and read on 9 September 2026. The web tool returned 403. Applicable rules include
same-identity no-op, atomic replacement, ancestor/dot rejection, parent timestamps, empty-only removal, and no new
entries after removing a referenced directory. This is not a complete POSIX audit.

[Namespace.test.ts](../../packages/core/test/Namespace.test.ts) has nine public behavior cases covering:

- POSIX-P08 / N01-N03: cwd/base identity after cross-parent rename, updated dot-dot ancestry, empty replacement,
  retained displaced references, same-entry no-op, and failure preservation for cycles and nonempty destinations.
- POSIX-N05 / capacity ADR 0009: empty-only removal, parent link counts, retained handle metadata, rejection of
  creation through removed references, and reclaimed entry capacity.
- POSIX-A02 / ADR 0017: both parent permissions, sticky ownership on source and replacement, independent relative
  bases, absolute paths ignoring foreign bases, and relevant closed/foreign-base errors.
- POSIX-P07 / M02: competing renames have one success, and parent metadata is published with one clock sample.

The initial test entry failed because rename/rmdir were missing; three cases also hit an incorrect TestClock import.
The [initial log](../evidence/directory-namespace/initial-test-entry.log) records those setup/API failures. They do not
prove a behavioral regression. The import was corrected to `effect/testing/TestClock`, verified against installed
Effect 4.0.0-rc.112. All nine cases subsequently pass with the production implementation.

## Execution and handoff

Environment: macOS arm64, Bun 1.4.0, Node 24.10.0, Effect 4.0.0-rc.112. Bun differs from the repository's pinned
1.2.21. No dependencies or lockfile were changed. The initial forced workspace test run executed 27 core and 89
memory tests with no cache hits, plus the memory build and empty scratchpad suite. All passed.

Final checks passed: `bun run format:check`, `bun run lint`, documentation TypeScript contracts and model checks,
`bun run type-check`, forced workspace tests, forced workspace builds, and the built-package Node consumer.
Tests executed 36 core and 89 memory cases with zero cache hits. Builds had zero cache hits. Type checking executed
core and replayed three unchanged memory/build/scratchpad tasks from cache. Model checks validate the existing
prototype, not implemented filesystem snapshots. Turbo's absent coverage-output warnings remain informational.

Final command logs are in [directory-namespace evidence](../evidence/directory-namespace/). Package consumer checks
compile the real source exports; a separate Node check imports the built package exports. Browser bundling remains
build evidence only. No browser runtime, Ubuntu CI, exhaustive interruption schedule, or mutation audit is claimed.

The next dependent slice is regular-file open/read/write/seek/truncate and scoped handles. The user subsequently instructed continued implementation through completion. The regular-file slice adopts
logical-length charging, capacity-limited prefix writes, and all-or-error truncation; see decision 0022. Remaining milestones are regular files and
links, remaining permissions/metadata/capacity, memory adaptation, fixtures/snapshots/codec, virtual module and
package builds, and a completed profile ledger. The whole implementation is not complete.
