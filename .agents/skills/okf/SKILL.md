---
name: okf
description: Keep this repository's Open Knowledge Format (OKF) bundle accurate as code, contracts, decisions, and research change. Use for OKF maintenance, exploration, validation, new durable knowledge, broken knowledge links, or okf-graph.
---

# Repository OKF

Use `.okf/` as the source of truth for durable project knowledge. Keep it aligned with the repository during ordinary implementation work. Current code, tests, specifications, and linked external resources ground its claims. Transient logs, task summaries, and facts recoverable from Git do not belong in the bundle.

## Choose the task mode

- **Explore or answer:** read `.okf/index.md`, then inspect only relevant concepts and graph neighborhoods. Do not edit.
- **Validate or audit:** run deterministic validation and evaluation, inspect reported files, and report findings. Do not fix unless asked.
- **Create:** identify the durable unit and its authoritative sources, add the smallest focused concept, connect it selectively, log the addition, and validate.
- **Maintain after a repository change:** use the fast path below. Read [references/maintenance.md](references/maintenance.md) when deciding whether a change deserves an OKF update or when several concepts may be affected.

## Canonical paths and commands

- Bundle root: `.okf/`
- Recommended entry point: `profiles/project-overview`
- CLI: `npx --yes okf-graph@0.2.0`
- Specification: OKF v0.2

Pin the CLI so results do not drift unexpectedly. Check the upstream package before changing the pin or using a newer feature.

```bash
npx --yes okf-graph@0.2.0 bundle index .okf
npx --yes okf-graph@0.2.0 concept .okf profiles/project-overview --interactive
npx --yes okf-graph@0.2.0 concept .okf <concept-id>
npx --yes okf-graph@0.2.0 graph neighbors .okf <concept-id> --json
npx --yes okf-graph@0.2.0 graph path .okf <from-id> <to-id> --json
```

A concept ID is its bundle-relative path without `.md`, for example `decisions/package-boundaries`.

## Read efficiently

1. Start from `.okf/index.md` or `profiles/project-overview`.
2. Use `bundle index`, `concept`, `graph neighbors`, and `graph path` to narrow the search.
3. Open full concept bodies only when their summaries or graph position make them relevant.
4. Verify important or potentially stale claims against the concept's current sources.
5. Keep current contracts, accepted decisions, draft research, and reproducible evidence distinct.

## Maintenance fast path

Use this after changing behavior, architecture, public contracts, project scope, or accepted decisions.

1. Inspect the changed files and name the durable claim that changed.
2. Find concepts that cite those files:

   ```bash
   rg -nF '<repository-relative-source-path>' .okf
   ```

3. Inspect each matching concept and its radius-one neighborhood:

   ```bash
   npx --yes okf-graph@0.2.0 concept .okf <concept-id>
   npx --yes okf-graph@0.2.0 graph neighbors .okf <concept-id> --json
   ```

4. Update only claims, sources, status, and relationships affected by the change. Create a concept only when no existing concept owns the knowledge cleanly.
5. Update `generated.at` on concepts whose meaning changed. Do not touch timestamps for formatting or link-only repairs.
6. Add one concise, newest-first entry to `.okf/log.md` when knowledge changed. Skip the log for validation-only runs.
7. Run `.agents/skills/okf/scripts/check.sh <affected-concept-id>...`.

If no durable claim changed, leave `.okf/` alone and report that decision. File churn alone is not a reason to rewrite knowledge.

## Author OKF v0.2 concepts

Every concept is UTF-8 Markdown with YAML frontmatter. Only `type` is required by the format, but project concepts should normally include grounded discovery metadata:

```markdown
---
type: Decision
title: Package boundaries
description: Defines dependency ownership and the release order for core, memory, and future bindings.
status: stable
tags: [architecture, packages]
sources:
  - id: core-package
    resource: ../../packages/core/package.json
    title: Core package manifest
generated: { by: codex/okf, at: 2026-09-10T00:00:00Z }
---

# Package boundaries

Grounded summary of the decision. See the [implemented profile](/profiles/implemented-filesystem.md "implemented by").
```

Use these rules:

- Preserve unknown frontmatter fields when editing an existing concept.
- Use ISO 8601 timestamps with an explicit UTC offset.
- Set `generated.at` only when meaningfully changing concept content.
- Do not add `verified` unless a human or deterministic process actually performed that verification.
- Use `status: draft`, `stable`, or `deprecated`; mark unsettled research and proposals as `draft`.
- Ground claims in current source content. Do not invent settled decisions or evidence.
- Use Markdown footnotes tied to `sources[].id` when claim-level attribution matters.
- Resolve relative source paths from the concept file's directory; use absolute URLs for remote sources.
- Summarize reproducible validation rather than copying large logs or generated reports.

## Model graph edges deliberately

Markdown links between concepts become directed graph edges. Use a title when the relationship is known:

```markdown
[Checkpoint persistence](/contracts/checkpoint-persistence.md "depends on")
```

The title should read naturally as `source --relation--> target`. Prefer precise relations such as `depends on`, `implements`, `constrained by`, `evidenced by`, `supersedes`, `refined by`, and `contrasts with`.

- Put broad navigation in `index.md`, not every concept.
- Keep links selective and useful for traversal.
- Do not add reciprocal links only for symmetry.
- Do not turn evidence lists into high-degree hubs.
- Split a concept when it mixes unrelated decisions, behaviors, or workflows.

## Create knowledge

1. Confirm the information is durable and does not fit an existing concept.
2. Locate neighboring concepts through the index or graph.
3. Verify the durable claim against current code, tests, specifications, or external resources.
4. Create the smallest coherent concept and connect it to the graph.
5. Update the relevant index only when it improves discovery.
6. Append a newest-first entry under today's `YYYY-MM-DD` heading in `.okf/log.md`.
7. Run `.agents/skills/okf/scripts/check.sh <new-concept-id>`.

If a source and concept disagree, report the conflict. Do not silently choose an authority unless repository policy already settles it.

## Validate and evaluate

```bash
npx --yes okf-graph@0.2.0 validate .okf --json
npx --yes okf-graph@0.2.0 eval .okf --json
npx --yes okf-graph@0.2.0 graph .okf --json
.agents/skills/okf/scripts/check.sh <affected-concept-id>...
```

Also check that:

- descriptions are specific and grounded;
- types and lifecycle states are consistent;
- accepted decisions are not presented as proposals;
- evidence claims point to retained sources or reproducible checks;
- important concepts are reachable from an index or another concept;
- high-degree nodes are genuine hubs rather than link noise;
- at least one realistic radius-one neighborhood stays focused.

Validation failure blocks completion. This repository requires zero broken links and zero isolated concepts. Evaluation findings need review, but a metric change alone does not require adding noisy links.

## Report the result

State whether OKF needed an update, what changed, affected concept IDs, source choices, exact validation results, and unresolved drafts or conflicts. Include the next useful graph command when the user is exploring the result.
