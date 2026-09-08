# Explicit caller privilege

Status: accepted, 8 September 2026. Resolves the privilege-assignment portion of D03.

## Decision

Privilege is an explicit caller setting, separate from user ID, primary group ID, and supplementary groups.
Assigning user ID zero alone does not grant privilege. The default caller is privileged for convenient fixtures and
builds, as required by the design. Explicitly unprivileged callers undergo the selected permission checks.

Caller identity and privilege do not come from the host process. Both explicit callers and the optional Effect
service layer use the same permission model. Privilege is not global mutable volume state.

## Example

The default caller can perform operations permitted by the privileged policy. Alice has user ID `1000`, group ID
`100`, and no privilege; ordinary permission checks apply. A caller with user ID `0` and privilege disabled also
undergoes ordinary checks, although its ID still participates in file ownership comparisons.

## Alternatives and basis

Automatically granting privilege to user ID zero would couple identity and authority. The user selected explicit
privilege instead. This is a project policy within the caller model in the
[design](../design/VirtualFileSystem-design.md); it does not establish the precise POSIX privilege exceptions.

## Remaining contracts and evidence

Define which checks privilege bypasses for each operation, including directory traversal, metadata changes, and
sticky or set-ID rules. Exact field types, privilege granularity, and caller constructors remain open. This decision
does not mean that privilege bypasses invalid arguments, wrong file kinds, capacity limits, or every permission rule.

The legacy memory adapter's default behavior must remain compatible. Permission checks govern calls through the
filesystem API; they do not sandbox JavaScript or prevent use of a privileged caller already available to it.

Required tests distinguish ownership from privilege: unprivileged user zero receives ordinary checks; a nonzero
privileged caller receives the documented exceptions; two callers on one volume retain independent identities and
privilege settings. Link these cases to `POSIX-A01` through `POSIX-A04` in the
[profile ledger](../context/posix-profile.md). No tests were implemented or run for this decision.
