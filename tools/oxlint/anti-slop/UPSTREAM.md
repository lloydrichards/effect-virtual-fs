# Anti-slop provenance

Source repository: `https://github.com/dmmulroy/anti-slop`

Installed from: `/Users/lloyd/.agents/skills/install-anti-slop/assets/anti-slop`

Installed on: 2026-09-15

Upstream revision: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`

The installed production files were verified byte-for-byte against that upstream revision before the local policy changes below. The SHA-256 digest of the sorted source-file checksums at installation time was `bdeaf164d84e90e8d0fcd43d2678dae246957637252582a380005e7e12375835`.

Installed plugin entry points:

- `tools/oxlint/anti-slop/index.ts`
- `tools/oxlint/anti-slop/effect/index.ts`

Intentional local policy deviations:

- `no-service-constructor-imports` is removed because Effect routinely imports ordinary `make*` factories across module boundaries; the rule inferred service ownership from names alone.
- `prefer-effect-match` only reports chained ternaries that compare `_tag`. Scalar mappings remain ordinary TypeScript conditionals.
- `no-manual-tagged-construction` accepts `_tag` inside `systemError(...)` options because the installed Effect API requires that field.

The repository configuration exempts tests from manual tagged construction. Tests still require `SAFETY:` comments for non-const assertions, and deliberate chained assertions use targeted suppressions.

The nested `vendor/eslint-stylistic/UPSTREAM.md` records the provenance and adaptations for the vendored readability rule.

## Public contract checks

The local public-contract rules cover inline and separately exported values, local alias chains, and direct internal value re-exports. The Effect function rule recognizes named and default exports, direct and curried calls through Effect namespace imports and named imports, and stable local factory aliases. An operation can state its contract on the exported binding or on every generator input and its return type.

An explicit `typeof Internal.operation` annotation remains allowed. These syntax checks require declared ownership; clean consumer checks determine whether emitted declarations resolve without unavailable private dependencies. Internal type names alone do not establish an invalid published declaration.

Run `bun run lint:anti-slop-policy` to check accepted and rejected cases for every enabled custom rule. The runner isolates each rule, rejects unexpected diagnostics, and fails if the lint subprocess crashes or returns an inconsistent status. Run `bun run type-check:tools` to check the plugin implementation and vendored support code.
