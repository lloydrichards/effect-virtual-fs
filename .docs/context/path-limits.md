# Path limit proposal

Status: provisional defaults and open measurement work, 8 September 2026. Refines POSIX-D03.
[Decision 0019](../decisions/0019-provisional-path-limits.md) retains 255 component bytes and 40 traversals provisionally;
[decision 0021](../decisions/0021-optional-total-path-limit.md) accepts an optional total-path bound with no cap by
default. No core limits are implemented.

## Source basis

The official Issue 8 [limits.h](https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/limits.h.html) definitions were
retrieved and read directly. The base POSIX minimum values are 14 filename bytes, 256 for the pathname limit, and
8 traversable symbolic links. These are minimum supported capabilities, not recommended application defaults.
XSI defines additional minima; this proposal is not a claim of complete XSI conformance.

POSIX pathname limits include the C terminating NUL where specified. Core has length-bearing strings and byte arrays
and forbids embedded NUL, so its public byte limits should explicitly exclude a terminator. Do not label them PATH_MAX
without explaining this difference. [XBD 4.16](https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/V1_chap04.html#tag_04_16)
permits failure for excessive symlink traversals and intermediate expansion length.

## Current candidates

| Bound                          | Proposed maximum | Counting rule                                                                   |
| ------------------------------ | ---------------- | ------------------------------------------------------------------------------- |
| Filename component             | 255 bytes        | Encoded bytes of one name, excluding separators. Never truncate.                |
| Input or symlink-expanded path | Optional         | Path data, including separators, excluding any terminator.                      |
| Symlink traversal              | 40               | Followed links during one operand's resolution; fail before following the 41st. |

The earlier 4096-byte path recommendation is not accepted. The remaining numeric candidates are provisional, not
workload measurements or POSIX-mandated values. Fixed versus configurable limits remains open; do not inherit host
limits implicitly. Counting rules below remain proposals where not already established by the input policy.

Measure strings after UTF-8 encoding, not by JavaScript string length. Apply the same byte counts to opaque paths.
Check the original path before separator collapsing, so excessive redundant separators do not bypass the input bound.
During symlink resolution, check each replacement path formed from the target and remaining suffix, including any
joining separator. Resolve relative targets from the containing directory identity without materializing its absolute
ancestor path just to perform lookup. Count links across all expansions, not separately per component.

For two-path operations, each operand has its own path and traversal bounds. These bounds do not cap the total depth
of the volume: directory-relative operations can address a tree whose full root-relative spelling is longer.
The length policy for generated realPath output remains a separate API contract.

## Consequences and required evidence

Fixed bounds keep behavior predictable and constrain individual lookup work. Very long generated filenames or deeply
nested input paths may be rejected even when storage capacity remains. Directory bases can shorten input paths but
cannot bypass the component or traversal limits. Limits do not bound total volume memory or snapshot decoder memory.

Prove exact-boundary success and one-over rejection for byte and multibyte-string inputs. Check redundant separators,
symlink expansion, 40 versus 41 traversals, and short relative lookup below a long ancestry. No failed mutation may
publish a partial entry. Error naming and mapping remain open; distinguish path length from file-size exhaustion.

## Measurement work before choosing the path bound

Use representative Vite dependency trees, including a nested installation layout and a symlink-based layout. Record
package manager/version, lockfile revision, package counts, and how each tree was obtained. Do not treat one layout
or a single repository as representative of every consumer.

Measure UTF-8 component lengths and root-relative path lengths, reporting maxima and distribution summaries. Record
symlink target lengths, resolved chains, and intermediate expansion lengths separately. Exclude the host checkout
prefix from virtual path measurements. Explain how the tree maps into the virtual root.

Include synthetic long components, deep nesting, repeated separators, and expansion chains to test proposed bounds;
label these separately from observed workload data. Measure actual resolver cost when an implementation exists.
Do not infer a runtime cost budget from path-length statistics alone.

Present candidate cutoffs with the observed paths each would reject and a stated allowance beyond the samples.
Measurements inform the decision; a maximum observed path does not automatically become the supported maximum.
Shared backing, generated path outputs, counting details, and error mapping remain follow-up contracts.

## Measured samples

The [preimplementation evidence](preimplementation-evidence.md) reports four installed trees with stored paths up to
249 bytes. Full inventories and locks are retained. These samples provide headroom evidence but do not finalize a
total-path cutoff or prove arbitrary module-resolution behavior.

## Accepted total-path policy after compatibility review

Use optional per-volume `maxPathBytes`, with no configured total-path cap when omitted. Explicit values
must be positive safe integers and count path data bytes, including separators and excluding any terminator.
Decision 0021 accepts this policy and replaces the fixed-4096 recommendation.

The passing memory suite creates `"/d".repeat(6_000)`: a 12,000-byte input path with 6,000 components. See the
[deep-volume test](../../packages/memory/test/MemoryFileSystem.test.ts). It then exercises listing, copy, rename, and
unrelated file I/O in that volume. This is an existing synthetic regression, not a measured dependency-tree sample.
A universal 4096-byte cap would reject that input. Selecting 16384 only to clear this test would still invent a
compatibility boundary unsupported by the adapter's present contract.

An opt-in bound lets applications handling untrusted paths constrain individual input and expansion sizes. Leaving
it unset preserves long-path use without promising infinite storage or a CPU/heap budget. Applications must select
an explicit bound if they need this protection. The provisional component and traversal limits remain separate;
this proposal neither finalizes them nor establishes adapter compatibility for every component length.

### Accepted enforcement boundary

- Check the complete supplied input before separator collapsing or lookup. Strings count after UTF-8 encoding.
- Apply the same configured bound to each target-plus-remaining-suffix path formed during symlink expansion.
- Check each operand independently for two-path operations. Fail with PathTooLong before publication.
- Do not prepend the absolute ancestry to a relative input merely to apply the bound. Directory identity can address
  trees whose full root-relative spelling exceeds the configured input limit.
- Keep BytePath construction volume-independent. Enforce a volume's configured limit when using that path, so one
  owned path can be used with differently configured volumes.
- Do not truncate names or paths. The optional bound is an input/resolution policy, not a total tree-depth limit.

Generated realPath outputs remain a separate later API contract. Adapter migration can omit this bound to preserve
existing long-input behavior; that does not settle its other path compatibility questions.

### Evidence needed in core

Retain the adapter's 12,000-byte regression. Add a core long-path case with the bound omitted, and exact-boundary /
one-over failures with a small explicit bound. Cover multibyte strings, redundant separators, symlink expansion when
available, reuse of a BytePath across different limits, and rejected mutation preserving metadata and namespace.
No new core tests were executed during this recommendation; the existing memory test passed in the baseline run.
