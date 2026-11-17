<!-- dprint-ignore-file -->
<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

## Working with Effect

For Effect TypeScript changes, read the [Effect development skill](.agents/skills/effect-development/SKILL.md).
Use `node_modules/effect/AGENTS.md` to find examples for the installed version.
Check the owning package's tests and the [filesystem contracts](.okf/contracts/index.md) for the behavior the implementation must preserve.

## Commits, branches, and reviews

Omit Codex signatures and co-author trailers. Give new branches descriptive names without the `codex/` prefix.

## Repository standards

Follow the [repository validation policy](.okf/decisions/repository-validation.md) and
[validation workflow](.okf/workflows/evidence-and-validation.md). Keep policy metadata in `tools/checks/repository.mjs`;
workspace manifests discover packages and exports.

- Use `bun run check` for read-only formatting, inventory, dependency direction and runtime-cycle checks.
- Use `bun run test:tooling` after editing policy checks or lint rules. `bun run lint` does not execute tests.
- Use `bun run validate --list` to inspect the shared local/CI sequence and `bun run validate` to execute it.
- Run `bun run build` before focused type-aware lint, documentation examples or packed-consumer checks.
- Keep tests beside their owner: `tools/checks/test`, `tools/oxlint/test`, or the owning workspace's `test` directory.
- Public inference assertions belong in the existing package consumer fixture. Verify supported consumers rather than
  adding a parallel temporary compiler-test project.
- Generated preview output belongs to its snapshot/generator. Preserve its regeneration and runtime qualification.

Git hooks format staged source before commit and run `check` before push. CI owns full validation and pinned runtime jobs.
Preserve published contracts and current rules while consolidating their tooling. Fix scoped violations before enabling a
check; document VFS-specific exceptions at their owning boundary.
