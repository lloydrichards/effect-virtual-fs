# Demo tests

- Run the documented CLI or call the real HTTP or MCP entry point. Assert the result the walkthrough promises, such as usable output or saved state.
- Use real package code and isolated fixtures. Fake the external transport where credentials, availability, or unpredictable output would make CI unreliable. Keep live and privileged checks at their existing operator or CI entry points.
- Keep a focused app test for a distinct failure such as cancellation leaving a partial export. Use a cheaper boundary when reproducing the failure through the entry point would be costly. Remove temporary probes and cases whose filesystem rules are already tested in the package.
