# Package tests

- Use manifest `exports` to find the public modules. Give each module a top-level `test/<Module>.test.ts` suite. Use `test/index.test.ts` for its own root export contract. Keep compile-time and packed-consumer contracts at their existing entry points.
- Import only public modules, including when testing against source. Assert returned data, typed errors, events, persisted state, or resource lifetimes. Replace cache probes with public behavior. Keep a known concurrency regression when a private hook is the only way to reproduce it, and record the gap.
- Define shared conformance cases once. Register them from each provider's owning suite. Parameterize cases that exercise the same promise.
- Send wire requests through the public listener and decode replies with an independent client. Feed exact chunks at the transport boundary when fragmentation matters.
- Keep benchmarks under `benchmarks/` and host and runtime qualification at their established entry points. Use the [Effect development skill](../../effect-development/SKILL.md) for Effect mechanics and the [validation workflow](../../../../.okf/workflows/evidence-and-validation.md) to select checks.
