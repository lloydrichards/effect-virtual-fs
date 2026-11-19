# Browser tests

- Use the docs Vitest Browser Mode suite against a preview of the built site. For static routes, assert page-specific content. A successful status can serve the fallback page.
- Use a top-level page when navigation, isolation headers, workers, or downloads are the reason for the check. Follow one user journey per interactive example and check its output. Add a focused regression for a distinct browser failure such as timeout recovery.
- Assert visible results or the downloaded artifact. Avoid layout measurements and internal state unless the test protects a documented behavior.
- Follow the [validation workflow](../../../../.okf/workflows/evidence-and-validation.md) for local and CI commands.
