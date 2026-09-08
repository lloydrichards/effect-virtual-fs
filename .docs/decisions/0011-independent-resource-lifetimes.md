# Independent resource lifetimes and explicit authority

Status: accepted, 8 September 2026. Resolves the sharing and authority model in D09 and part of D03.

## Decision

Derived callers retain their own working-directory references and lifetimes. Once acquired, a child caller can
outlive its parent if its own scope remains live. File and directory handles likewise belong to their acquiring
scopes and can be closed explicitly earlier. Closing or finalizing a caller does not separately revoke resources
owned by other live scopes. Resources in the same closing scope still receive normal scope cleanup.

Read/write/truncate through an open file handle use access granted at open. Changing permission bits does not
automatically revoke that existing access. Authority-sensitive metadata changes use the invoking caller's credentials,
not privilege inherited from the handle's opener.

A directory base retains directory identity. The invoking caller supplies credentials for lookup from that base.
Passing a directory handle does not grant its opener's privilege, but does provide a route to that directory
independent of the path through its ancestors. Applicable checks at the base and along the remaining path still apply.
Special search-handle modes remain a separate profile question.

## Example

Alice opens a writable file and Bob receives its handle. Bob can write while that handle is live, including after
Alice's caller has ended if the handle belongs to another live scope. Bob does not inherit Alice's privilege to change
ownership or permissions; those operations use Bob's caller. Explicitly closing the shared handle invalidates that
handle for every holder. A separate open has its own lifetime.

A derived caller created in a longer-lived scope retains its own cwd reference when its parent finalizes. Closing
that child releases its reference, not the references owned by another caller.

## Tradeoffs and basis

The user selected independent lifetimes after reviewing sharing, cleanup, and revocation consequences. This supports
shared-volume integrations without making one consumer's cleanup unexpectedly stop another consumer's independently
owned work. It requires explicit scope ownership and runtime liveness checks.

Tying every child and handle to its originating caller would centralize cleanup but couple consumers' lifetimes.
Automatic revocation or cancellation of every descendant is not part of this decision and would need a separate model.
This refines the ownership model in the [design](../design/VirtualFileSystem-design.md).

## Remaining contracts and evidence

Exact constructor signatures, root-caller construction, repeated explicit close, closed-resource error shapes,
removed cwd behavior, absolute paths with unused bases, and search-handle modes remain open. The byte-copying, shared
memory, error-mapping, and snapshot-schema proposals were not accepted by this resource decision.

Required tests cover independently scoped child/handle survival, cleanup when their own scope closes, explicit shared
handle close, separate opens, mode changes after open, and metadata or directory-base use by a caller with different
credentials. Verify scopes and authority independently. No implementation or tests were added for this decision.
