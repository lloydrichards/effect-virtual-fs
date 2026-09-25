---
"@effect-vfs/core": minor
---

`Caller` gains three tree operations. `walk(directory, options?)` streams every entry below a directory as a `WalkEntry` (relative path, name, reference, listing directory, kind, depth), depth first and in the byte order of each directory's names, reading one directory at a time with no handle and no access-time refresh and reaching each by name, so it needs search permission on the directories above it; symbolic links are reported, never followed, and `maxDepth`, `maxEntries` and `maxBytes` fail with `LimitExceeded` when passed. `mkdir(path, { recursive: true })` creates every missing directory in one change, so a failure creates none. `remove(entry, { recursive, force })` empties a directory entry by entry, each by name, stops at the first failure with its path, and with `force` forgives only the target itself going missing. `remove` on a path with a trailing slash to a file now fails `NotDirectory`.

```ts
const program = Effect.gen(function*() {
  const caller = yield* Vfs.Caller

  yield* caller.mkdir("/work/src/lib", { recursive: true })

  const paths = yield* Stream.runCollect(
    Stream.mapEffect(caller.walk("/work"), (entry) => BytePath.toString(entry.path))
  )
  // [ 'src', 'src/lib' ]

  yield* caller.remove("/work", { recursive: true })
})
```
