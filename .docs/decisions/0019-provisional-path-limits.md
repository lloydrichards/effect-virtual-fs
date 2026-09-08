# Provisional path limits and measurement

Status: accepted planning direction, 8 September 2026. Refines POSIX-D03; final path limits remain incomplete.

## Decision

Keep 255 bytes per filename component and 40 symlink traversals per path lookup as provisional defaults. They are
engineering starting points, not measured workload requirements or final compatibility promises.

Do not adopt the proposed 4096-byte total path limit yet. Measure representative dependency trees before choosing
an input-path and symlink-expansion bound. Deferring that value does not commit to unlimited paths.

The user accepted this revision after questioning the justification for the original numeric proposal. The decision
does not settle fixed versus configurable limits or every counting detail in the research draft.

## Basis and consequences

A component limit supports filename portability; a traversal limit bounds repeated symlink resolution even when
path strings stay short. Total path length has a weaker justification for a virtual filesystem, particularly for
nested dependencies. None of these values establishes an exact CPU or memory budget.

Keep these defaults provisional until the [measurement work](../context/path-limits.md) is reviewed. Do not silently
encode 4096 in core, schemas, fixtures, or snapshot validation as an accepted limit.

## Required evidence

Record dependency-tree provenance, package manager and version, lockfile revision, and byte-length distributions.
Include nested directory layouts and symlink-based layouts. Separate measured examples from synthetic boundary cases.
Use the results to propose a bound and its tradeoffs before finalizing the public contract. No workload measurements
or core implementation were added by this decision.
