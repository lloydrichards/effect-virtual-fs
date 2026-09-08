# Preimplementation evidence

Status: executed research and baseline checks, 8 September 2026. The consolidated first-slice contracts are accepted
in [decision 0020](../decisions/0020-first-core-contracts.md). Core and memory source files were not changed.

The failures below are historical. [Baseline cleanup](baseline-cleanup.md) now records a passing workspace sequence
and the changes that resolved them. Preserve these original logs as the before-state evidence.

## Findings

The direct memory suite passes 89 tests. The full workspace baseline fails independently at formatting, lint,
type-check, and build preparation. Dependency measurements cover four installed samples; their longest stored path
is 249 bytes. This supports substantial headroom below 4096 for these samples, not a universal limit or build proof.

## Dependency-tree measurements

All trees map their install root to `/project`; host checkout prefixes are excluded. Installs used Node 24.10.0 on
macOS arm64, npm 11.16.0 with `--install-strategy=nested`, and pnpm 11.19.0 with its default isolated symlink layout.
Lifecycle scripts were disabled. These were installed package trees, not merely lockfile paths. No Vite build ran.

The small sample pins Vite 8.2.2, plugin-react 6.1.1, React/React DOM 19.2.8, and TypeScript 7.0.2. The larger sample
adds Storybook react-vite 10.6.0, TanStack React Router 1.170.33, and Radix Dialog 1.1.23. Versions were resolved from
registry metadata and then pinned in the sample manifests. Transitive graphs differ by package manager.

| Sample                | Named/versioned package manifests | Stored entries | Longest component bytes | Longest path bytes | Path p95 bytes | Symlinks |
| --------------------- | --------------------------------- | -------------- | ----------------------- | ------------------ | -------------- | -------- |
| Small, nested npm     | 24                                | 989            | 49                      | 127                | 108            | 4        |
| Small, isolated pnpm  | 23                                | 1089           | 49                      | 155                | 145            | 44       |
| Larger, nested npm    | 247                               | 9048           | 69                      | 249                | 225            | 24       |
| Larger, isolated pnpm | 203                               | 9180           | 120                     | 228                | 166            | 518      |

Package-manifest counts include named subpackage manifests and duplicate installed versions; they are not unique
package counts. npm reported 23/242 installed packages, and pnpm reported 22/198. Stored-entry counts include directories,
files, and symlinks, but not descendants expanded again through every alias. pnpm store-directory names are included.

No stored path exceeded any candidate cutoff of 1024, 4096, or 16384 bytes. The longest measured symlink target was
169 bytes. Traces of each link, plus package.json suffixes for host-recognized directory targets, followed at most one
link; the largest target-plus-suffix replacement was 182 bytes. This is a limited trace set, not every module import
or every possible alias path. Physical/real paths and replacement paths are distinct measurements.

The [measurement script](../evidence/path-study/measure.py), raw results, full package inventories, manifests, and
lockfiles are retained below. Lock hashes identify the exact install inputs; replay the saved locks, not fresh floating
transitive dependencies. Installs are platform-specific and scripts were disabled, so generated artifacts may differ
from a normal application installation.

- [Small npm results](../evidence/path-study/small-nested.json) and [lockfile](../evidence/path-study/locks/small-nested/package-lock.json).
- [Small pnpm results](../evidence/path-study/small-isolated.json) and [lockfile](../evidence/path-study/locks/small-isolated/pnpm-lock.yaml).
- [Larger npm results](../evidence/path-study/large-nested.json) and [lockfile](../evidence/path-study/locks/large-nested/package-lock.json).
- [Larger pnpm results](../evidence/path-study/large-isolated.json) and [lockfile](../evidence/path-study/locks/large-isolated/pnpm-lock.yaml).

Run the script as `python3 measure.py INSTALL_ROOT OUTPUT_JSON`. It walks without following directory aliases and
records nearest-rank percentiles. A separate synthetic probe verified that its resolver counts a 41-link chain;
UTF-8 byte-count and 4096-byte generated-path calculations were also checked. These verify measurement mechanics,
not core rejection behavior. The script is not a production POSIX resolver and does not model permissions or mounts.

### What this justifies

The samples reveal no pressure against the provisional 255-byte component bound. They do not stress 40 traversals.
4096 would accommodate the largest observed stored path by more than 16 times, but that ratio is not a future guarantee.
These samples cannot distinguish a need for 4096 versus another generous cutoff. Keep total-path acceptance open;
report this evidence with the eventual cutoff proposal rather than presenting convention as a measured requirement.
An unusually deep real application or generated tree remains useful additional evidence if that workload is expected.

### Additional compatibility evidence

The existing deep-volume regression constructs a 12,000-byte input path using 6,000 `/d` components. It passed in
the baseline. This synthetic case is separate from the installed dependency samples above and weighs against a
universal 4096-byte limit. The [revised path recommendation](path-limits.md) proposes an opt-in total-path bound.

## Workspace baseline

Checks ran in an isolated copy at `/private/tmp/effect-vfs-baseline-workspace`. Repository manifests and source were
copied without `.git`, dependencies, or generated build directories. Bun 1.2.21 was installed separately and placed on
PATH for the final child-process checks; the machine's default Bun is 1.4.0. Node is 24.10.0. This is a macOS baseline,
not reproduction of the Ubuntu CI runner. See [resolved versions](../evidence/baseline/versions.json).

The configured `bun install --frozen-lockfile` returned success despite this checkout having no lockfile. It resolved
118 packages from current registry metadata and did not create bun.lock in this run. Exact Effect and TypeScript pins
were respected, but ranged dependencies are not historically reproducible. Prepare patched the compiler and linter;
Husky reported the expected missing `.git` in the isolated copy. No repository dependencies or lockfiles were changed.

| Command                             | Result                                                                      | Evidence                                     |
| ----------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------- |
| Root `bun run format:check`         | Failed: configured YAML formatter plugin URL returns 404.                   | [Log](../evidence/baseline/format-check.log) |
| Root `bun run lint`                 | Failed: docs prototype diagnostics plus three package tsconfig diagnostics. | [Log](../evidence/baseline/lint.log)         |
| Root `bun run type-check`           | Failed in prerequisite memory build: `tsup: command not found`.             | [Log](../evidence/baseline/type-check.log)   |
| Root `bun run test`                 | Failed in prerequisite memory build; not a completed suite.                 | [Log](../evidence/baseline/test.log)         |
| Root `bun run build`                | Failed: `tsup: command not found`.                                          | [Log](../evidence/baseline/build.log)        |
| Memory package `bun run test`       | Passed: 1 file, 89 tests.                                                   | [Log](../evidence/baseline/memory-tests.log) |
| Memory package `bun run type-check` | Failed: 50 TypeScript diagnostics.                                          | [Log](../evidence/baseline/memory-types.log) |
| Core package `bun run type-check`   | Passed for the empty core placeholder.                                      | [Log](../evidence/baseline/core-types.log)   |

The initial formatter attempt also hit sandbox cache permissions; the reported rerun used a writable temporary cache
and verified the upstream 404. Initial Turbo children found the machine's Bun; final root type/test/build runs used
the pinned Bun on PATH and retained the missing-tsup failure. The lint command invokes oxlint directly.

### Actionable baseline work

- Declare the missing tsup build dependency and establish a checked-in dependency lock through the repository workflow.
- Resolve the YAML formatter plugin reference before claiming a full formatting pass.
- Separate deliberate compile-error examples and executable documentation probes from production lint expectations.
  The documentation work introduced these diagnostics; do not attribute all lint failures to the earlier repository.
- Investigate the three tsconfig lint diagnostics and memory's 50 type errors. They include unchecked indexed access
  and missing TextEncoder/TextDecoder types. The direct passing runtime suite does not dismiss these failures.
- Rerun the configured graph after fixes; direct package checks are supplementary, not a substitute for the full gate.

No fixes to package/configuration or production code were made in this evidence pass. Baseline cleanup is the next
engineering task before core implementation. The retained logs distinguish failed setup, type errors, deliberate
documentation examples, and the successfully executed memory tests.
