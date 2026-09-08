# @effect-vfs/memory

An experimental, in-memory implementation of Effect's `FileSystem` service. It provides files, directories,
symbolic links, hard links, scoped file handles, temporary resources, globbing, and watch streams without accessing
the host filesystem.

## Install

```sh
bun add -d @effect-vfs/memory effect
```

The first release is tested against `effect@4.0.0-rc.112` and keeps that exact peer dependency while Effect v4 is a
release candidate.

## Usage

```ts
import { MemoryFileSystem } from "@effect-vfs/memory"
import { Effect, FileSystem } from "effect"

const program = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  yield* fileSystem.writeFileString("/message.txt", "hello")
  return yield* fileSystem.readFileString("/message.txt")
})

const result = program.pipe(Effect.provide(MemoryFileSystem.layer))
```

Use `MemoryFileSystem.make` when you need the service value directly. Each construction creates a fresh volume.
Layer memoization can share one constructed volume inside a layer graph, so use `Layer.fresh` when a consumer needs
an explicitly isolated instance.

## Scope

This package implements Effect's existing `FileSystem` interface. It does not intercept `node:fs`, child processes,
or native filesystem access. Relative paths resolve from virtual `/`, not the host process working directory.

The package is runtime-neutral and ESM-only. It has no Node or Bun runtime dependency.

## Status

The package is experimental. Its initial interface follows Effect PR #6573. The future `@effect-vfs/core` package
will define a standalone virtual filesystem with an explicit POSIX profile; `@effect-vfs/memory` will remain the
Effect compatibility adapter.

## Credits

The implementation was developed for [Effect PR #6573](https://github.com/Effect-TS/effect/pull/6573), based on
earlier work in [effect-smol PR #456](https://github.com/Effect-TS/effect-smol/pull/456). The portable contract suite
comes from [Effect PR #6555](https://github.com/Effect-TS/effect/pull/6555).

The project is available under the MIT License.
