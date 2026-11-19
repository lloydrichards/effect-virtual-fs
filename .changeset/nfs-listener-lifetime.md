---
"@effect-vfs/nfs": minor
---

Wait for the NFS listener to stop with `server.awaitTermination`. The effect fails with `NfsServerError` if the listener fails and succeeds on scoped shutdown.

Run the effect in the scope that owns the server.

```ts
const serve = Effect.scoped(Effect.gen(function*() {
  const server = yield* NfsServer.make({ volume, caller })

  yield* server.awaitTermination
}))
```

If you supply a custom `NfsServer` layer or fixture, include an `awaitTermination` effect in its service value.
