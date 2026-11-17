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

Follow the [repository validation policy](.okf/decisions/repository-validation.md). Discover workspaces and public exports
from manifests; record policy choices and justified exclusions in `scripts/repository-policy.mjs`.

- Use `bun run lint:repository` for inventory, dependency direction, and runtime cycles.
- Use `bun run lint:anti-slop-policy` and `bun run type-check:tools` after editing lint rules.
- Use `bun run test:tooling` after editing validation scripts or documentation checks.
- Run `bun run build` before `bun run check:consumers`. The consumer check imports packed public entrypoints with
  TypeScript 5.9.3 and 7.0.2; it does not establish support for every intervening compiler version.
- Use `bun run lint:effects -- packages/core` for a focused diagnostic check. Generated preview output has a separate
  reproducibility policy; change its snapshot or generator rather than applying handwritten-source style fixes.

Preserve published contracts while tightening checks. Fix scoped violations before enabling a rule. Document a VFS-specific
exception when an upstream convention conflicts with an integration or filesystem contract.
