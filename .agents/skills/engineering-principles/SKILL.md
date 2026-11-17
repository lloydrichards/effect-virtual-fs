---
name: engineering-principles
description: Apply engineering principles to code audits, architecture reviews, and refactors. Use for a principles-based review, a broad maintainability audit, or a refactor guided by these principles.
---

# Engineering principles

Use the task and code evidence to find the relevant engineering principles. All 23 references are bundled locally. The index is for selection; read a selected reference for its actual guidance, examples, and exceptions.

## Route the task

Identify the requested outcome and scope, then choose the route:

| Request                                                     | How to select references                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audit a repository, subsystem, or change                    | Assess every index entry within that scope. Track applicable, not applicable with a reason, or unresolved. Read applicable and uncertain references before reaching conclusions. A small audit scope still receives the full applicability check. |
| Refactor, fix, plan, or review a specifically named concern | Start with the entries matching that concern. Read their references, inspect the relevant implementation and contracts, then expand when evidence reveals another concern.                                                                        |
| Apply a named principle                                     | Read its reference directly. Follow other entries only when the decision needs their guidance.                                                                                                                                                    |

Use the request to make an initial selection; use implementation, callers, tests, and contracts to refine it. If an entry might apply but the index does not settle the question, read the reference. Revisit selection when the task changes or a new failure appears. There is no fixed number of principles to use. Batch independent reference reads and reuse material already loaded.

For example, simplifying pass-through wrappers points to laziness-protocol and minimize-reader-load. An externally consumed wrapper also raises the compatibility condition in migrate-callers-then-delete-legacy-apis; read that condition before recommending deletion. A job duplicated after a crash points to make-operations-idempotent and fix-root-causes. Add separate-before-serializing-shared-state if investigation finds concurrent writers.

## Applicability index

| Evidence or decision                                                          | Reference                                                                                                    |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Two or more failed fixes share an assumption                                  | [Attack the premise](references/principle-attack-the-premise.md)                                             |
| Validation, error handling, framework adapters, exposed representations       | [Boundary discipline](references/principle-boundary-discipline.md)                                           |
| Nontrivial edits, migrations, analyses, or checks                             | [Build the lever](references/principle-build-the-lever.md)                                                   |
| Repeated corrections or instructions need durable enforcement                 | [Encode lessons in structure](references/principle-encode-lessons-in-structure.md)                           |
| Novel design has several viable approaches and no established pattern         | [Exhaust the design space](references/principle-exhaust-the-design-space.md)                                 |
| Consumer experience competes with implementation convenience or feature count | [Experience first](references/principle-experience-first.md)                                                 |
| A defect, workaround, or restart failure needs a causal explanation           | [Fix root causes](references/principle-fix-root-causes.md)                                                   |
| Core data structures, access patterns, foundations, or shared state           | [Foundational thinking](references/principle-foundational-thinking.md)                                       |
| Large outputs, repeated reads, or long tasks consume working context          | [Guard the context window](references/principle-guard-the-context-window.md)                                 |
| Added layers, abstractions, signal threading, or an expanding diff            | [Laziness protocol](references/principle-laziness-protocol.md)                                               |
| Operations can repeat or resume after partial failure                         | [Make operations idempotent](references/principle-make-operations-idempotent.md)                             |
| A replacement internal API still has callers on the old API                   | [Migrate callers then delete legacy APIs](references/principle-migrate-callers-then-delete-legacy-apis.md)   |
| Understanding code requires tracing layers or remembering hidden state        | [Minimize reader load](references/principle-minimize-reader-load.md)                                         |
| Scattered branching, booleans, shape assumptions, or lifecycle rules          | [Model the domain](references/principle-model-the-domain.md)                                                 |
| Reversible execution is waiting on an avoidable human decision                | [Never block on the human](references/principle-never-block-on-the-human.md)                                 |
| A planned rewrite has explicit intermediate and final boundaries              | [Outcome-oriented execution](references/principle-outcome-oriented-execution.md)                             |
| A completion claim needs direct evidence from the actual result               | [Prove it works](references/principle-prove-it-works.md)                                                     |
| A new requirement changes the existing design's assumptions                   | [Redesign from first principles](references/principle-redesign-from-first-principles.md)                     |
| Concurrent actors may write the same mutable object                           | [Separate before serializing shared state](references/principle-separate-before-serializing-shared-state.md) |
| Multi-step work or delivery needs useful verification boundaries              | [Sequence verifiable units](references/principle-sequence-verifiable-units.md)                               |
| An addition or refactor can begin by removing obsolete complexity             | [Subtract before you add](references/principle-subtract-before-you-add.md)                                   |
| Tests are being written, changed, retained, or audited                        | [Test behavior, not implementation](references/principle-test-behavior-not-implementation.md)                |
| Type signatures, illegal states, casts, primitive identities, or variants     | [Type system discipline](references/principle-type-system-discipline.md)                                     |

## Apply the selected guidance

Apply each principle with its stated trigger, distinctions, and exceptions. When guidance conflicts with the task's instructions, a contract, another applicable principle, or observed behavior, identify the conflict and explain how it affects the recommendation.

Read related principles when the decision needs both. For example, a migration may allow temporary breakage inside a declared phase while requiring verification at its boundary. Establish that boundary before applying both outcome-oriented execution and sequence-verifiable-units. Execution principles guide how to do the current work; they do not by themselves prove a defect in the code under audit.

Follow the requested mode: an audit produces findings, while a refactor makes authorized changes. References to other skills or tools in the source do not assume those capabilities are installed; use an available equivalent where appropriate.

## Report or deliver

For an audit, lead with findings ordered by impact. Give file/line evidence, the consequence, the relevant principle, and a concrete correction. Keep the full applicability record available; summarize coverage and unresolved areas in the answer rather than printing every non-finding. Missing evidence is unresolved, not a pass. Report no findings when the evidence supports that result.

For a refactor, preserve behavior unless a contract change was requested. Apply the selected guidance, exercise the affected behavior, and report the changes and actual verification. Separate confirmed results from unverified assumptions.

## Source

References reflect [backnotprop/pstack at revision 157aae39](https://github.com/backnotprop/pstack/tree/157aae39a733135e93d8b5b19ff62c6a84b0ad56/skills), reviewed on 2026-09-29, with relative links adjusted for this package. See [LICENSE.upstream](LICENSE.upstream) for attribution. The references can evolve with the skill.
