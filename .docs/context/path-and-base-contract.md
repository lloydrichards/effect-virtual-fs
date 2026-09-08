# Path input and directory bases

Status: accepted base selection and path-input policy, 8 September 2026. Refines D02 and D09 and POSIX-P01 through POSIX-P06.
[Decision 0017](../decisions/0017-path-base-selection.md) accepts base selection; [decision 0018](../decisions/0018-path-input-policy.md) accepts input representation and
separator/dot resolution rules. Limits and detailed error mapping remain open. No implementation is added.

## Verified basis

Issue 8 XBD 4.16 and the open/openat DESCRIPTION and relevant ERRORS clauses were read directly from official HTML
on 8 September 2026. Web-tool retrieval returned 403; direct retrieval succeeded. These observations cover the rules
below, not a complete operation error audit.

[XBD 4.16](https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/V1_chap04.html#tag_04_16) defines absolute lookup
from root and relative lookup from cwd or an interface-supplied directory. Components are resolved in sequence.
Empty pathnames cannot resolve successfully. Trailing separators require an existing directory or a directory being
created immediately by the operation. Root `..` may remain at root; exactly two leading slashes permit a documented
special interpretation. Final symlink handling depends on the operation and trailing separators.

[openat](https://pubs.opengroup.org/onlinepubs/9799919799/functions/open.html) changes the lookup base for relative
paths. Its invalid-descriptor and non-directory-descriptor errors are conditional on a non-absolute path. Ordinary
bases use current directory search permissions; O_SEARCH has different behavior and is outside the proposed initial
handle model. The project proposal generalizes this relative-base behavior to its shared path options.

## Accepted directory-base policy

| Path and base                                 | Proposed behavior                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| Absolute path, no base                        | Start from the invoking caller's volume root.                                 |
| Absolute path, any supplied base              | Ignore the base, including its liveness, volume association, and permissions. |
| Relative path, no base                        | Start from the invoking caller's cwd identity.                                |
| Relative path, live base from the same volume | Start from that directory identity; apply invoking-caller search checks.      |
| Relative path, closed or foreign base         | Fail before mutation. Exact error precedence when both apply remains open.    |

Always validate invoking-caller liveness and the path itself. Ignoring a base does not revive a closed caller or bypass
permission checks on the absolute path. For two-path operations, select the base independently for each operand.

Example: `alice.stat("/work", { relativeTo: foreignBase })` looks up `/work` in Alice's volume. Changing that path to
`"work"` makes the foreign base relevant and fails. No operation switches volumes because a base was supplied.

This makes generic wrappers simple: they can forward a base without branching on whether a path is absolute.
The tradeoff is that an accidental stale or foreign base is not diagnosed for absolute inputs. A base is not a sandbox
boundary; relative `..` can also traverse ancestors. Restricted roots remain excluded from the design.

## Accepted path-input policy

- Encode well-formed JavaScript strings as UTF-8. Reject lone surrogates instead of silently replacing them.
- Preserve byte paths exactly, including names that are not valid UTF-8. Reject embedded NUL in both input forms.
- Reject empty input; do not interpret it as cwd. Exact constructor-versus-operation error mapping remains open.
- Treat slash as the separator on every runtime. Backslash and newline remain ordinary filename bytes.
- Treat repeated separators, including exactly two leading slashes, as ordinary separators. Clamp root `..` at root.
- Resolve `.` and `..` during lookup. Do not remove them in the byte-path constructor or through host normalization.
- Preserve trailing separators for the operation's directory requirement; do not strip them before validation.
- Do not perform Unicode normalization, case folding, URI decoding, home-directory expansion, or drive-letter handling.

The constructor checks representation and owns a copy; it does not require the path to exist. Copying at
Effect execution follows decision 0012. Its output is opaque and its byte export is a separate owned copy. Raw symlink
targets need their own operation contract: this path proposal does not silently settle empty target handling.

Shared-memory-backed input, component/path byte limits, symlink traversal limits, and exact error tags remain separate
choices. No host-dependent path limit or normalization default should enter the implementation accidentally.

## Required evidence

These are planned cases, not executed filesystem tests:

1. Absolute lookup with an omitted, closed, or foreign base gives the same result under the same caller.
2. Relative lookup rejects a closed or foreign base without adding an entry or changing metadata.
3. A privileged opener's base does not transfer privilege to an unprivileged invoking caller.
4. Caller closure still fails an absolute lookup even though its supplied base would be ignored.
5. `/../work`, `//work`, and `///work` identify `/work` under the selected root/separator choices.
6. Empty input, embedded NUL, and lone-surrogate strings fail without namespace changes.
7. Distinct byte names that are not valid UTF-8 remain distinct; required string outputs fail faithfully under decision 0003.
8. A file followed by a trailing slash fails the directory requirement. `mkdir("new/")` retains directory-creation semantics.
9. A later symlink case such as `link/../child` follows the resolved directory ancestry, not a lexically shortened path.
10. A relative directory base follows directory identity across rename once rename is implemented.

Directory-base selection and path representation are accepted. Byte limits,
shared backing policy, and full operation error table still need explicit contracts before implementation.

See the [path-limit proposal](path-limits.md) for verified minimum values and proposed fixed bounds.
