import type { Effect, FileSystem, PlatformError, Ref, Scope } from "effect"
import { expectTypeOf } from "vitest"
import * as FileSystemTesting from "../src/FileSystemTesting.js"

type WriteHandler = NonNullable<FileSystemTesting.Handlers["writeFile"]>

type OpenHandler = NonNullable<FileSystemTesting.Handlers["open"]>

expectTypeOf<Parameters<WriteHandler>>().toEqualTypeOf<Parameters<FileSystem.FileSystem["writeFile"]>>()

expectTypeOf<ReturnType<WriteHandler>>().toEqualTypeOf<Effect.Effect<void, PlatformError.PlatformError>>()

expectTypeOf<ReturnType<OpenHandler>>().toEqualTypeOf<Effect.Effect<void, PlatformError.PlatformError, Scope.Scope>>()

// Derived helpers and stream/file-handle handlers are outside the agreed API.
// @ts-expect-error String writes are observed through writeFile.
type StringHandler = FileSystemTesting.Handlers["writeFileString"]

// @ts-expect-error Streams are observed through open.
type StreamHandler = FileSystemTesting.Handlers["stream"]

// @ts-expect-error Watch streams are forwarded without handlers.
type WatchHandler = FileSystemTesting.Handlers["watch"]

expectTypeOf<Effect.Effect<void, string>>().not.toExtend<ReturnType<WriteHandler>>()

expectTypeOf<Effect.Effect<void, never, Scope.Scope>>().not.toExtend<ReturnType<WriteHandler>>()

expectTypeOf<FileSystemTesting.Built<Ref.Ref<number>>["state"]>().toEqualTypeOf<Ref.Ref<number>>()

export type { StreamHandler, StringHandler, WatchHandler }

export const curriedDecorator = <State, E, R>(
  base: FileSystem.FileSystem,
  factory: () => Effect.Effect<FileSystemTesting.Configuration<State>, E, R>
) => FileSystemTesting.make(factory)(base) satisfies Effect.Effect<FileSystemTesting.Built<State>, E, R>
