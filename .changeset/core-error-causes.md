---
"@effect-vfs/core": minor
---

`VfsError` now exposes the underlying failure as `cause`. Errors with a cause no longer compare equal to otherwise identical errors without one. If you compare errors with `Equal`, match the fields you need instead:

```ts
const sameFailure = left.code === right.code && left.operation === right.operation
```
