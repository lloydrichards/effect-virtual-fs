---
"@effect-vfs/nfs": minor
---

Observe NFS listener termination through `server.awaitTermination`. It reports listener failures as `NfsServerError` and completes normally on scoped shutdown.

After acquiring the server, keep the serving program in the same scope while it waits.

```ts
const serve = Effect.scoped(Effect.gen(function*() {
  const server = yield* NfsServer.make({ volume, caller })

  yield* server.awaitTermination
}))
```

If you supply a custom `NfsServer` layer or fixture, include an `awaitTermination` effect in its service value.
