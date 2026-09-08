# Consolidated first-core contracts

Status: accepted, 8 September 2026. Resolves the first-slice portions of D01-D04 and D07-D11.

## Decision

Accept sections 1-4 of the [consolidated first-core contract review](../context/first-core-contract-review.md), including
its explicitly open total-path-length measurement gate. These sections define construction defaults, directory
permissions and metadata, input ownership, entry accounting, errors, and mutation/interruption behavior together.

The user approved the package and continued to evidence gathering. This does not authorize core implementation,
finalize later features, or adopt the earlier 4096-byte total-path proposal.

## Consequential choices

Root starts at uid/gid 0 with mode 0755. The default caller is privileged with umask 0022. New directories use caller
uid and parent gid; default requested mode is 0777. A volume captures its Effect Clock for consistent timestamp sourcing.

Core rejects shared-memory-backed byte inputs. Root and implicit dot entries do not consume entry quota. An omitted
entry quota has no configured cap; quotas do not bound heap memory.

Expected failures preserve state. Waiting is interruptible and commit publication is uninterruptible. Interruption
can arrive after commit without delivering success; callers cannot assume interruption implies rollback. Scoped
acquisition must protect reference retention and cleanup registration against an interruption gap.

The linked sections are the complete accepted contract for this slice, not just this summary. Future revisions must
identify changes to accepted policy rather than silently rewriting the recommendations.

## Evidence and remaining gate

Complete dependency-tree measurements and establish the pinned workspace baseline. Keep first-slice behavior tests
separate from existing adapter tests and model checks. No core filesystem behavior has been implemented by this ADR.
