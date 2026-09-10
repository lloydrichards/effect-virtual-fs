# Deciding what to maintain

Update OKF when a repository change alters knowledge that should guide a future maintainer. Do not mirror every code edit.

## Changes that usually need an OKF update

| Repository change                             | Check first                                                            | Typical OKF action                                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Accepted architectural or behavioral decision | `decisions/` and its neighbors                                         | Add or revise one decision. Mark an older decision `deprecated` or link with `supersedes` when needed. |
| Public API or behavioral contract change      | `contracts/`, then implemented profiles                                | Revise the owning contract and any profile claim that changed. Update code and test sources.           |
| Package ownership or dependency change        | `architecture/` and `profiles/project-overview`                        | Update boundaries and navigation only where the system model changed.                                  |
| Newly implemented or removed capability       | `profiles/implemented-filesystem` and `profiles/deferred-capabilities` | Move the claim between implemented and deferred knowledge. Check linked contracts.                     |
| Research reaches a durable conclusion         | `research/` and related decisions                                      | Keep unsettled work `draft`. Promote the conclusion only when the project adopts it.                   |
| Validation method changes                     | `workflows/` and `evidence/current-validation`                         | Update the reproducible command or durable conclusion, not old command output.                         |

## Changes that usually do not need an OKF update

- Refactors that preserve behavior and ownership.
- Formatting, renames, and file moves when source links still resolve and the concepts remain accurate.
- One-off debugging notes, task plans, review chatter, and generated reports.
- Test output that only confirms an already documented contract.
- Historical detail available from Git that does not affect current decisions.

## Scope rules

- Prefer revising an existing concept over adding a near-duplicate.
- Keep one concept responsible for one coherent piece of knowledge.
- Change neighboring concepts only when their claims or relationship labels became wrong.
- Replace stale sources with current authoritative sources. Do not keep a dead source merely as history.
- When implementation contradicts an accepted decision, report the conflict. Do not silently rewrite the decision to match accidental behavior.

## Completion checklist

- Every changed claim has a current source.
- Lifecycle status matches reality: `draft`, `stable`, or `deprecated`.
- Relationship labels describe the direction of the link.
- New concepts are reachable from an index or another concept.
- `.okf/log.md` records material knowledge changes once, not once per file.
- Validation reports no issues, broken links, or isolated concepts.
- The affected radius-one neighborhoods remain focused.
