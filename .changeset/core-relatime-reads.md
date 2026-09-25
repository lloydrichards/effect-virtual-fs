---
"@effect-vfs/core": minor
---

Reads now follow relatime, the Linux mount default: `readFile`, `readDirectory` and handle reads refresh a node's access time only when it is not newer than its modification or status-change time, or is at least 24 hours old, and never when it already equals the current time. A read that refreshes nothing no longer waits for every other operation, runs beside other reads and, on a live volume, stores nothing, so repeated reads of a durable volume no longer encode and commit the whole image. A change that leaves the volume unchanged, such as a zero-byte write, no longer commits either.

```ts
const program = Effect.gen(function*() {
  const caller = yield* Vfs.Caller

  yield* caller.writeFile("/notes", bytes, { access: "write", create: "exclusive" })
  yield* caller.readFile("/notes") // refreshes atime: it was not newer than mtime
  yield* caller.readFile("/notes") // leaves atime alone and commits nothing
})
```
