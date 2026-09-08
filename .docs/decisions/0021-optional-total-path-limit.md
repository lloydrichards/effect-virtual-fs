# Optional total path limit

Status: accepted, 8 September 2026. Resolves the total-path policy gate in POSIX-D03 and decision 0019.

## Decision

Expose optional per-volume maxPathBytes. When omitted, there is no configured total-path cap. Explicit values must
be positive safe integers and count path data bytes, including separators and excluding any terminator.

Apply the bound to the complete input before separator collapsing and to each target-plus-remaining-suffix path
formed during symlink expansion. Count strings after UTF-8 encoding. Check each operand independently in two-path
operations. Exceeding the bound fails with PathTooLong before publishing a mutation; never truncate input.

Relative lookup starts from directory identity without prepending its full absolute ancestry for the length check.
BytePath construction remains volume-independent; apply the selected volume's bound when using the path.
Generated realPath output policy is a separate later contract.

The user accepted the [revised proposal](../context/path-limits.md) after reviewing dependency-tree measurements and
the existing 12,000-byte memory regression. This supersedes the earlier fixed-4096 recommendation. The 255-byte
component and 40-traversal defaults remain provisional under decision 0019.

## Consequences

Applications can bound input and expansion work explicitly. Omitting the bound preserves long-path use but supplies
no configured total-length protection or CPU/heap budget. Directory-relative lookup can address a tree whose full
absolute spelling exceeds the selected bound. The option is not a total tree-depth restriction.

The adapter can omit this bound to preserve its existing long-input behavior. This does not settle other adapter
compatibility questions, including component limits and symlink behavior.

## Evidence and next step

The installed samples reached 249 stored-path bytes; the passing existing synthetic regression creates a 12,000-byte
input. See the [evidence report](../context/preimplementation-evidence.md). Neither result establishes core behavior.

Required core cases cover omitted-bound long input, exact-boundary and one-over input, multibyte strings, separator
counting, expansion lengths, reuse of a BytePath across volumes with different limits, and unchanged state on failure.
The initial policy gate is now resolved. Core implementation still requires an explicit start instruction.
