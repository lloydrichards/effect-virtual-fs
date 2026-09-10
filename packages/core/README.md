# @effect-vfs/core

`@effect-vfs/core` is a runtime-neutral virtual filesystem engine for Effect. It gives you isolated in-memory volumes,
byte-preserving paths, POSIX-inspired permissions, logical quotas, change streams, deterministic fixtures, and portable
encoded snapshots without reading from or writing to the host filesystem.

Use it when filesystem state is part of your domain: sandboxing a tool, modeling several users against one namespace,
testing permission behavior, building repeatable fixtures, or saving and restoring an in-memory workspace. If you need
Effect's standard `FileSystem` service, use [`@effect-vfs/memory`](https://www.npmjs.com/package/@effect-vfs/memory),
which adapts this package to that interface.

The package implements a documented subset of POSIX behavior. It does not claim full POSIX conformance. See the
[implemented profile](https://github.com/lloydrichards/effect-virtual-fs/blob/main/.okf/profiles/implemented-filesystem.md)
for the exact permission, path, timestamp, quota, and atomicity rules.

## Install

```sh
npm install @effect-vfs/core effect@4.0.0-rc.112
```

Version `0.1.0` targets the exact peer version `effect@4.0.0-rc.112`.

## The mental model

The API has three levels:

- A `Volume` owns one isolated namespace and its file contents.
- A `Caller` accesses that volume with its own identity, umask, and current directory.
- File and directory handles are scoped capabilities. Effect closes them when their scope ends.

Callers created from the same volume see the same files. A new volume starts with independent state. This separation
lets you model access by several users without reaching for process globals or the host filesystem.

## Create an isolated workspace

This example creates a bounded workspace, gives an unprivileged caller access to one directory, and uses a scoped file
handle to read the result. It demonstrates the main benefit of the core API: storage, credentials, limits, and resource
lifetime are explicit values that can be composed in one Effect program.

```ts
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Effect } from "effect"

const utf8 = new TextEncoder()

const program = Effect.scoped(Effect.gen(function*() {
  const volume = yield* Vfs.make({
    maxEntries: 100,
    maxBytes: 1_000_000,
    maxFileBytes: 100_000
  })

  const admin = yield* volume.caller()
  yield* admin.mkdir("/workspace", { mode: 0o770 })
  yield* admin.chown("/workspace", { uid: 1000, gid: 1000 })

  const developer = yield* volume.caller({
    identity: { uid: 1000, gid: 1000, groups: [], privileged: false },
    umask: 0o027
  })

  yield* developer.writeFile(
    "/workspace/config.json",
    utf8.encode(JSON.stringify({ feature: "preview" })),
    { access: "write", create: "exclusive", mode: 0o666 }
  )

  const file = yield* developer.open("/workspace/config.json", { access: "read" })
  const contents = yield* file.read(100_000)
  const metadata = yield* file.stat

  return {
    config: JSON.parse(new TextDecoder().decode(contents)),
    mode: metadata.mode.toString(8)
  }
}))

const result = await Effect.runPromise(program)
console.log(result) // { config: { feature: "preview" }, mode: "640" }
```

The root caller is privileged by default. Privilege is explicit: setting `uid` to `0` does not grant it. New root
callers default to umask `0o022`; the developer's `0o027` mask turns the requested file mode `0o666` into `0o640`.

The root package exports `VirtualFileSystem` as a namespace. The equivalent direct module import is
`import * as Vfs from "@effect-vfs/core/VirtualFileSystem"`.

## Preserve path bytes exactly

JavaScript strings cannot represent every filename allowed by a byte-oriented filesystem. `BytePath` keeps arbitrary
non-NUL path bytes intact. This matters when reproducing archives, protocol fixtures, or Unix directory trees that
contain names which are not valid UTF-8.

```ts
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const volume = yield* Vfs.make()
  const fs = yield* volume.caller()

  // Absolute path whose final component is the single byte 0xff.
  const opaquePath = yield* Vfs.pathFromBytes(new Uint8Array([0x2f, 0xff]))
  yield* fs.writeFile(opaquePath, new Uint8Array([1, 2, 3]), {
    access: "write",
    create: "exclusive"
  })

  const names = yield* fs.readDirectoryBytes("/")
  const roundTrip = yield* Vfs.pathToBytes(opaquePath)
  return { names: names.map((name) => Array.from(name)), roundTrip: Array.from(roundTrip) }
})

console.log(await Effect.runPromise(program))
// { names: [[255]], roundTrip: [47, 255] }
```

The constructors and byte-returning operations copy their buffers, so later mutation cannot change stored paths.
String-returning operations fail with `FsError` code `UnrepresentableName` when a name is not valid UTF-8. Use the byte
variants of directory enumeration, symbolic-link targets, and resolved paths when exact bytes matter.

## Build fixtures and restore snapshots

Fixtures make tests deterministic without a setup sequence. Snapshots let you capture that prepared state, serialize
it, and create independent workspaces from the same image. This is useful for test isolation, preview environments, and
resettable sandboxes.

```ts
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Effect } from "effect"

const decodeLimits = {
  maxEncodedBytes: 1_000_000,
  maxRecords: 1_000,
  maxEntries: 1_000,
  maxDecodedBytes: 1_000_000
}

const program = Effect.gen(function*() {
  const template = yield* Vfs.fromFixture({
    entries: [
      { kind: "directory", path: "/project" },
      {
        kind: "file",
        path: "/project/settings.json",
        bytes: new TextEncoder().encode("{\"theme\":\"dark\"}")
      }
    ]
  })

  const encoded = yield* Vfs.encodeSnapshot(yield* template.snapshot)
  const snapshot = yield* Vfs.decodeSnapshot(encoded, decodeLimits)
  const workspaceA = yield* Vfs.fromSnapshot(snapshot)
  const workspaceB = yield* Vfs.fromSnapshot(snapshot)
  const a = yield* workspaceA.caller()
  const b = yield* workspaceB.caller()

  yield* a.writeFile("/project/settings.json", new TextEncoder().encode("{\"theme\":\"light\"}"), {
    access: "write",
    truncate: true
  })

  return new TextDecoder().decode(yield* b.readFile("/project/settings.json"))
})

console.log(await Effect.runPromise(program)) // {"theme":"dark"}
```

Fixture paths must be absolute and unique, and parent directories must be listed explicitly. Fixtures can also contain
symbolic links, metadata, and forward hard links.

Snapshot decoding requires explicit work limits because encoded bytes may come from an untrusted source. A snapshot
contains the reachable namespace and metadata. It excludes callers, open handles, cursor positions, watch
subscriptions, and unlinked content. Each restored volume is independent.

## Use scoped handles for incremental I/O

Whole-file operations are convenient, but handles give each open file an independent `bigint` cursor and support
incremental reads, positional I/O, seeking, and truncation. `Effect.scoped` guarantees cleanup on success, failure, or
interruption.

```ts
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Effect } from "effect"

const program = Effect.scoped(Effect.gen(function*() {
  const fs = yield* (yield* Vfs.make()).caller()
  yield* fs.writeFile("/events.log", new TextEncoder().encode("one\ntwo\n"), {
    access: "write",
    create: "exclusive"
  })

  const file = yield* fs.open("/events.log", { access: "read" })
  const first = yield* file.read(4) // Advances this handle's cursor.
  const second = yield* file.read(4)
  const preview = yield* file.pread(3, 0n) // Does not move the cursor.

  return [first, second, preview].map((bytes) => new TextDecoder().decode(bytes))
}))

console.log(await Effect.runPromise(program)) // ["one\n", "two\n", "one"]
```

Handles also expose an explicit `close` effect when early release matters. Calling explicit close twice fails, while
scope cleanup remains safe after an explicit close.

## Handle expected failures as data

Filesystem failures are typed `FsError` values with a stable `code`, `operation`, and optional `path`. Configuration
and snapshot failures use `ConfigurationError` and `ImageError`. Interruption and defects remain separate from these
expected failures.

```ts
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const fs = yield* (yield* Vfs.make()).caller()

  return yield* fs.readFile("/optional.json").pipe(
    Effect.catchTag("FsError", (error) =>
      error.code === "NotFound"
        ? Effect.succeed(new TextEncoder().encode("{}"))
        : Effect.fail(error))
  )
})

const bytes = await Effect.runPromise(program)
console.log(new TextDecoder().decode(bytes)) // {}
```

## Provide a caller as an Effect service

`CurrentFileSystem` is an optional service for application code that should receive an existing caller through its
Effect environment. The service owns no storage; the provided caller keeps its original volume, identity, umask, and
current directory.

```ts
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Effect } from "effect"

const loadConfig = Effect.gen(function*() {
  const fs = yield* Vfs.CurrentFileSystem
  return yield* fs.readFile("/app/config.json")
})

const program = Effect.gen(function*() {
  const fs = yield* (yield* Vfs.make()).caller()
  yield* fs.mkdir("/app")
  yield* fs.writeFile("/app/config.json", new TextEncoder().encode("{}"), {
    access: "write",
    create: "exclusive"
  })
  return yield* loadConfig.pipe(Effect.provideService(Vfs.CurrentFileSystem, fs))
})

const bytes = await Effect.runPromise(program)
console.log(new TextDecoder().decode(bytes)) // {}
```

## When to use core or memory

Choose `@effect-vfs/core` when you need direct access to volumes, callers, credentials, byte paths, quotas, watches,
fixtures, or snapshots. Choose `@effect-vfs/memory` when existing code expects Effect's `FileSystem` service and you
want an in-memory implementation. The memory adapter is built on this core, so you can create a core volume and bind
the adapter to it when you need both interfaces.

## Compatibility and behavioral limits

This package is experimental. Its public API may change between minor releases while Effect v4 remains a release
candidate.

- Components are limited to 255 bytes. Symbolic-link traversal is limited to 40 links.
- Omitted logical quotas are unbounded by configuration, apart from fixed file and component bounds.
- Absolute paths ignore a supplied directory base. Relative paths can use a live, same-volume directory handle.
- Operations coordinate through one permit per volume. Interruption while waiting makes no change; interruption after
  a commit does not roll it back.
- Watch streams contain byte paths and report future committed creates, updates, and removals without replay.
- `sync` checks handle liveness. An in-memory volume provides no host or crash durability.

For the complete contract, read the
[implemented profile](https://github.com/lloydrichards/effect-virtual-fs/blob/main/.okf/profiles/implemented-filesystem.md).
