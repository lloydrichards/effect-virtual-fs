# Path base selection

Status: accepted, 8 September 2026. Resolves directory-base selection in D01 and D09.

## Decision

Absolute paths resolve from the invoking caller's volume root. Ignore any supplied directory base, including its
liveness, volume association, and permissions. Always validate the invoking caller and the path; ignoring a base
cannot revive a closed caller or bypass permission checks along the absolute path.

Relative paths resolve from the invoking caller's cwd when no base is supplied. A supplied base must be live and
belong to the caller's volume. Lookup uses the invoking caller's permissions, not the base opener's privilege.
For two-path operations, apply this selection independently to each operand.

The user accepted the base-selection table in the [path contract](../context/path-and-base-contract.md).
That contract's path-representation rules remain proposals.

## Example and consequences

`alice.stat("/work", { relativeTo: foreignBase })` resolves `/work` in Alice's volume. Using `"work"` instead makes the
foreign base relevant and fails. A supplied base never switches the operation to another volume.

Wrappers can forward a base without branching on absolute versus relative input. An unused stale or foreign base
goes undiagnosed for absolute paths. Directory bases are not restricted roots or sandbox boundaries.

The [verified openat clauses](../context/path-and-base-contract.md) provide the source basis for the absolute/relative
distinction. Independent authority follows decision 0011. Exact failure precedence for a base that is both closed
and foreign remains open, as do operation-specific errors and path limits.

## Required evidence

Verify equal absolute-path results with omitted, closed, and foreign bases; rejection of relevant closed/foreign
bases before mutation; continued caller-liveness checks; and invoking-caller permission checks. Test two-path base
selection independently when those operations are implemented. No core behavior has been implemented or tested.
